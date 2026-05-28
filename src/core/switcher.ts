/**
 * 프로필 전환의 핵심 로직.
 *
 * 안전 시퀀스 (switchProfile):
 *   1) 현재 활성 프로필로 라이브 자격증명 자동 스냅샷 (데이터 손실 방지)
 *   2) 새 프로필을 라이브 위치로 복원 (부분 실패 시 백업으로 롤백)
 *   3) 활성 포인터 갱신 + updatedAt
 *
 * Multi-source CLI 의 부분 실패 보호 (restoreProfileToLive):
 *  - preflight 로 모든 source 의 stored + 현재 라이브를 메모리에 수집
 *  - 순차 적용 중 한 source 실패 시 이미 적용된 source 들을 라이브 백업으로 원복
 *  - 결과: 라이브가 "절반은 새 프로필 / 절반은 옛 프로필" 인 split-state 방지
 */

import { findCliDef } from './cli-defs.js';
import { getActiveProfile, setActiveProfile } from './config.js';
import { UnknownCliError } from './errors.js';
import { inspectLiveFreshness, type FreshnessReport } from './freshness.js';
import {
  createProfile,
  profileExists,
  readProfileFile,
  touchProfile,
  writeProfileFile
} from './profile-store.js';
import { readSource, writeSource } from './sources.js';
import type { CliDef, Source } from './types.js';

export interface SnapshotResult {
  cliId: string;
  profileName: string;
  /** 캡처되어 프로필 디렉토리에 저장된 source 의 saveAs 명 */
  captured: string[];
  /** 라이브 값이 없어 캡처되지 않은 source 의 saveAs 명 */
  empty: string[];
}

/**
 * 라이브 자격증명을 특정 프로필로 캡처 (덮어쓰기).
 * 프로필이 없으면 자동 생성한다.
 */
export async function snapshotLiveToProfile(
  cliId: string,
  profileName: string
): Promise<SnapshotResult> {
  const def = mustFindCli(cliId);
  if (!(await profileExists(cliId, profileName))) {
    await createProfile(cliId, profileName);
  }
  const captured: string[] = [];
  const empty: string[] = [];
  for (const src of def.sources) {
    const value = await readSource(src);
    if (value == null) {
      empty.push(src.saveAs);
      continue;
    }
    await writeProfileFile(cliId, profileName, src.saveAs, value);
    captured.push(src.saveAs);
  }
  await touchProfile(cliId, profileName);
  return { cliId, profileName, captured, empty };
}

export interface RestoreResult {
  cliId: string;
  profileName: string;
  /** 라이브 위치로 복원된 source 의 saveAs 명 */
  restored: string[];
  /** 프로필에 저장된 파일이 없어 건너뛴 source 의 saveAs 명 */
  missing: string[];
}

/** 복원 plan: source 별 stored (프로필) + liveBackup (롤백용 라이브 백업) */
interface RestorePlan {
  src: Source;
  stored: string | null;
  liveBackup: string | null;
}

/**
 * 프로필에 저장된 자격증명을 라이브 위치로 복원.
 * 부분 실패 시 이미 적용된 source 들을 라이브 백업으로 원복 (best-effort).
 */
export async function restoreProfileToLive(
  cliId: string,
  profileName: string
): Promise<RestoreResult> {
  const def = mustFindCli(cliId);
  if (!(await profileExists(cliId, profileName))) {
    throw new Error(`프로필을 찾을 수 없습니다: ${cliId}/${profileName}`);
  }
  const restored: string[] = [];
  const missing: string[] = [];

  const plan = await collectRestorePlan(def, cliId, profileName, missing);
  await applyRestorePlan(plan, restored);

  return { cliId, profileName, restored, missing };
}

/** 복원 전 preflight: 모든 source 의 stored + 현재 라이브 값을 메모리에 수집. */
async function collectRestorePlan(
  def: CliDef,
  cliId: string,
  profileName: string,
  missing: string[]
): Promise<RestorePlan[]> {
  const plan: RestorePlan[] = [];
  for (const src of def.sources) {
    const stored = await readProfileFile(cliId, profileName, src.saveAs);
    if (stored == null) {
      missing.push(src.saveAs);
      plan.push({ src, stored: null, liveBackup: null });
      continue;
    }
    const liveBackup = await readSource(src);
    plan.push({ src, stored, liveBackup });
  }
  return plan;
}

