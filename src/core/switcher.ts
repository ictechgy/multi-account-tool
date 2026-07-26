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
import { assertNoEnvSecretSources } from './env-secret-source.js';
import { UnknownCliError } from './errors.js';
import { inspectLiveFreshness, type FreshnessReport } from './freshness.js';
import { buildProfileIdentity, type IdentitySourceInput } from './profile-identity.js';
import {
  createProfile,
  commitProfileCaptureTransaction,
  deleteProfile,
  discardStagedFile,
  profileExists,
  removeProfileFile,
  readProfileFile,
  readMeta,
  readProfileMetaRaw,
  recoverProfileCaptureTransaction,
  touchProfile,
  stageProfileFile,
  writeProfileMetaRaw,
  writeProfileFile
} from './profile-store.js';
import { readSource, removeSource, writeSource } from './sources.js';
import type { CliDef, Source } from './types.js';
import { assertValidSourceList } from './validators.js';

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
  assertValidSourceList(def.sources);
  assertNoEnvSecretSources(def.sources, 'snapshot');
  const profileWasPresent = await profileExists(cliId, profileName);
  if (profileWasPresent) await recoverProfileCaptureTransaction(cliId, profileName);
  const captured: string[] = [];
  const empty: string[] = [];
  const identitySources: IdentitySourceInput[] = [];
  const values: Array<{ src: Source; value: string | null }> = [];
  // Read/preflight every source before any profile mutation.
  for (const src of def.sources) {
    // 이 루프는 프로필을 만들기 전에 돌기 때문에(mutation 없음) 실패는 그대로 전파되지만,
    // 하드닝 sentinel 은 경로를 지운 상태라 어느 아티팩트가 막혔는지 알 수 없다. saveAs 를
    // 붙여 귀속시킨다 — saveAs 는 doctor/switch 출력에 이미 노출되는 비밀 아닌 값이다.
    //
    // 단 **원본 에러 객체를 교체하지 않는다**:
    //  - `new Error(...)` 로 감싸면 `err.code` 와 `KeychainAccountMissingError.service` 같은
    //    커스텀 필드가 사라져 그 필드로 분기하는 호출자가 깨진다.
    //  - 메시지 **앞**에 무엇이든 붙이면 `errorText`(`^` 앵커)와 `providerPublicError`
    //    (`^…$` 완전 앵커)의 sentinel 매칭이 깨져 공개 문구가 `operation failed` 로 붕괴한다.
    // 따라서 원본을 그대로 재throw 하고 귀속은 **접미어**로만 덧붙인다.
    const value = await readSource(src).catch((err: unknown) => {
      if (err instanceof Error) err.message = `${err.message} (${src.saveAs}; 'mat doctor' 로 확인)`;
      throw err;
    });
    values.push({ src, value });
    if (value == null) {
      empty.push(src.saveAs);
      const stored = await readProfileFile(cliId, profileName, src.saveAs);
      identitySources.push({
        saveAs: src.saveAs,
        value: stored,
        state: stored == null ? 'missing' : 'carried-forward'
      });
      continue;
    }
    captured.push(src.saveAs);
    identitySources.push({ saveAs: src.saveAs, value, state: 'captured' });
  }
  // Creating a profile itself is a mutation, so it occurs only after every
  // selected live source has been safely read/preflighted.
  if (!profileWasPresent) await createProfile(cliId, profileName);
  const prior = await Promise.all(values.filter(({ value }) => value != null).map(async ({ src }) => ({ src, value: await readProfileFile(cliId, profileName, src.saveAs) })));
  const priorMeta = await readProfileMetaRaw(cliId, profileName);
  const staged: Array<{ src: Source; path: string }> = [];
  try {
    for (const { src, value } of values) if (value != null) staged.push({ src, path: await stageProfileFile(cliId, profileName, src.saveAs, value) });
    const meta = await readMeta(cliId, profileName);
    if (!meta) throw new Error('profile metadata missing during capture');
    meta.updatedAt = new Date().toISOString();
    meta.identity = buildProfileIdentity({ cliId, capturedAt: new Date(meta.updatedAt), sources: identitySources });
    const metaStage = await stageProfileFile(cliId, profileName, 'meta.json', JSON.stringify(meta, null, 2));
    await commitProfileCaptureTransaction(cliId, profileName, [
      ...staged.map(item => ({ fileName: item.src.saveAs, stagingPath: item.path })),
      { fileName: 'meta.json', stagingPath: metaStage }
    ]);
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const { path } of staged) {
      try { await discardStagedFile(path); } catch (rollbackErr) { rollbackErrors.push(errorText(rollbackErr)); }
    }
    for (const { src, value } of prior) {
      try {
        if (value == null) await removeProfileFile(cliId, profileName, src.saveAs);
        else await writeProfileFile(cliId, profileName, src.saveAs, value);
      } catch (rollbackErr) { rollbackErrors.push(errorText(rollbackErr)); }
    }
    try {
      if (!profileWasPresent) await deleteProfile(cliId, profileName);
      else if (priorMeta == null) await removeProfileFile(cliId, profileName, 'meta.json');
      else await writeProfileMetaRaw(cliId, profileName, priorMeta);
    } catch (rollbackErr) { rollbackErrors.push(errorText(rollbackErr)); }
    if (rollbackErrors.length) throw new Error(`snapshot failed; rollback also failed: ${rollbackErrors.join('; ')}`);
    const code = errorCode(err);
    throw new Error(`snapshot failed${code ? ` (${code})` : ''}`);
  }
  return { cliId, profileName, captured, empty };
}

