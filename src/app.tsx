/**
 * 메인 앱: 화면 스택 + 액션 디스패치.
 *
 * 화면 네비게이션 규칙:
 *  - push: 새 화면을 스택에 쌓는다 (profile 화면 → confirm 등).
 *  - replace: 마지막 화면을 새 화면으로 교체 (confirm → busy → message).
 *  - pop: 스택 최상단 제거. 스택이 비게 될 경우 home 으로 fallback.
 *  - home: 명시적 home navigation (스택 전체 리셋).
 *
 * 액션 DRY: 모든 async 핸들러는 runBusyAction 헬퍼를 통해
 * busy → work → refresh → success/error message 흐름을 일관 처리.
 *
 * 초기 부트:
 *  1) .tmp 잔존물 정리 (cleanupTmpFiles)
 *  2) 데이터 병렬 로드 (loadAllData → Promise.all)
 *  3) firstImportPromptShown=false 이고 hasAnyLiveCredential 가 있는 CLI 가
 *     있으면 firstImport 화면 (사용자가 결정한 뒤 markFirstImportPromptShown).
 */

import React, { useEffect, useReducer, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';

import { detectAmbientWarnings, formatAmbientWarnings } from './core/ambient.js';
import { findCliDef, getAllCliDefs } from './core/cli-defs.js';
import { withCliMutationLock } from './core/cli-mutation-lock.js';
import {
  cleanupTmpFiles,
  getActiveProfile,
  loadConfig,
  markFirstFreshnessPromptShown,
  markFirstImportPromptShown,
  setActiveProfile
} from './core/config.js';
import { detectAll } from './core/detector.js';
import { describeError, errorMessage } from './core/errors.js';
import {
  EMPTY_DATA,
  initialState,
  reducer,
  topOf,
  type Action,
  type AppData,
  type FirstImportExpectedState,
  type MessageTone,
  type Screen,
  type State
} from './app/state.js';
import {
  formatCaptureWarning,
  formatFirstImportBody,
  formatFirstImportSummary,
  formatSwitchConfirmBody,
  formatSwitchResult,
  importTitle,
  importTone,
  type FirstImportSummary
} from './app/formatters.js';
import { validateNewName, validateRenameTo } from './app/validators.js';
import { appendAppLogBestEffort } from './app/log.js';
import {
  hasInflight,
  inspectLiveFreshness,
  needsUserAttention,
  type FreshnessReport
} from './core/freshness.js';
import {
  deleteProfile,
  listProfiles,
  readMeta,
  renameProfile,
  validateProfileName
} from './core/profile-store.js';
import {
  snapshotLiveToProfile,
  switchProfile,
  type SnapshotResult,
  type SwitchResult
} from './core/switcher.js';
import type { CliDef, Profile } from './core/types.js';
import { Busy, Confirm, Header, Message, TextPrompt } from './ui/widgets.js';
import { FreshnessDialog, HomeScreen, ProfilesScreen, type CliRow, type ProfileItem } from './ui/screens.js';

// --- 화면 타입 ---

// 화면 스택 / reducer / AppData / Action / EMPTY_DATA 정의는 src/app/state.ts 로 분리 (PR-O).

// --- 앱 컴포넌트 ---

export default function App() {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const initializedRef = useRef(false);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
  });

  const screen = topOf(state);

  useEffect(() => {
    if (screen.kind !== 'loading' || initializedRef.current) return;
    initializedRef.current = true;
    void initialize(dispatch);
  }, [screen.kind]);

  async function refresh(): Promise<void> {
    const data = await loadAllData();
    dispatch({ type: 'set-data', data });
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        title="Multi-Account Tool (mat)"
        subtitle="여러 AI CLI 계정을 하나의 TUI 에서 전환"
      />
      {renderScreen(screen, state.data, dispatch, refresh, exit)}
    </Box>
  );
}

// --- 초기 로딩 ---

async function initialize(dispatch: React.Dispatch<Action>): Promise<void> {
  await cleanupTmpFiles();
  const data = await loadAllData();
  dispatch({ type: 'set-data', data });

  const importable = data.detection
    .filter((d) => d.hasAnyLiveCredential)
    .map((d) => d.cli.id)
    .filter((id) => (data.profilesByCli[id] ?? []).length === 0);

  if (!data.firstImportPromptShown && importable.length > 0) {
    dispatch({
      type: 'replace',
      screen: {
        kind: 'firstImport',
        targets: importable,
        expectedByCli: buildFirstImportExpectedByCli(importable, data)
      }
    });
  } else {
    dispatch({ type: 'replace', screen: { kind: 'home' } });
  }
}

function buildFirstImportExpectedByCli(
  targets: string[],
  data: AppData
): Record<string, FirstImportExpectedState> {
  return Object.fromEntries(
    targets.map((cliId) => [
      cliId,
      {
        active: data.activeByCli[cliId],
        profiles: profileNames(data.profilesByCli[cliId] ?? [])
      }
    ])
  );
}

