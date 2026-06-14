/**
 * 앱 상태 정의 + 리듀서 (PR-O: app.tsx 모듈 분리).
 *
 * React/Ink 의존 없이 순수 — `useReducer(reducer, initialState)` 으로 호출하는
 * 호출자 (App 컴포넌트) 가 React 컨텍스트 제공.
 *
 * 화면 네비게이션 규칙 (app.tsx JSDoc 과 동일):
 *  - push: 새 화면을 스택에 쌓는다 (profile 화면 → confirm 등).
 *  - replace: 마지막 화면을 새 화면으로 교체 (confirm → busy → message).
 *  - pop: 스택 최상단 제거. 스택이 비게 될 경우 home 으로 fallback.
 *  - home: 명시적 home navigation (스택 전체 리셋).
 *  - mark-freshness-prompt-shown: file persist 와 별도로 in-memory 즉시 갱신
 *    (PR-G quad-review fix #3: 같은 세션 내 두 번째 dialog 에 onboarding 패널
 *    중복 표시 차단).
 */

import type { DetectionResult } from '../core/detector.js';
import type { FreshnessReport } from '../core/freshness.js';
import type { Profile } from '../core/types.js';

export type MessageTone = 'info' | 'success' | 'error' | 'warning';

export interface FirstImportExpectedState {
  active: string | undefined;
  profiles: string[];
}

export type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | {
      kind: 'firstImport';
      targets: string[];
      expectedByCli: Record<string, FirstImportExpectedState>;
    }
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
  | {
      // PR-G: 라이브 자격증명이 활성 프로필 저장본과 다를 때 (OAuth refresh rotation
      // 등) 사용자에게 재캡처 / 폐기 / 취소 3-옵션을 묻는 dialog.
      //
      // - mode='switch': switch action 전 표시. recapture 후 swap, discard 시
      //   skipPreSwapSnapshot=true 로 swap, cancel 시 swap 미실행.
      // - mode='create': 새 프로필 생성 전 표시. recapture 후 active 프로필에 라이브
      //   저장 → 그 후 새 프로필 생성. discard 는 그냥 생성 (active 저장본 stale 유지).
      kind: 'freshness';
      mode: 'switch' | 'create';
      cliId: string;
      fromProfile: string;
      toProfile: string;
      report: FreshnessReport;
      ambientWarningBlock?: string;
      onRecapture: () => void;
      onDiscard: () => void;
      onCancel: () => void;
      showOnboarding: boolean;
    }
  | { kind: 'busy'; message: string }
  | {
      kind: 'message';
      tone: MessageTone;
      title: string;
      body?: string;
      onDismiss?: () => void;
    };

export interface AppData {
  detection: DetectionResult[];
  activeByCli: Record<string, string | undefined>;
  profilesByCli: Record<string, { name: string; meta?: Profile }[]>;
  firstImportPromptShown: boolean;
  firstFreshnessPromptShown: boolean;
}

export const EMPTY_DATA: AppData = {
  detection: [],
  activeByCli: {},
  profilesByCli: {},
  firstImportPromptShown: false,
  firstFreshnessPromptShown: false
};

export type Action =
  | { type: 'set-data'; data: AppData }
  | { type: 'push'; screen: Screen }
  | { type: 'replace'; screen: Screen }
  | { type: 'pop' }
  | { type: 'home' }
  // PR-G quad-review fix (#3): firstFreshnessPromptShown 의 in-memory 즉시 갱신.
  // file persist (markFirstFreshnessPromptShown) 와 별도 — 같은 세션 내 두 번째
  // dialog 표시 시 onboarding 패널 중복 표시 차단. file 비동기 쓰기와 reducer
  // 갱신을 분리해 race window 제거.
  | { type: 'mark-freshness-prompt-shown' };

export interface State {
  stack: Screen[];
  data: AppData;
}

export const initialState: State = {
  stack: [{ kind: 'loading' }],
  data: EMPTY_DATA
};

export function reducer(state: State, action: Action): State {
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
    case 'mark-freshness-prompt-shown':
      if (state.data.firstFreshnessPromptShown) return state;
      return {
        ...state,
        data: { ...state.data, firstFreshnessPromptShown: true }
      };
  }
}

export function topOf(state: State): Screen {
  // reducer 가 invariant (stack.length >= 1) 를 유지하지만 안전망으로 fallback.
  return state.stack[state.stack.length - 1] ?? { kind: 'home' };
}