export interface RestoreResult {
  cliId: string;
  profileName: string;
  /** 라이브 위치로 복원된 source 의 saveAs 명 */
  restored: string[];
  /** 프로필에 저장된 파일이 없어 건너뛴 source 의 saveAs 명 */
  missing: string[];
  /**
   * `missing` 중에서도 **라이브에 값이 남아 있는** source 의 saveAs 명 (`carriedOver ⊆ missing`).
   *
   * 프로필에 없으면 restore 는 라이브 파일을 건드리지 않는다(의도된 설계 — 프로필이 캡처하지
   * 않은 자격증명을 mat 이 삭제하면 데이터 손실 위험이 크다). 그 결과 **직전 계정의 자격증명이
   * 그대로 활성 상태로 남는다.** `missing` 만으로는 "그냥 없어서 건너뜀"과 구별되지 않으므로
   * 별도 필드로 노출한다. 특히 소스 집합이 확장된 직후(예: 0.8.1 의 Goose provider 캐시 정정)
   * 기존 프로필은 새 아티팩트를 갖고 있지 않아 이 상태가 정상적으로 발생한다.
   *
   * **복구 순서가 중요하다**: 이 필드가 채워진 직후에 방금 전환한 프로필을 재캡처하면 안 된다 —
   * 그 시점의 라이브 값은 *직전* 계정 것이므로 다른 계정 자격증명을 이 프로필에 저장하게 된다.
   * 올바른 조치는 해당 계정으로 다시 로그인해 아티팩트를 새로 만드는 것이고, 라이브 값이 다른
   * 프로필 것이면 그 프로필을 먼저 재캡처하는 것이다. 사용자 대면 문구는 `formatSwitchResult`
   * 가 소유하며 README/CHANGELOG/support 의 안내와 같은 순서 조건을 공유해야 한다.
   *
   * 전환 자체를 fail-closed 로 막지는 않는다 — 그러면 소스 집합을 확장할 때마다 기존 모든
   * 프로필이 전환 불가가 되는 자체 유발 denial-of-switch 가 된다. 격리 원칙이 금지하는 것은
   * **조용한** 저하이므로, 구조적 필드 + 구분된 경고로 비침묵성과 귀속성을 확보한다.
   */
  carriedOver: string[];
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
  assertValidSourceList(def.sources);
  assertNoEnvSecretSources(def.sources, 'restore');
  if (!(await profileExists(cliId, profileName))) {
    throw new Error(`프로필을 찾을 수 없습니다: ${cliId}/${profileName}`);
  }
  const restored: string[] = [];
  const missing: string[] = [];
  const carriedOver: string[] = [];

  const plan = await collectRestorePlan(def, cliId, profileName, missing, carriedOver);
  await applyRestorePlan(plan, restored);

  return { cliId, profileName, restored, missing, carriedOver };
}