async function loadAllData(): Promise<AppData> {
  const [detection, config, profilesByCli] = await Promise.all([
    detectAll(),
    loadConfig(),
    loadProfilesByCli()
  ]);
  return {
    detection,
    activeByCli: config.active,
    profilesByCli,
    firstImportPromptShown: !!config.firstImportPromptShown,
    firstFreshnessPromptShown: !!config.firstFreshnessPromptShown
  };
}

async function loadProfilesByCli(): Promise<AppData['profilesByCli']> {
  const result: AppData['profilesByCli'] = {};
  await Promise.all(
    getAllCliDefs().map(async (cli) => {
      const names = await listProfiles(cli.id);
      const items = await Promise.all(
        names.map(async (name) => ({
          name,
          meta: (await readMeta(cli.id, name)) ?? undefined
        }))
      );
      result[cli.id] = items;
    })
  );
  return result;
}

function sortedProfileNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function profileNames(profiles: { name: string }[]): string[] {
  return sortedProfileNames(profiles.map((p) => p.name));
}

// --- 화면 렌더링 ---

function renderScreen(
  screen: Screen,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>,
  exit: () => void
): React.ReactElement {
  switch (screen.kind) {
    case 'loading':
      return <Busy message="자격증명 상태 확인 중..." />;
    case 'firstImport':
      return renderFirstImport(screen, dispatch, refresh);
    case 'home':
      return renderHome(data, dispatch, exit);
    case 'profiles':
      return renderProfiles(screen, data, dispatch, refresh);
    case 'add':
      return renderAdd(screen, data, dispatch, refresh);
    case 'rename':
      return renderRename(screen, data, dispatch, refresh);
    case 'confirm':
      return (
        <Confirm
          title={screen.title}
          body={screen.body}
          dangerous={screen.dangerous}
          yesLabel={screen.yesLabel}
          noLabel={screen.noLabel}
          onYes={screen.onYes}
          onNo={screen.onNo ?? (() => dispatch({ type: 'pop' }))}
        />
      );
    case 'freshness':
      return (
        <FreshnessDialog
          mode={screen.mode}
          fromProfile={screen.fromProfile}
          toProfile={screen.toProfile}
          report={screen.report}
          ambientWarningBlock={screen.ambientWarningBlock}
          showOnboarding={screen.showOnboarding}
          onRecapture={screen.onRecapture}
          onDiscard={screen.onDiscard}
          onCancel={screen.onCancel}
        />
      );
    case 'busy':
      return <Busy message={screen.message} />;
    case 'message':
      return (
        <Message
          tone={screen.tone}
          title={screen.title}
          body={screen.body}
          onDismiss={() => {
            if (screen.onDismiss) screen.onDismiss();
            else dispatch({ type: 'pop' });
          }}
        />
      );
  }
}

function renderHome(
  data: AppData,
  dispatch: React.Dispatch<Action>,
  exit: () => void
): React.ReactElement {
  const items: CliRow[] = getAllCliDefs().map((cli) => {
    const det = data.detection.find((d) => d.cli.id === cli.id);
    return {
      cli,
      active: data.activeByCli[cli.id],
      profileCount: (data.profilesByCli[cli.id] ?? []).length,
      hasLive: det?.hasLiveCredentials ?? false
    };
  });
  return (
    <HomeScreen
      items={items}
      onSelect={(cliId) => dispatch({ type: 'push', screen: { kind: 'profiles', cliId } })}
      onQuit={exit}
    />
  );
}

function renderProfiles(
  screen: Extract<Screen, { kind: 'profiles' }>,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): React.ReactElement {
  const cli = findCliDef(screen.cliId);
  if (!cli) return <Busy message="알 수 없는 CLI..." />;
  const active = data.activeByCli[cli.id];
  const profiles: ProfileItem[] = (data.profilesByCli[cli.id] ?? []).map((p) => ({
    name: p.name,
    meta: p.meta,
    isActive: p.name === active
  }));
  return (
    <ProfilesScreen
      cli={cli}
      active={active}
      profiles={profiles}
      onSwitch={(name) => onSwitchAction(cli, name, active, data, dispatch, refresh)}
      onAdd={() => dispatch({ type: 'push', screen: { kind: 'add', cliId: cli.id } })}
      onRename={(name) =>
        dispatch({ type: 'push', screen: { kind: 'rename', cliId: cli.id, oldName: name } })
      }
      onDelete={(name) => onDeleteAction(cli, name, active, dispatch, refresh)}
      onCapture={(name) => onCaptureAction(cli, name, active, dispatch, refresh)}
      onBack={() => dispatch({ type: 'pop' })}
    />
  );
}

