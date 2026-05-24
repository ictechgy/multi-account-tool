/**
 * cli-defs 단위 테스트.
 *
 * BUILTIN_CLI_DEFS 의 구성 (3 CLI × source 들) 과 findCliDef 의 lookup 동작,
 * 그리고 platform 별로 분기되는 claude source 의 정확성을 검증한다.
 *
 * claude source 의 platform 분기는 모듈 로드 시점에 결정되므로, vi.stubGlobal /
 * vi.spyOn 으로 process.platform 을 바꾸는 방법은 모듈을 다시 import 하지 않는 한
 * 효과가 없다. 따라서 현재 process.platform 기반으로 invariant 만 검증한다.
 */

import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_DEFS, findCliDef } from '../../src/core/cli-defs.js';

describe('BUILTIN_CLI_DEFS', () => {
  it('claude/codex/gemini 3개 정의를 정확히 포함', () => {
    expect(BUILTIN_CLI_DEFS.map((c) => c.id)).toEqual(['claude', 'codex', 'gemini']);
  });

  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex CLI'],
    ['gemini', 'Gemini / Antigravity']
  ])('%s 정의는 사용자 표시 이름 %s 를 가진다', (id, expectedName) => {
    expect(BUILTIN_CLI_DEFS.find((c) => c.id === id)?.name).toBe(expectedName);
  });

  it('claude source 는 1개 (platform 에 따라 keychain 또는 file)', () => {
    const claude = BUILTIN_CLI_DEFS.find((c) => c.id === 'claude');
    expect(claude?.sources).toHaveLength(1);
    const src = claude!.sources[0];
    expect(src.saveAs).toBe('credentials.json');
    if (process.platform === 'darwin') {
      expect(src.type).toBe('keychain');
      if (src.type === 'keychain') expect(src.service).toBe('Claude Code-credentials');
    } else {
      expect(src.type).toBe('file');
      if (src.type === 'file') expect(src.path).toBe('~/.claude/.credentials.json');
    }
  });

  it('codex source 는 1개 file (~/.codex/auth.json)', () => {
    const codex = BUILTIN_CLI_DEFS.find((c) => c.id === 'codex');
    expect(codex?.sources).toEqual([
      { type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }
    ]);
  });

  it('gemini source 는 2개 file (oauth_creds.json + google_accounts.json)', () => {
    const gemini = BUILTIN_CLI_DEFS.find((c) => c.id === 'gemini');
    expect(gemini?.sources).toHaveLength(2);
    expect(gemini?.sources).toEqual([
      { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' },
      { type: 'file', path: '~/.gemini/google_accounts.json', saveAs: 'google_accounts.json' }
    ]);
  });

  it('모든 source 의 saveAs 는 비어있지 않음', () => {
    for (const cli of BUILTIN_CLI_DEFS) {
      for (const src of cli.sources) {
        expect(src.saveAs.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('findCliDef', () => {
  it.each(['claude', 'codex', 'gemini'])('정의된 id %s 는 해당 CliDef 반환', (id) => {
    const def = findCliDef(id);
    expect(def).toBeDefined();
    expect(def?.id).toBe(id);
  });

  it.each([
    ['unknown', '존재하지 않는 id'],
    ['', '빈 문자열'],
    ['CLAUDE', '대소문자 다름 (case-sensitive 검증)'],
    ['claude ', '뒤 공백'],
    [' claude', '앞 공백']
  ])('미정의 id %s (%s) → undefined', (id, _reason) => {
    expect(findCliDef(id)).toBeUndefined();
  });
});
