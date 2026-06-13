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
import { withCliMutationLock } from './cli-mutation-lock.js';
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
  mustFindCli(cliId);
  return withCliMutationLock(
    { cliId, profileName, execMode: 'foreground', affectsCliIds: [cliId] },
    () => snapshotLiveToProfileUnlocked(cliId, profileName)
  );
}

async function snapshotLiveToProfileUnlocked(
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
  mustFindCli(cliId);
  return withCliMutationLock(
    { cliId, profileName, execMode: 'foreground', affectsCliIds: [cliId] },
    () => restoreProfileToLiveUnlocked(cliId, profileName)
  );
}

async function restoreProfileToLiveUnlocked(
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
   * stale 상태를 사용자에게 안내하기 위한 surface. dialog/액션은 PR-G.
   *
   * inspect 가 예외를 던지면 swap 자체를 막지 않고 본 필드만 누락된다 (swap 의
   * atomic 보장은 유지). 호출자가 freshness 부재를 "정보 없음" 으로 해석.
   *
   * `skipPreSwapSnapshot: true` 호출 (PR-G 폐기 path) 의 경우 본 필드도 누락된다 —
   * 사용자가 이미 freshness 결과를 보고 폐기 결정한 직후이므로 재보고 불필요.
   */
  preSwapLiveFreshness?: FreshnessReport;
}

/**
 * `switchProfile` 의 동작 옵션.
 *
 * PR-G 의 TUI dialog 가 "폐기" (라이브 무시 + active 그대로 복원) 선택을 표현하기
 * 위해 도입. mat exec 등 기존 호출자는 옵션 미지정으로 backward-compat (자동 snapshot).
 */
export interface SwitchOptions {
  /**
   * 전환 직전 현재 활성 프로필로의 자동 snapshot 을 건너뛴다. 결과적으로 라이브
   * 자격증명 (refresh rotation 이 일어났다면 새 토큰을 포함) 은 어디에도 저장되지
   * 않고 toProfile 의 저장본으로 덮어써진다.
   *
   * 사용자에게 의도된 데이터 손실 — `mat freshness` 의 rotated 보고를 보고도 명시
   * 폐기를 선택한 경우에만 사용. 일반 swap 은 반드시 자동 snapshot 을 보존.
   */
  skipPreSwapSnapshot?: boolean;
}

/**
 * 안전한 프로필 전환:
 *  1) 기존 활성 프로필이 있다면 라이브 → 그 프로필로 캡처
 *  2) 대상 프로필을 라이브 위치로 복원 (부분 실패 롤백 포함)
 *  3) 활성 포인터 업데이트
 *
 * 활성 프로필이 있고 toProfile 과 다를 때 swap 직전 freshness inspect 결과를
 * 보고 (info-only — PR-F*). inspect 실패는 swap 을 중단시키지 않는다.
 *
 * `options.skipPreSwapSnapshot === true` (PR-G 폐기 path) 면 1) 단계 전체 (snapshot
 * 및 freshness inspect) 를 생략하고 곧장 restore + setActive 로 진행. 라이브가
 * 덮어써져 사라지는 의도된 mutation.
 */
export async function switchProfile(
  cliId: string,
  toProfile: string,
  options?: SwitchOptions
): Promise<SwitchResult> {
  mustFindCli(cliId);
  return withCliMutationLock(
    { cliId, profileName: toProfile, execMode: 'foreground', affectsCliIds: [cliId] },
    () => switchProfileUnlocked(cliId, toProfile, options)
  );
}

async function switchProfileUnlocked(
  cliId: string,
  toProfile: string,
  options?: SwitchOptions
): Promise<SwitchResult> {
  const current = await getActiveProfile(cliId);
  // quad-review HIGH fix (#2): current === toProfile 일 때 무조건 no-op.
  // skipPreSwapSnapshot 이 true 면 restore 가 라이브를 동일 stored 로 덮어쓰면서
  // 사용자가 의도하지 않은 라이브 회전 토큰까지 실수로 폐기될 수 있다 (public API
  // 데이터 손실). TUI 는 onSwitchAction 에서 차단하지만 API contract 가 안전해야
  // mat exec / 외부 호출자도 동일 보호 받는다. snapshotLiveToProfile / restore /
  // setActive 모두 skip 하고 즉시 idempotent 반환.
  if (current != null && current === toProfile) {
    return {
      fromSnapshot: undefined,
      restore: { cliId, profileName: toProfile, restored: [], missing: [] },
      preSwapLiveFreshness: undefined
    };
  }
  let fromSnapshot: SnapshotResult | undefined;
  let preSwapLiveFreshness: FreshnessReport | undefined;
  const skipSnapshot = options?.skipPreSwapSnapshot === true;
  const shouldSnapshot =
    !skipSnapshot &&
    current != null &&
    (await profileExists(cliId, current));
  // 활성 포인터가 가리키는 프로필 디렉토리가 외부에서 삭제됐을 경우 좀비 부활 방지:
  // snapshotLiveToProfile 의 auto-create 를 건너뛰고 restore 만 진행한다.
  if (shouldSnapshot && current != null) {
    // freshness inspect 와 직후 snapshot 은 라이브를 별도 2회 read. 두 read 사이에
    // CLI 가 rotation 하면 보고는 시점 t1 의 상태, snapshot 은 t2 의 갱신본 ⇒
    // 결과 불일치 가능. info-only PR-F* 의 의미상 race 는 알려진 한계 — 정합성 보장은
    // PR-I* 의 LockBody 일관화 후 보강 예정 (plan Scenario 4).
    preSwapLiveFreshness = await safeInspectFreshness(cliId, current);
    fromSnapshot = await snapshotLiveToProfileUnlocked(cliId, current);
  }
  const restore = await restoreProfileToLiveUnlocked(cliId, toProfile);
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