function renderAdd(
  screen: Extract<Screen, { kind: 'add' }>,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): React.ReactElement {
  const cli = findCliDef(screen.cliId);
  if (!cli) return <Busy message="알 수 없는 CLI..." />;
  const existing = new Set((data.profilesByCli[cli.id] ?? []).map((p) => p.name));
  return (
    <TextPrompt
      label={`${cli.name} — 새 프로필 이름 (현재 라이브 자격증명이 캡처되어 시작 상태가 됩니다)`}
      placeholder="personal / work / ..."
      validate={(v) => validateNewName(v, existing)}
      onSubmit={(name) => onAddSubmit(cli, name, data, dispatch, refresh)}
      onCancel={() => dispatch({ type: 'pop' })}
    />
  );
}

function renderRename(
  screen: Extract<Screen, { kind: 'rename' }>,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): React.ReactElement {
  const cli = findCliDef(screen.cliId);
  if (!cli) return <Busy message="알 수 없는 CLI..." />;
  const existing = new Set((data.profilesByCli[cli.id] ?? []).map((p) => p.name));
  return (
    <TextPrompt
      label={`${cli.name} / ${screen.oldName} → 새 이름`}
      initial={screen.oldName}
      validate={(v) => validateRenameTo(v, screen.oldName, existing)}
      onSubmit={(newName) => onRenameSubmit(cli.id, screen.oldName, newName, dispatch, refresh)}
      onCancel={() => dispatch({ type: 'pop' })}
    />
  );
}

function renderFirstImport(
  screen: Extract<Screen, { kind: 'firstImport' }>,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): React.ReactElement {
  const targets = screen.targets
    .map((id) => findCliDef(id))
    .filter((c): c is CliDef => !!c);
  return (
    <Confirm
      title="초기 자격증명 가져오기"
      body={formatFirstImportBody(targets)}
      yesLabel="모두 가져오기"
      noLabel="건너뛰기"
      onYes={() => void onFirstImport(screen.targets, screen.expectedByCli, dispatch, refresh)}
      onNo={() => void declineFirstImport(dispatch)}
    />
  );
}

// --- 메시지 / 라벨 포매터 ---

// formatFirstImportBody / formatSwitchConfirmBody / formatSwitchResult /
// formatCaptureWarning 정의는 src/app/formatters.ts 로 분리 (PR-O).
// validateNewName / validateRenameTo 는 src/app/validators.ts 로 분리.

// --- 공용 액션 헬퍼 (busy → work → refresh → success/error message) ---

interface BusyActionConfig<T> {
  dispatch: React.Dispatch<Action>;
  refresh: () => Promise<void>;
  busyMessage: string;
  work: () => Promise<T>;
  buildSuccess: (result: T) => { title: string; body?: string; tone?: MessageTone };
  errorTitle: string;
}

/**
 * busy → work → refresh → success/error message 흐름을 일관 처리.
 * doSwitch / doDelete / doCapture / onAddSubmit / onRenameSubmit 모두 이 헬퍼 사용.
 */
async function runBusyAction<T>(cfg: BusyActionConfig<T>): Promise<void> {
  cfg.dispatch({ type: 'replace', screen: { kind: 'busy', message: cfg.busyMessage } });
  try {
    const result = await cfg.work();
    await cfg.refresh();
    const { title, body, tone } = cfg.buildSuccess(result);
    cfg.dispatch({
      type: 'replace',
      screen: { kind: 'message', tone: tone ?? 'success', title, body }
    });
  } catch (err) {
    if (err instanceof ActiveProfileChangedError) {
      cfg.dispatch({
        type: 'replace',
        screen: { kind: 'message', tone: 'error', title: err.title, body: err.body }
      });
      return;
    }
    cfg.dispatch({
      type: 'replace',
      screen: { kind: 'message', tone: 'error', title: cfg.errorTitle, body: describeError(err) }
    });
  }
}

// --- 액션 핸들러 ---

async function declineFirstImport(dispatch: React.Dispatch<Action>): Promise<void> {
  try {
    await markFirstImportPromptShown();
  } catch (err) {
    console.error('markFirstImportPromptShown 실패:', errorMessage(err));
  }
  dispatch({ type: 'replace', screen: { kind: 'home' } });
}