/** 복원 전 preflight: 모든 source 의 stored + 현재 라이브 값을 메모리에 수집. */
async function collectRestorePlan(
  def: CliDef,
  cliId: string,
  profileName: string,
  missing: string[],
  carriedOver: string[]
): Promise<RestorePlan[]> {
  const plan: RestorePlan[] = [];
  for (const src of def.sources) {
    const stored = await readProfileFile(cliId, profileName, src.saveAs);
    // Always inspect the live source. A profile omission must not hide an
    // unsafe present directory/file from the restore preflight.
    const liveBackup = await readSource(src);
    if (stored == null) {
      missing.push(src.saveAs);
      // 프로필에는 없는데 라이브에는 값이 있다 → 직전 계정 자격증명이 활성 상태로 남는다.
      // liveBackup 은 위에서 이미 무조건 계산하므로 추가 I/O 가 없다.
      if (liveBackup != null) carriedOver.push(src.saveAs);
      plan.push({ src, stored: null, liveBackup });
      continue;
    }
    plan.push({ src, stored, liveBackup });
  }
  return plan;
}

/** plan 을 순차 적용. 한 source 실패 시 이미 적용된 source 롤백 후 원본 에러 throw. */
async function applyRestorePlan(plan: RestorePlan[], restored: string[]): Promise<void> {
  const appliedIdx: number[] = [];
  let currentIdx: number | undefined;
  try {
    for (let i = 0; i < plan.length; i++) {
      const { src, stored } = plan[i];
      if (stored == null) continue;
      currentIdx = i;
      await writeSource(src, stored);
      restored.push(src.saveAs);
      appliedIdx.push(i);
      currentIdx = undefined;
    }
  } catch (err) {
    const rollbackErrors: string[] = [];
    const rollbackIdx = [...(currentIdx === undefined ? [] : [currentIdx]), ...appliedIdx.reverse()];
    for (const i of rollbackIdx) {
      const { src, liveBackup } = plan[i];
      try {
        if (liveBackup == null) await removeSource(src);
        else await writeSource(src, liveBackup);
      } catch (rollbackErr) {
        rollbackErrors.push(errorText(rollbackErr));
      }
    }
    if (rollbackErrors.length) throw new Error(`restore failed; rollback also failed: ${rollbackErrors.join('; ')}`);
    throw err;
  }
}

function errorText(err: unknown): string {
  // `unsafe Goose provider cache …` 계열을 반드시 포함할 것 — 이 sentinel 들은 `unsafe ` 로
  // 시작하므로 `unsafe directory source:` 대안에 걸리지 않아, 누락되면 롤백 집계에서
  // `operation failed` 로 붕괴해 어떤 하드닝 검사가 실패했는지 알 수 없게 된다.
  // (`providerPublicError` 의 whitelist 는 이미 이 계열을 원문 통과시킨다 — 그쪽과 대칭을 맞춘다.)
  if (err instanceof Error && /^(?:unsafe directory source:|unsafe Goose provider cache |Goose provider cache |profile capture )/.test(err.message)) return err.message;
  const code = errorCode(err);
  return `operation failed${code ? ` (${code})` : ''}`;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
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
  const def = mustFindCli(cliId);
  assertNoEnvSecretSources(def.sources, 'switch');
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
  // quad-review HIGH fix (#2): current === toProfile 일 때는 no-op.
  // skipPreSwapSnapshot 이 true 면 restore 가 라이브를 동일 stored 로 덮어쓰면서
  // 사용자가 의도하지 않은 라이브 회전 토큰까지 실수로 폐기될 수 있다 (public API
  // 데이터 손실). TUI 는 onSwitchAction 에서 차단하지만 API contract 가 안전해야
  // mat exec / 외부 호출자도 동일 보호 받는다. snapshotLiveToProfile / restore /
  // setActive 모두 skip 하고 즉시 idempotent 반환.
  //
  // 단, active 포인터가 외부 삭제된 profile 을 가리키는 zombie 상태면 no-op 으로
  // 성공을 보고하지 않는다. 기존 restoreProfileToLiveUnlocked 의 missing-profile
  // guard 로 fall through 해 깨진 상태를 surface 한다.
  if (current != null && current === toProfile && (await profileExists(cliId, toProfile))) {
    // 이 경로는 restore 를 **실행하지 않는** idempotent no-op 이므로 세 배열이 모두 비어 있다.
    // `carriedOver: []` 는 "이월이 없다" 는 보증이 아니라 "이번 호출이 아무것도 복원하지 않아
    // 평가 대상이 없다" 는 뜻이다 — 이미 활성인 프로필을 다시 선택했을 때 라이브에 남아 있는
    // 아티팩트를 이 필드로 판단하면 안 된다. 라이브 대 프로필 실제 상태는 `mat doctor` 와
    // `mat freshness` 가 권위 있는 채널이다.
    return {
      fromSnapshot: undefined,
      restore: { cliId, profileName: toProfile, restored: [], missing: [], carriedOver: [] },
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
