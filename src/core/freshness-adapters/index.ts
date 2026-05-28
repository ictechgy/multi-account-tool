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

import { registerAdapter } from '../freshness.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';

/** 모든 builtin adapter 등록. 호출자에 의해 startup 1회 실행. */
export function registerAllBuiltinAdapters(): void {
  registerAdapter('codex', codexAdapter);
  registerAdapter('gemini', geminiAdapter);
  registerAdapter('opencode', opencodeAdapter);
}

export { codexAdapter, geminiAdapter, opencodeAdapter };