async function onFirstImport(
  targets: string[],
  expectedByCli: Record<string, FirstImportExpectedState>,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  dispatch({ type: 'replace', screen: { kind: 'busy', message: '자격증명 가져오는 중...' } });
  const summary: FirstImportSummary = { successes: [], failures: [] };
  for (const cliId of targets) {
    try {
      const snap = await withCliMutationLock(
        { cliId, profileName: 'default', execMode: 'foreground', affectsCliIds: [cliId] },
        async () => {
          await assertFirstImportStateUnchanged(cliId, expectedByCli[cliId]);
          const captured = await snapshotLiveToProfile(cliId, 'default');
          await setActiveProfile(cliId, 'default');
          return captured;
        }
      );
      summary.successes.push({ cliId, captured: snap.captured });
    } catch (err) {
      summary.failures.push({ cliId, err: errorMessage(err) });
    }
  }
  try {
    await markFirstImportPromptShown();
  } catch (err) {
    console.error('markFirstImportPromptShown 실패:', errorMessage(err));
  }
  await refresh();
  dispatch({
    type: 'replace',
    screen: {
      kind: 'message',
      tone: importTone(summary),
      title: importTitle(summary),
      body: formatFirstImportSummary(summary),
      onDismiss: () => dispatch({ type: 'home' })
    }
  });
}

// importTone / importTitle / formatFirstImportSummary / FirstImportSummary
// 정의는 src/app/formatters.ts 로 분리 (PR-O).

function onSwitchAction(
  cli: CliDef,
  to: string,
  currentActive: string | undefined,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): void {
  if (currentActive === to) {
    void pushSwitchConfirmWithAmbient(
      cli,
      currentActive,
      to,
      dispatch,
      () => void doSwitch(cli, to, dispatch, refresh, currentActive)
    );
    return;
  }
  // PR-G: 활성 프로필이 있을 때만 freshness 체크 의미 있음 — 없으면 백업 불필요.
  // current === to 케이스도 stale render 방지를 위해 doSwitch 내부 lock 에서 재검증.
  if (currentActive != null) {
    void checkFreshnessThenSwitch(cli, currentActive, to, data, dispatch, refresh);
    return;
  }
  // 활성 미설정: 단순 confirm 후 swap (백업 불필요).
  void pushSwitchConfirmWithAmbient(cli, currentActive, to, dispatch, () => void doSwitch(cli, to, dispatch, refresh, currentActive));
}

async function switchConfirmBodyWithAmbient(cliId: string, currentActive: string | undefined, to: string): Promise<string> {
  const body = formatSwitchConfirmBody(currentActive, to);
  const block = await ambientWarningBlock(cliId);
  return block ? `${body}\n\n${block}` : body;
}

async function ambientWarningBlock(cliId: string): Promise<string | undefined> {
  try {
    const warnings = await detectAmbientWarnings(cliId);
    const block = formatAmbientWarnings(warnings, {
      header: '⚠ Ambient credential/config warning'
    });
    return block ? `${block}\nSee: mat support ${cliId}` : undefined;
  } catch {
    return undefined;
  }
}

async function pushSwitchConfirmWithAmbient(
  cli: CliDef,
  currentActive: string | undefined,
  to: string,
  dispatch: React.Dispatch<Action>,
  onYes: () => void
): Promise<void> {
  dispatch({
    type: 'push',
    screen: {
      kind: 'confirm',
      title: `${cli.name} 프로필 전환`,
      body: await switchConfirmBodyWithAmbient(cli.id, currentActive, to),
      onYes
    }
  });
}

/**
 * PR-G: swap 직전 freshness inspect → 라이브 vs 저장본 차이 감지 시 dialog 분기.
 *
 * `inspectAndRouteFreshness` 의 switch-mode 래퍼. 모든 분기 로직은 helper 가
 * 담당하고 본 함수는 콜백만 제공.
 */
function checkFreshnessThenSwitch(
  cli: CliDef,
  currentActive: string,
  to: string,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  return inspectAndRouteFreshness({
    cli,
    currentActive,
    data,
    dispatch,
    initialBusyAction: 'push',
    onFresh: async () => dispatch({
      type: 'replace',
      screen: {
        kind: 'confirm',
        title: `${cli.name} 프로필 전환`,
        body: await switchConfirmBodyWithAmbient(cli.id, currentActive, to),
        onYes: () => void doSwitch(cli, to, dispatch, refresh, currentActive)
      }
    }),
    buildDialog: async (report) => ({
      kind: 'freshness',
      mode: 'switch',
      cliId: cli.id,
      fromProfile: currentActive,
      toProfile: to,
      report,
      ambientWarningBlock: await ambientWarningBlock(cli.id),
      showOnboarding: !data.firstFreshnessPromptShown,
      onRecapture: () =>
        void doSwitchWithRecapture(cli, currentActive, to, dispatch, refresh),
      onDiscard: () =>
        void doSwitchDiscardingLive(cli, currentActive, to, dispatch, refresh),
      onCancel: () => dispatch({ type: 'pop' })
    })
  });
}

