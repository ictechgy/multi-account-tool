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

import { BUILTIN_CLI_DEFS, findCliDef } from './core/cli-defs.js';
import {
  cleanupTmpFiles,
  getActiveProfile,
  loadConfig,
  markFirstImportPromptShown,
  setActiveProfile
} from './core/config.js';
import { detectAll, type DetectionResult } from './core/detector.js';
import { errorMessage } from './core/errors.js';
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
import { HomeScreen, ProfilesScreen, type CliRow, type ProfileItem } from './ui/screens.js';

// --- 화면 타입 ---

type MessageTone = 'info' | 'success' | 'error' | 'warning';

type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | { kind: 'firstImport'; targets: string[] }
  | { kind: 'profiles'; cliId: string }
  | { kind: 'add'; cliId: string }
  | { kind: 'rename'; cliId: string; oldName: string }
  | {
      kind: 'confirm';
      title: string;
      body?: string;
      dangerous?: boolean;
      onYes: () => void;
      onNo?: () => void;
      yesLabel?: string;
      noLabel?: string;
    }
  | { kind: 'busy'; message: string }
  | {
      kind: 'message';
      tone: MessageTone;
      title: string;
      body?: string;
      onDismiss?: () => void;
    };

// --- 데이터 캐시 ---

interface AppData {
  detection: DetectionResult[];
  activeByCli: Record<string, string | undefined>;
  profilesByCli: Record<string, { name: string; meta?: Profile }[]>;
  firstImportPromptShown: boolean;
}

const EMPTY_DATA: AppData = {
  detection: [],
  activeByCli: {},
  profilesByCli: {},
  firstImportPromptShown: false
};

// --- 액션 / 리듀서 ---

type Action =
  | { type: 'set-data'; data: AppData }
  | { type: 'push'; screen: Screen }
  | { type: 'replace'; screen: Screen }
  | { type: 'pop' }
  | { type: 'home' };

interface State {
  stack: Screen[];
  data: AppData;
}

const initialState: State = {
  stack: [{ kind: 'loading' }],
  data: EMPTY_DATA
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-data':
      return { ...state, data: action.data };
    case 'push':
      return { ...state, stack: [...state.stack, action.screen] };
    case 'replace':
      if (state.stack.length === 0) return { ...state, stack: [action.screen] };
      return { ...state, stack: [...state.stack.slice(0, -1), action.screen] };
    case 'pop':
      // 스택이 비게 되면 home 으로 fallback (root level 화면이 pop 됐을 때 안전).
      if (state.stack.length <= 1) return { ...state, stack: [{ kind: 'home' }] };
      return { ...state, stack: state.stack.slice(0, -1) };
    case 'home':
      // 명시적 home navigation (firstImport 완료 후 등). 스택 전체를 리셋.
      return { ...state, stack: [{ kind: 'home' }] };
  }
}

function topOf(state: State): Screen {
  // reducer 가 invariant (stack.length >= 1) 를 유지하지만 안전망으로 fallback.
  return state.stack[state.stack.length - 1] ?? { kind: 'home' };
}

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
    dispatch({ type: 'replace', screen: { kind: 'firstImport', targets: importable } });
  } else {
    dispatch({ type: 'replace', screen: { kind: 'home' } });
  }
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
    firstImportPromptShown: !!config.firstImportPromptShown
  };
}

