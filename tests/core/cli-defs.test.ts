/**
 * cli-defs 단위 테스트.
 *
 * 두 가지 영역 검증:
 *  1) BUILTIN_CLI_DEFS 의 구성 (6 CLI, source 정확성, saveAs invariant) +
 *     findCliDef lookup + edge cases (현재 process.platform 기반 invariant 만)
 *  2) claudeSource 의 platform 분기 (darwin → keychain, 그 외 → file) —
 *     vi.stubGlobal('process', ...) + vi.resetModules + dynamic import 로 두 분기 모두 검증
 *     → 모든 CI runner OS 에서 양쪽 분기 회귀 감지 가능 (Quad-review #5 P0 A).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILTIN_CLI_DEFS, findCliDef } from '../../src/core/cli-defs.js';

describe('BUILTIN_CLI_DEFS — 현재 platform 기반 invariant', () => {
  it('claude/codex/gemini/aider/kimi/qwen 6개 정의를 정확히 포함', () => {
    expect(BUILTIN_CLI_DEFS.map((c) => c.id)).toEqual(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen']);
  });

  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex CLI'],
    ['gemini', 'Gemini / Antigravity'],
    ['aider', 'Aider'],
    ['kimi', 'Kimi CLI'],
    ['qwen', 'Qwen Code CLI']
  ])('%s 정의는 사용자 표시 이름 %s 를 가진다', (id, expectedName) => {
    expect(BUILTIN_CLI_DEFS.find((c) => c.id === id)?.name).toBe(expectedName);
  });

  it('claude source 는 1개 (현재 platform 기준)', () => {
    const claude = BUILTIN_CLI_DEFS.find((c) => c.id === 'claude');
    expect(claude?.sources).toHaveLength(1);
    expect(claude!.sources[0].saveAs).toBe('credentials.json');
  });

  it('codex source 는 1개 file (~/.codex/auth.json)', () => {
    const codex = BUILTIN_CLI_DEFS.find((c) => c.id === 'codex');
    expect(codex?.sources).toEqual([
      { type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }
    ]);
  });

  it('gemini source 는 2개 file (oauth_creds.json + google_accounts.json)', () => {
    const gemini = BUILTIN_CLI_DEFS.find((c) => c.id === 'gemini');
    expect(gemini?.sources).toEqual([
      { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' },
      { type: 'file', path: '~/.gemini/google_accounts.json', saveAs: 'google_accounts.json' }
    ]);
  });

  it('aider source 는 1개 file (~/.aider.conf.yml)', () => {
    const aider = BUILTIN_CLI_DEFS.find((c) => c.id === 'aider');
    expect(aider?.sources).toEqual([
      { type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }
    ]);
  });

  it('kimi source 는 1개 file (~/.kimi/config.toml)', () => {
    const kimi = BUILTIN_CLI_DEFS.find((c) => c.id === 'kimi');
    expect(kimi?.sources).toEqual([
      { type: 'file', path: '~/.kimi/config.toml', saveAs: 'kimi.toml' }
    ]);
  });

  it('qwen source 는 2개 file (~/.qwen/settings.json + ~/.qwen/.env)', () => {
    const qwen = BUILTIN_CLI_DEFS.find((c) => c.id === 'qwen');
    expect(qwen?.sources).toEqual([
      { type: 'file', path: '~/.qwen/settings.json', saveAs: 'qwen-settings.json' },
      { type: 'file', path: '~/.qwen/.env', saveAs: 'qwen.env' }
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
  it.each(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen'])('정의된 id %s 는 해당 CliDef 반환', (id) => {
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
  ])('미정의 id %s (%s) → undefined', (id, reason) => {
    expect(findCliDef(id), `${id} (${reason}) 는 미정의여야 함`).toBeUndefined();
  });
});

/**
 * claudeSource 의 platform 분기 검증 — 양 분기 모두 동일 테스트 런에서 실행.
 * vi.stubGlobal 로 process 객체를 platform 만 override 한 사본으로 교체하고,
 * vi.resetModules 로 cli-defs 의 module-load 시점 BUILTIN_CLI_DEFS 평가를 다시 트리거.
 */
describe('claudeSource — platform 별 분기 (양쪽 분기 검증)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('platform=darwin → keychain source (Claude Code-credentials)', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    vi.resetModules();
    const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
    const claude = defs.find((c) => c.id === 'claude');
    const src = claude!.sources[0];
    expect(src.type).toBe('keychain');
    if (src.type === 'keychain') {
      expect(src.service).toBe('Claude Code-credentials');
      expect(src.saveAs).toBe('credentials.json');
    }
  });

  it.each(['linux', 'win32', 'freebsd'])(
    'platform=%s → file source (~/.claude/.credentials.json)',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform });
      vi.resetModules();
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const claude = defs.find((c) => c.id === 'claude');
      const src = claude!.sources[0];
      expect(src.type).toBe('file');
      if (src.type === 'file') {
        expect(src.path).toBe('~/.claude/.credentials.json');
        expect(src.saveAs).toBe('credentials.json');
      }
    }
  );
});