interface FreshnessRoutingOptions {
  cli: CliDef;
  currentActive: string;
  data: AppData;
  dispatch: React.Dispatch<Action>;
  /**
   * Busy 화면 진입 시 dispatch 방식.
   *  - 'push': 현재 화면을 보존한 채 busy 를 쌓는다 (switch 흐름 — ProfilesScreen 보존).
   *  - 'replace': 현재 화면을 busy 로 교체 (create 흐름 — TextPrompt 의 add 화면을 dismiss).
   */
  initialBusyAction: 'push' | 'replace';
  /** 모든 source fresh — 사용자 액션 불필요. 호출자가 다음 화면 dispatch. */
  onFresh: () => void | Promise<void>;
  /** rotated/stale 감지 — 호출자가 freshness Screen 객체 빌드. */
  buildDialog: (report: FreshnessReport) => Screen | Promise<Screen>;
}

/**
 * PR-G quad-review HIGH fix (#9): switch / create 두 모드의 freshness 분기 중복 제거.
 *
 * 공통 시퀀스:
 *  1) busy 화면 dispatch (initialBusyAction 으로 push/replace 결정).
 *  2) inspectLiveFreshness(cli, currentActive) — read-only.
 *  3) 예외 → "자격증명 확인 실패" message 후 중단 (사용자가 결정 전 상태라 silent
 *     swallow 부적절 — PR-F* 의 safeInspectFreshness 와 분기되는 정책).
 *  4) 모든 source fresh → onFresh() 호출 (호출자 분기).
 *  5) inflight 포함 → 재시도 안내 message 후 중단.
 *  6) rotated/stale → buildDialog(report) 의 화면을 dispatch + onboarding 플래그 갱신.
 */
async function inspectAndRouteFreshness(opts: FreshnessRoutingOptions): Promise<void> {
  opts.dispatch({
    type: opts.initialBusyAction,
    screen: { kind: 'busy', message: '자격증명 상태 확인 중...' }
  });
  let report: FreshnessReport;
  try {
    report = await inspectLiveFreshness(opts.cli.id, opts.currentActive);
  } catch (err) {
    opts.dispatch({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '자격증명 확인 실패',
        body: describeError(err)
      }
    });
    return;
  }
  if (!needsUserAttention(report)) {
    await opts.onFresh();
    return;
  }
  if (hasInflight(report)) {
    opts.dispatch({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'warning',
        title: '자격증명 갱신 중 (재시도 권장)',
        body:
          `라이브 자격증명이 갱신 중간 상태로 보입니다 (multi-source 부분 갱신).\n` +
          `잠시 후 다시 시도하세요.`
      }
    });
    return;
  }
  opts.dispatch({ type: 'replace', screen: await opts.buildDialog(report) });
  // dialog 가 표시된 시점에 onboarding 플래그 즉시 in-memory 갱신 (#3 fix).
  // file persist 는 fire-and-forget — 같은 세션 내 두 번째 dialog 에도 panel 미중복.
  opts.dispatch({ type: 'mark-freshness-prompt-shown' });
  void persistFirstFreshnessPromptIfNeeded(opts.data);
}

async function persistFirstFreshnessPromptIfNeeded(data: AppData): Promise<void> {
  if (data.firstFreshnessPromptShown) return;
  try {
    await markFirstFreshnessPromptShown();
  } catch (err) {
    // best-effort — 다음 dialog 표시 시 다시 시도된다. 사용자 흐름 차단 금지.
    //
    // PR-R: 옛 코드는 process.stderr.write 로 surface 했으나 Ink 의 alternate-buffer
    // 모드에서 화면 렌더와 충돌 가능 (PR-G Claude-1 LOW finding). 본 PR 에서 ~/.
    // multi-account-tool/app.log 에 append 로 전환 — TUI 무영향 + 디버그 audit trail.
    // 로그 쓰기 자체도 실패하면 빈 catch 금지 규칙 (CLAUDE.md) 에 따라 최후 수단
    // stderr 안내 — 이중 실패는 영구 디스크 문제로 추정.
    void appendAppLogBestEffort(
      `markFirstFreshnessPromptShown 실패: ${errorMessage(err)}`
    );
  }
}

// appendAppLogBestEffort 정의는 src/app/log.ts 로 분리 (PR-O).

/**
 * PR-G quad-review HIGH fix (#1): freshness dialog 표시 ~ 사용자 결정 사이에
 * 다른 mat 프로세스 / 외부 도구가 active 프로필을 변경했을 가능성을 차단한다.
 *
 * dialog 가 보여준 컨텍스트와 실제 swap 시점의 상태가 일치하지 않으면 사용자는
 * 의도하지 않은 프로필에 라이브 자격증명을 저장하거나 폐기하게 된다. 본 함수가
 * 진입 직전 active 를 재검증해 mismatch 시 swap/snapshot 전체를 중단한다.
 *
 * 불일치하면 ActiveProfileChangedError 를 throw 한다. runBusyAction 이 이 타입을
 * 별도 처리해 성공 UI 로 덮지 않고 기존 취소 안내를 표시한다.
 */
class ActiveProfileChangedError extends Error {
  readonly title = '활성 프로필 변경 감지 — 작업 취소';
  readonly body: string;