/** plan 을 순차 적용. 한 source 실패 시 이미 적용된 source 롤백 후 원본 에러 throw. */
async function applyRestorePlan(plan: RestorePlan[], restored: string[]): Promise<void> {
  const appliedIdx: number[] = [];
  try {
    for (let i = 0; i < plan.length; i++) {
      const { src, stored } = plan[i];
      if (stored == null) continue;
      await writeSource(src, stored);
      restored.push(src.saveAs);
      appliedIdx.push(i);
    }
  } catch (err) {
    for (const i of appliedIdx.reverse()) {
      const { src, liveBackup } = plan[i];
      if (liveBackup == null) continue;
      await writeSource(src, liveBackup).catch(() => { /* best-effort */ });
    }
    throw err;
  }
}

export interface SwitchResult {
  /** 전환 직전 현재 활성 프로필로 자동 백업한 결과 (없을 수 있음) */
  fromSnapshot?: SnapshotResult;
  /** 새 프로필로의 복원 결과 */
  restore: RestoreResult;
  /**
   * swap 직전 활성 프로필의 라이브 vs 저장본 비교 결과 (info-only).
   *
   * 활성 프로필이 있고 toProfile 과 다를 때만 보고된다. mat 자체는 본 정보를
   * 동작에 사용하지 않음 — TUI/CLI 호출자가 OAuth refresh rotation 등으로 인한
   * stale 상태를 사용자에게 안내하기 위한 surface. dialog/액션은 후속 PR.
   *
   * inspect 가 예외를 던지면 swap 자체를 막지 않고 본 필드만 누락된다 (swap 의
   * atomic 보장은 유지). 호출자가 freshness 부재를 "정보 없음" 으로 해석.
   */
  preSwapLiveFreshness?: FreshnessReport;
}

/**
 * 안전한 프로필 전환:
 *  1) 기존 활성 프로필이 있다면 라이브 → 그 프로필로 캡처
 *  2) 대상 프로필을 라이브 위치로 복원 (부분 실패 롤백 포함)
 *  3) 활성 포인터 업데이트
 *
 * 활성 프로필이 있고 toProfile 과 다를 때 swap 직전 freshness inspect 결과를
 * 보고 (info-only — PR-F*). inspect 실패는 swap 을 중단시키지 않는다.
 */
export async function switchProfile(
  cliId: string,
  toProfile: string
): Promise<SwitchResult> {
  const current = await getActiveProfile(cliId);
  let fromSnapshot: SnapshotResult | undefined;
  let preSwapLiveFreshness: FreshnessReport | undefined;
  const shouldSnapshot =
    current != null && current !== toProfile && (await profileExists(cliId, current));
  // 활성 포인터가 가리키는 프로필 디렉토리가 외부에서 삭제됐을 경우 좀비 부활 방지:
  // snapshotLiveToProfile 의 auto-create 를 건너뛰고 restore 만 진행한다.
  if (shouldSnapshot && current != null) {
    // freshness inspect 와 직후 snapshot 은 라이브를 별도 2회 read. 두 read 사이에
    // CLI 가 rotation 하면 보고는 시점 t1 의 상태, snapshot 은 t2 의 갱신본 ⇒
    // 결과 불일치 가능. info-only PR-F* 의 의미상 race 는 알려진 한계 — 정합성 보장은
    // PR-I* 의 LockBody 일관화 후 보강 예정 (plan Scenario 4).
    preSwapLiveFreshness = await safeInspectFreshness(cliId, current);
    fromSnapshot = await snapshotLiveToProfile(cliId, current);
  }
  const restore = await restoreProfileToLive(cliId, toProfile);
  await setActiveProfile(cliId, toProfile);
  await touchProfile(cliId, toProfile);
  return { fromSnapshot, restore, preSwapLiveFreshness };
}

/**
 * freshness inspect 의 예외는 swap 을 막지 않도록 swallow — 호출자가 absence 로 해석.
 *
 * 단, silent 실패는 사용자가 인지하기 어려우므로 stderr 에 한 줄 경고 surface
 * (quad-review MED fix). `preSwapLiveFreshness === undefined` 가 "검사 안 함
 * (current 없음)" vs "검사 실패" 두 의미를 가지는데, 후자만 stderr 출력으로 구분.
 */
async function safeInspectFreshness(
  cliId: string,
  profileName: string
): Promise<FreshnessReport | undefined> {
  try {
    return await inspectLiveFreshness(cliId, profileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[mat] freshness 검사 실패 (swap 진행됨): cli=${cliId} profile=${profileName}: ${msg}\n`
    );
    return undefined;
  }
}

function mustFindCli(cliId: string): CliDef {
  const def = findCliDef(cliId);
  // UnknownCliError 일원화 — generic Error 대신 typed throw (quad-review iter 2 LOW fix).
  // exec / TUI 등 호출자가 instanceof 분기로 exit 2 매핑 가능.
  if (!def) throw new UnknownCliError(cliId);
  return def;
}
