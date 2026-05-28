/**
 * Freshness adapter registry — startup 시 1회 등록.
 *
 * 등록된 CLI 는 `inspectLiveFreshness` 가 adapter.compare 를 우선 호출. 미등록 CLI 는
 * `fallbackCompare` (화이트리스트 byte-diff). Claude/Goose 등 후속 PR 에서
 * 추가될 adapter 도 본 모듈에서 등록한다 — `freshness.ts` 호출자는 변경 없음.
 *
 * CLI 시작 시 (`src/cli.tsx`) 또는 테스트가 명시 호출. resetAdapters 후 재호출
 * 가능 (idempotent).
 */

import { getAdapter, registerAdapter } from '../freshness.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';

/**
 * 모든 builtin adapter 등록. idempotent (registerAdapter 가 Map.set).
 *
 * 호출 시점:
 *  - `freshness.inspectLiveFreshness` 가 첫 호출 시 dynamic import 로 자동 호출
 *    (lazy init — circular dep 회피, 호출자 부담 0).
 *  - `cli.tsx main()` 도 startup 에서 명시 호출 (옛 호환 경로 — idempotent 무해).
 *
 * test 격리: `resetAdapters()` 후 다음 inspectLiveFreshness 호출이 다시 자동
 * 등록하지 않도록 freshness.ts 의 builtinAdaptersInitialized 플래그가 잠금.
 */
export function registerAllBuiltinAdapters(): void {
  // 이미 등록된 cliId 는 보존 — test mock 또는 향후 user override 가 builtin
  // lazy init 시 덮여지는 사고 방지.
  if (!getAdapter('codex')) registerAdapter('codex', codexAdapter);
  if (!getAdapter('gemini')) registerAdapter('gemini', geminiAdapter);
  if (!getAdapter('opencode')) registerAdapter('opencode', opencodeAdapter);
}

export { codexAdapter, geminiAdapter, opencodeAdapter };