  constructor(expected: string | undefined, current: string | undefined) {
    const body =
      `dialog 표시 중 다른 도구가 활성 프로필을 변경했습니다.\n` +
      `예상: '${expected ?? '(없음)'}' / 현재: '${current ?? '(없음)'}'\n\n` +
      `라이브 자격증명이 의도와 다른 프로필에 쓰일 수 있어 작업을 취소했습니다.\n` +
      `프로필 목록을 다시 확인 후 재시도하세요.`;
    super(body);
    this.name = 'ActiveProfileChangedError';
    this.body = body;
  }
}

class FirstImportStateChangedError extends Error {
  constructor(
    cliId: string,
    expectedProfiles: string[],
    currentProfiles: string[]
  ) {
    super(
      `초기 가져오기 dialog 표시 중 ${cliId} 프로필 목록이 변경되었습니다.\n` +
      `예상: ${formatProfileList(expectedProfiles)} / 현재: ${formatProfileList(currentProfiles)}\n\n` +
      `다른 작업이 먼저 프로필 상태를 변경해 stale 가져오기를 취소했습니다.\n` +
      `프로필 목록을 다시 확인 후 재시도하세요.`
    );
    this.name = 'FirstImportStateChangedError';
  }
}

async function assertActiveProfileUnchanged(
  cliId: string,
  expected: string | undefined
): Promise<string | undefined> {
  const current = await getActiveProfile(cliId);
  if (current !== expected) throw new ActiveProfileChangedError(expected, current);
  return current;
}

async function assertFirstImportStateUnchanged(
  cliId: string,
  expected: FirstImportExpectedState | undefined
): Promise<void> {
  if (!expected) {
    throw new FirstImportStateChangedError(cliId, [], await listProfiles(cliId));
  }
  await assertActiveProfileUnchanged(cliId, expected.active);
  const expectedProfiles = sortedProfileNames(expected.profiles);
  const currentProfiles = sortedProfileNames(await listProfiles(cliId));
  if (!sameProfileNames(currentProfiles, expectedProfiles)) {
    throw new FirstImportStateChangedError(cliId, expectedProfiles, currentProfiles);
  }
}

function sameProfileNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, idx) => name === b[idx]);
}

function formatProfileList(names: string[]): string {
  return names.length === 0 ? '(없음)' : names.join(', ');
}

async function doSwitch(
  cli: CliDef,
  to: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>,
  expectedActive: string | undefined
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '전환 중...',
    work: () =>
      withCliMutationLock(
        { cliId: cli.id, profileName: to, execMode: 'foreground', affectsCliIds: [cli.id] },
        async () => {
          await assertActiveProfileUnchanged(cli.id, expectedActive);
          return switchProfile(cli.id, to);
        }
      ),
    buildSuccess: (result) => ({
      title: '전환 완료',
      body: formatSwitchResult(result, to)
    }),
    errorTitle: '전환 실패'
  });
}

/**
 * PR-G "재캡처": 라이브 자격증명 (refresh-rotated) 을 활성 프로필에 명시 저장 후 swap.
 *
 * 시퀀스: `snapshotLiveToProfile(currentActive)` → `switchProfile(to, skipPreSwapSnapshot=true)`.
 * 내부 자동 snapshot 은 의미적으로 idempotent 하지만 동일 라이브를 두 번 읽고 두 번 쓰는
 * I/O 비효율 + race window 확대를 막기 위해 명시 `skipPreSwapSnapshot=true` 로 생략.
 * 폐기 path 의 `skipPreSwapSnapshot=true` 와 동일 옵션 — 단지 명시 snapshot 1회가 선행.
 */
async function doSwitchWithRecapture(
  cli: CliDef,
  currentActive: string,
  to: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '라이브 재캡처 후 전환 중...',
    work: () =>
      withCliMutationLock(
        {
          cliId: cli.id,
          profileName: to,
          execMode: 'foreground',
          previousActive: currentActive,
          affectsCliIds: [cli.id]
        },
        async () => {
          await assertActiveProfileUnchanged(cli.id, currentActive);
          await snapshotLiveToProfile(cli.id, currentActive);
          return await switchProfile(cli.id, to, { skipPreSwapSnapshot: true });
        }
      ),
    buildSuccess: (result) => ({
      title: '재캡처 + 전환 완료',
      body:
        `라이브 자격증명을 '${currentActive}' 에 저장한 뒤 '${to}' 로 전환했습니다.\n\n` +
        formatSwitchResult(result, to)
    }),
    errorTitle: '재캡처/전환 실패'
  });
}

/**
 * PR-G "폐기": skipPreSwapSnapshot 으로 swap. 라이브의 rotated 토큰은 보존되지 않고
 * toProfile 의 저장본으로 덮어써진다 — 사용자가 의도적으로 폐기 선택한 경우만 사용.
 * #1 fix: 진입 시 currentActive 재검증 — dialog 컨텍스트와 실제 active 일치 확인.
 */