async function loadProfilesByCli(): Promise<AppData['profilesByCli']> {
  const result: AppData['profilesByCli'] = {};
  await Promise.all(
    BUILTIN_CLI_DEFS.map(async (cli) => {
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
  const items: CliRow[] = BUILTIN_CLI_DEFS.map((cli) => {
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
      onSwitch={(name) => onSwitchAction(cli, name, active, dispatch, refresh)}
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
      onSubmit={(name) => onAddSubmit(cli.id, name, dispatch, refresh)}
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
      onYes={() => void onFirstImport(screen.targets, dispatch, refresh)}
      onNo={() => void declineFirstImport(dispatch)}
    />
  );
}

// --- 메시지 / 라벨 포매터 ---

function formatFirstImportBody(targets: CliDef[]): string {
  return (
    `다음 CLI 에 이미 로그인된 자격증명이 감지되었습니다:\n` +
    targets.map((c) => `  - ${c.name}`).join('\n') +
    `\n\n각 CLI 마다 'default' 프로필로 가져올까요?\n` +
    `라이브 자격증명은 그대로 유지되며 백업만 생성됩니다.\n` +
    `(이 프롬프트는 어떤 답을 선택하든 다음 실행부터 자동으로 뜨지 않습니다.)`
  );
}

function formatSwitchConfirmBody(currentActive: string | undefined, to: string): string {
  const header = `${currentActive ?? '(없음)'}  →  ${to}\n\n`;
  if (!currentActive) {
    return (
      header +
      `현재 활성 프로필이 없어 별도 백업 없이 '${to}' 프로필을 복원합니다.\n` +
      `(주의: 현재 라이브 자격증명은 덮어써집니다)`
    );
  }
  return (
    header +
    `현재 라이브 자격증명은 '${currentActive}' 프로필로 자동 백업된 뒤,\n` +
    `'${to}' 프로필의 자격증명이 복원됩니다.`
  );
}

function formatSwitchResult(r: SwitchResult, to: string): string {
  const lines: string[] = [];
  if (r.fromSnapshot) {
    lines.push(`백업 → ${r.fromSnapshot.profileName} : ${r.fromSnapshot.captured.length}개 파일`);
    if (r.fromSnapshot.empty.length) {
      lines.push(`  (비어있어 캡처 안 됨: ${r.fromSnapshot.empty.join(', ')})`);
    }
  }
  lines.push(`복원 → ${to} : ${r.restore.restored.length}개 파일`);
  if (r.restore.missing.length) {
    lines.push(`  (프로필에 없어 건너뜀: ${r.restore.missing.join(', ')})`);
  }
  return lines.join('\n');
}

function formatCaptureWarning(name: string, active: string | undefined): string {
  if (name === active) {
    return (
      `'${name}' 프로필의 저장된 자격증명을 현재 라이브 값으로 덮어씁니다.\n` +
      `방금 새 계정으로 로그인을 마쳤다면 이 동작을 사용하세요.`
    );
  }
  return (
    `'${name}' 프로필의 저장된 자격증명을 현재 라이브 값으로 덮어씁니다.\n\n` +
    `⚠ 주의: 현재 활성 프로필은 '${active ?? '없음'}' 입니다.\n` +
    `라이브 자격증명은 활성 프로필의 것이므로, 캡처 시 '${name}' 프로필이\n` +
    `활성 프로필의 자격증명으로 덮어써집니다 (의도한 동작이 맞는지 확인하세요).`
  );
}

// --- 입력 검증 (UI 즉시 피드백) ---

function validateNewName(v: string, existing: Set<string>): string | null {
  if (!v) return '이름을 입력하세요.';
  try {
    const normalized = validateProfileName(v);
    if (existing.has(normalized)) return '같은 이름의 프로필이 이미 존재합니다.';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '잘못된 이름입니다.';
  }
}

function validateRenameTo(v: string, oldName: string, existing: Set<string>): string | null {
  if (!v) return '이름을 입력하세요.';
  try {
    const normalized = validateProfileName(v);
    if (normalized === oldName) return '같은 이름입니다.';
    if (existing.has(normalized)) return '같은 이름의 프로필이 이미 존재합니다.';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '잘못된 이름입니다.';
  }
}

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
    cfg.dispatch({
      type: 'replace',
      screen: { kind: 'message', tone: 'error', title: cfg.errorTitle, body: errorMessage(err) }
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

interface FirstImportSummary {
  successes: { cliId: string; captured: string[] }[];
  failures: { cliId: string; err: string }[];
}

async function onFirstImport(
  targets: string[],
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  dispatch({ type: 'replace', screen: { kind: 'busy', message: '자격증명 가져오는 중...' } });
  const summary: FirstImportSummary = { successes: [], failures: [] };
  for (const cliId of targets) {
    try {
      const snap = await snapshotLiveToProfile(cliId, 'default');
      await setActiveProfile(cliId, 'default');
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

function importTone(s: FirstImportSummary): MessageTone {
  if (s.failures.length === 0) return 'success';
  if (s.successes.length === 0) return 'error';
  return 'warning';
}

function importTitle(s: FirstImportSummary): string {
  if (s.failures.length === 0) return '가져오기 완료';
  if (s.successes.length === 0) return '가져오기 실패';
  return '가져오기 부분 완료';
}

function formatFirstImportSummary(s: FirstImportSummary): string {
  const lines: string[] = [];
  for (const ok of s.successes) {
    lines.push(`✓ ${ok.cliId}: ${ok.captured.length}개 파일 캡처 (${ok.captured.join(', ')})`);
  }
  for (const fail of s.failures) {
    lines.push(`✗ ${fail.cliId}: ${fail.err}`);
  }
  return lines.join('\n');
}

function onSwitchAction(
  cli: CliDef,
  to: string,
  currentActive: string | undefined,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): void {
  if (currentActive === to) {
    dispatch({
      type: 'push',
      screen: {
        kind: 'message',
        tone: 'info',
        title: '이미 활성 프로필입니다',
        body: `현재 '${to}' 가 활성 상태입니다.`
      }
    });
    return;
  }
  dispatch({
    type: 'push',
    screen: {
      kind: 'confirm',
      title: `${cli.name} 프로필 전환`,
      body: formatSwitchConfirmBody(currentActive, to),
      onYes: () => void doSwitch(cli, to, dispatch, refresh)
    }
  });
}

async function doSwitch(
  cli: CliDef,
  to: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '전환 중...',
    work: () => switchProfile(cli.id, to),
    buildSuccess: (result) => ({
      title: '전환 완료',
      body: formatSwitchResult(result, to)
    }),
    errorTitle: '전환 실패'
  });
}

async function onAddSubmit(
  cliId: string,
  name: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '프로필 생성 중...',
    work: () => snapshotLiveToProfile(cliId, name),
    buildSuccess: (snap) => ({
      title: '프로필 생성 완료',
      body:
        `'${name}' 프로필이 생성되었습니다.\n` +
        (snap.captured.length > 0
          ? `라이브 자격증명을 캡처했습니다: ${snap.captured.join(', ')}`
          : `라이브 자격증명이 없어 빈 프로필로 생성되었습니다.`)
    }),
    errorTitle: '프로필 생성 실패'
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
    work: async () => {
      await renameProfile(cliId, oldName, newName);
      const cur = await getActiveProfile(cliId);
      if (cur === oldName) await setActiveProfile(cliId, newName);
    },
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
      onYes: () => void doDelete(cli.id, name, dispatch, refresh)
    }
  });
}

async function doDelete(
  cliId: string,
  name: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '삭제 중...',
    work: () => deleteProfile(cliId, name),
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
      onYes: () => void doCapture(cli.id, name, dispatch, refresh)
    }
  });
}

async function doCapture(
  cliId: string,
  name: string,
  dispatch: React.Dispatch<Action>,
  refresh: () => Promise<void>
): Promise<void> {
  await runBusyAction({
    dispatch,
    refresh,
    busyMessage: '캡처 중...',
    work: () => snapshotLiveToProfile(cliId, name),
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