async function doSwitchDiscardingLive(
  cli: CliDef,
  currentActive: string,
  to: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '라이브 폐기 후 전환 중...',
    work: () =>
      withCliMutationLock(
        {
          cliId: cli.id,
          profileName: to,
          execMode: 'foreground',
          previousActive: currentActive,
          affectsCliIds: [cli.id]
        },
        async () => {
          await assertActiveProfileUnchanged(cli.id, currentActive);
          return switchProfile(cli.id, to, { skipPreSwapSnapshot: true });
        }
      ),
    buildSuccess: (result) => ({
      title: '폐기 + 전환 완료',
      tone: 'warning' as MessageTone,
      body:
        `라이브 자격증명을 백업 없이 폐기하고 '${to}' 로 전환했습니다.\n\n` +
        formatSwitchResult(result, to)
    }),
    errorTitle: '폐기/전환 실패'
  });
}

async function onAddSubmit(
  cli: CliDef,
  name: string,
  data: AppData,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  // PR-G: 활성 프로필이 있을 때만 freshness 체크. 활성 미설정 시엔 라이브가 어느
  // 프로필 소유인지 정의되지 않으므로 단순 캡처로 진행 (기존 동작 보존).
  const currentActive = data.activeByCli[cli.id];
  if (currentActive == null || currentActive === name) {
    // 활성 미설정 / 자기 자신 캡처도 render 시점의 active 를 lock 안에서 재검증한다.
    await doCreateProfile(cli, name, currentActive, dispatch, refresh);
    return;
  }
  // create-mode 의 분기는 switch-mode 와 동일 helper 재사용 (#9 fix).
  await inspectAndRouteFreshness({
    cli,
    currentActive,
    data,
    dispatch,
    initialBusyAction: 'replace',
    onFresh: () => void doCreateProfile(cli, name, currentActive, dispatch, refresh),
    buildDialog: (report) => ({
      kind: 'freshness',
      mode: 'create',
      cliId: cli.id,
      fromProfile: currentActive,
      toProfile: name,
      report,
      showOnboarding: !data.firstFreshnessPromptShown,
      onRecapture: () =>
        void doCreateWithRecapture(cli, currentActive, name, dispatch, refresh),
      // 폐기 path: 라이브를 활성 프로필에 저장하지 않고 새 프로필만 캡처. race 가드 적용.
      onDiscard: () => void doCreateProfile(cli, name, currentActive, dispatch, refresh),
      onCancel: () => dispatch({ type: 'pop' })
    })
  });
}

/**
 * PR-G create-mode 의 "폐기" 분기 + 단순 캡처 진입점.
 *
 * dialog 표시/렌더 시점의 active 를 lock 내부에서 재검증한다. `undefined` 도
 * "활성 프로필 없음" 이라는 기대 상태이므로 active 가 외부에서 생기면 작업 중단.
 *
 * 활성 프로필은 변경되지 않음 — 사용자가 명시 전환할 때까지 그대로 유지.
 */
async function doCreateProfile(
  cli: CliDef,
  name: string,
  expectedActive: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '프로필 생성 중...',
    work: () =>
      withCliMutationLock(
        {
          cliId: cli.id,
          profileName: name,
          execMode: 'foreground',
          previousActive: expectedActive,
          affectsCliIds: [cli.id]
        },
        async () => {
          await assertActiveProfileUnchanged(cli.id, expectedActive);
          return snapshotLiveToProfile(cli.id, name);
        }
      ),
    buildSuccess: (snap) => ({
      title: '프로필 생성 완료',
      body:
        `'${name}' 프로필이 생성되었습니다. (활성 프로필은 변경되지 않았습니다)\n` +
        (snap.captured.length > 0
          ? `라이브 자격증명을 캡처했습니다: ${snap.captured.join(', ')}`
          : `라이브 자격증명이 없어 빈 프로필로 생성되었습니다.`)
    }),
    errorTitle: '프로필 생성 실패'
  });
}

/**
 * PR-G create-mode 재캡처: 활성 프로필에 라이브 저장 후 신규 프로필 생성.
 *
 * 두 snapshotLiveToProfile 호출 사이에 외부 CLI 가 OAuth refresh rotation 을
 * 수행하면 currentActive 와 newName 두 프로필이 *서로 다른* 라이브 토큰을 저장할
 * 수 있다 (단일 프로세스 내 두 read 의 race window). 본 race 는 알려진 한계로,
 * PR-I* 의 LockBody 확장으로 cli 단위 직렬화 도입 시 함께 해소될 예정. 현재는
 * Best-effort — race 발생 빈도가 낮고, 양쪽 다 유효한 토큰 (옛 + 새) 을 갖게 되므로
 * 데이터 손실은 발생하지 않는다 (provider 가 옛 토큰을 revoke 하면 새 토큰만 유효).
 *
 * #1 fix: 진입 시 currentActive 재검증 — dialog 표시 후 active 변경 race 차단.
 */
async function doCreateWithRecapture(
  cli: CliDef,
  currentActive: string,
  newName: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '라이브 재캡처 후 프로필 생성 중...',
    work: () =>
      withCliMutationLock(
        {
          cliId: cli.id,
          profileName: newName,
          execMode: 'foreground',
          previousActive: currentActive,
          affectsCliIds: [cli.id]
        },
        async () => {
          await assertActiveProfileUnchanged(cli.id, currentActive);
          await snapshotLiveToProfile(cli.id, currentActive);
          return await snapshotLiveToProfile(cli.id, newName);
        }
      ),
    buildSuccess: (snap) => ({
      title: '재캡처 + 프로필 생성 완료',
      body:
        `라이브 자격증명을 '${currentActive}' 에 저장한 뒤 '${newName}' 프로필을 생성했습니다.\n` +
        `(활성 프로필은 '${currentActive}' 로 유지됩니다)\n` +
        (snap.captured.length > 0
          ? `캡처된 파일: ${snap.captured.join(', ')}`
          : `라이브 자격증명이 없어 빈 프로필로 생성되었습니다.`)
    }),
    errorTitle: '재캡처/생성 실패'
  });
}

async function onRenameSubmit(
  cliId: string,
  oldName: string,
  newName: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '이름 변경 중...',
    work: () =>
      withCliMutationLock(
        {
          cliId,
          profileName: newName,
          execMode: 'foreground',
          previousActive: oldName,
          affectsCliIds: [cliId]
        },
        async () => {
          await renameProfile(cliId, oldName, newName);
          const cur = await getActiveProfile(cliId);
          if (cur === oldName) await setActiveProfile(cliId, newName);
        }
      ),
    buildSuccess: () => ({
      title: '이름 변경 완료',
      body: `${oldName} → ${newName}`
    }),
    errorTitle: '이름 변경 실패'
  });
}

function onDeleteAction(
  cli: CliDef,
  name: string,
  active: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): void {
  if (active === name) {
    dispatch({
      type: 'push',
      screen: {
        kind: 'message',
        tone: 'warning',
        title: '활성 프로필은 삭제할 수 없습니다',
        body: `먼저 다른 프로필로 전환한 후 '${name}' 을 삭제하세요.`
      }
    });
    return;
  }
  dispatch({
    type: 'push',
    screen: {
      kind: 'confirm',
      title: '프로필 삭제',
      body: `'${name}' 프로필을 영구 삭제합니다. 되돌릴 수 없습니다.`,
      dangerous: true,
      onYes: () => void doDelete(cli.id, name, active, dispatch, refresh)
    }
  });
}

async function doDelete(
  cliId: string,
  name: string,
  expectedActive: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '삭제 중...',
    work: () =>
      withCliMutationLock(
        { cliId, profileName: name, execMode: 'foreground', affectsCliIds: [cliId] },
        async () => {
          const current = await assertActiveProfileUnchanged(cliId, expectedActive);
          if (current === name) throw new ActiveProfileChangedError(expectedActive, current);
          return deleteProfile(cliId, name);
        }
      ),
    buildSuccess: () => ({
      title: '삭제 완료',
      body: `'${name}' 프로필이 삭제되었습니다.`
    }),
    errorTitle: '삭제 실패'
  });
}

function onCaptureAction(
  cli: CliDef,
  name: string,
  active: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): void {
  dispatch({
    type: 'push',
    screen: {
      kind: 'confirm',
      title: '현재 라이브 자격증명을 캡처',
      body: formatCaptureWarning(name, active),
      dangerous: name !== active,
      onYes: () => void doCapture(cli.id, name, active, dispatch, refresh)
    }
  });
}

async function doCapture(
  cliId: string,
  name: string,
  expectedActive: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '캡처 중...',
    work: () =>
      withCliMutationLock(
        { cliId, profileName: name, execMode: 'foreground', affectsCliIds: [cliId] },
        async () => {
          await assertActiveProfileUnchanged(cliId, expectedActive);
          return snapshotLiveToProfile(cliId, name);
        }
      ),
    buildSuccess: (snap) => ({
      title: '캡처 완료',
      body:
        snap.captured.length > 0
          ? `저장됨: ${snap.captured.join(', ')}`
          : '캡처할 라이브 자격증명이 없습니다.'
    }),
    errorTitle: '캡처 실패'
  });
}

export const __testHooks = {
  ambientWarningBlock,
  assertActiveProfileUnchanged,
  doCapture,
  doCreateProfile,
  doDelete,
  doSwitch,
  onSwitchAction,
  onFirstImport,
  switchConfirmBodyWithAmbient
};
