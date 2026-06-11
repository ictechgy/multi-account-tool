/**
 * cli-defs 단위 테스트.
 *
 * 두 가지 영역 검증:
 *  1) BUILTIN_CLI_DEFS 의 구성 (8 CLI, source 정확성, saveAs invariant) +
 *     findCliDef lookup + edge cases (현재 process.platform 기반 invariant 만)
 *  2) claudeSource 의 platform 분기 (darwin → keychain, 그 외 → file) —
 *     vi.stubGlobal('process', ...) + vi.resetModules + dynamic import 로 두 분기 모두 검증
 *     → 모든 CI runner OS 에서 양쪽 분기 회귀 감지 가능 (Quad-review #5 P0 A).
 *
 *  주의: OpenCode 는 npm `xdg-basedir` 사용 — OS 무관 단일 XDG 경로 (`~/.local/share/opencode/auth.json`)
 *  이므로 platform 분기 없음 (PR #28 quad-review 정정 사항).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { BUILTIN_CLI_DEFS, findCliDef } from '../../src/core/cli-defs.js';
import { expandTilde } from '../../src/core/paths.js';

function expectedOpenCodeDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : '~/.local/share';
  return join(dataHome, 'opencode');
}

describe('BUILTIN_CLI_DEFS — 현재 platform 기반 invariant', () => {
  it('claude/codex/gemini/aider/kimi/qwen/crush/opencode/goose 9개 정의를 정확히 포함', () => {
    expect(BUILTIN_CLI_DEFS.map((c) => c.id)).toEqual(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen', 'crush', 'opencode', 'goose']);
  });

  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex CLI'],
    ['gemini', 'Gemini / Antigravity'],
    ['aider', 'Aider'],
    ['kimi', 'Kimi CLI'],
    ['qwen', 'Qwen Code CLI'],
    ['crush', 'Crush'],
    ['opencode', 'OpenCode'],
    ['goose', 'Goose']
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

  it('crush source 는 2개 file (~/.config/crush + ~/.local/share/crush)', () => {
    const crush = BUILTIN_CLI_DEFS.find((c) => c.id === 'crush');
    expect(crush?.sources).toEqual([
      { type: 'file', path: '~/.config/crush/crush.json', saveAs: 'crush-config.json' },
      { type: 'file', path: '~/.local/share/crush/crush.json', saveAs: 'crush-data.json' }
    ]);
  });

  it('opencode source 는 1개 file (~/.local/share/opencode/auth.json, OS 공통) + EXPERIMENTAL session', () => {
    // OpenCode 는 npm xdg-basedir 사용 → macOS/Linux/BSD/Windows 모두 동일 경로.
    const opencode = BUILTIN_CLI_DEFS.find((c) => c.id === 'opencode');
    const expectedRoot = expectedOpenCodeDataRoot();
    expect(opencode?.sources).toEqual([
      { type: 'file', path: join(expectedRoot, 'auth.json'), saveAs: 'opencode-auth.json' }
    ]);
    expect(opencode?.session).toEqual({
      roots: [
        expect.objectContaining({
          env: 'XDG_DATA_HOME',
          base: expectedRoot,
          envSubdir: 'opencode'
        })
      ]
    });
    expect(opencode?.session?.roots[0].warning).toContain('EXPERIMENTAL OpenCode');
    expect(opencode?.session?.roots[0].warning).toContain('XDG_DATA_HOME');
  });

  it('goose source 수는 현재 platform 에 따라 darwin=3(keychain) / linux=3(os-keyring) / 그 외=2(file)', () => {
    // 본 테스트는 process.platform 그대로 사용. 양쪽 분기 상세는 아래 별도 describe 에서 stub.
    const goose = BUILTIN_CLI_DEFS.find((c) => c.id === 'goose');
    expect(goose).toBeDefined();
    if (process.platform === 'darwin') {
      expect(goose!.sources).toHaveLength(3);
      expect(goose!.sources[0].type).toBe('keychain');
    } else if (process.platform === 'linux') {
      expect(goose!.sources).toHaveLength(3);
      expect(goose!.sources[0].type).toBe('os-keyring');
      expect(goose!.sources.slice(1).every((s) => s.type === 'file')).toBe(true);
    } else {
      expect(goose!.sources).toHaveLength(2);
      expect(goose!.sources.every((s) => s.type === 'file')).toBe(true);
    }
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
  it.each(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen', 'crush', 'opencode', 'goose'])('정의된 id %s 는 해당 CliDef 반환', (id) => {
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

/**
 * OpenCode 의 경로는 platform 분기 없음 — npm `xdg-basedir` 의 XDG 표준 (`~/.local/share`) 만 사용.
 * 전체 platform 에서 `~/.local/share/opencode/auth.json` 이 동일하게 적용되는지 검증.
 */
describe('opencode source — platform 무관 단일 경로 (xdg-basedir 동작)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['darwin', 'linux', 'win32', 'freebsd'])(
    'platform=%s → ~/.local/share/opencode/auth.json (OS 공통)',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform });
      vi.resetModules();
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const opencode = defs.find((c) => c.id === 'opencode');
      const src = opencode!.sources[0];
      const expectedRoot = expectedOpenCodeDataRoot();
      expect(src.type).toBe('file');
      if (src.type === 'file') {
        expect(src.path).toBe(join(expectedRoot, 'auth.json'));
        expect(src.saveAs).toBe('opencode-auth.json');
      }
      expect(opencode!.session!.roots[0]).toMatchObject({
        env: 'XDG_DATA_HOME',
        base: expectedRoot,
        envSubdir: 'opencode'
      });
    }
  );

  it('XDG_DATA_HOME 설정 시 import 시점에 source/session base 가 해당 data root 를 따른다', async () => {
    // BUILTIN_CLI_DEFS 는 module load 시점 const 배열이라 env 변경 후 vi.resetModules + dynamic import 필요.
    vi.stubGlobal('process', {
      ...process,
      env: { ...process.env, XDG_DATA_HOME: '/tmp/mat-xdg-data' }
    });
    vi.resetModules();
    const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
    const opencode = defs.find((c) => c.id === 'opencode')!;
    const expectedRoot = expectedOpenCodeDataRoot({ XDG_DATA_HOME: '/tmp/mat-xdg-data' });
    expect(opencode.sources).toEqual([
      { type: 'file', path: join(expectedRoot, 'auth.json'), saveAs: 'opencode-auth.json' }
    ]);
    expect(opencode.session!.roots[0]).toMatchObject({
      env: 'XDG_DATA_HOME',
      base: expectedRoot,
      envSubdir: 'opencode'
    });
  });
});

/**
 * Goose 의 platform 분기 — Block 의 오픈소스 AI agent.
 *  - darwin: macOS Keychain (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml`
 *    + `~/.config/goose/config.yaml` 의 3-source.
 *  - linux: os-keyring (service `goose`, account `secrets`, backend `secret-service`) + 2 yaml 의
 *    3-source (PR-4 — Goose 의 기본 secret-service 백엔드를 secret-tool 로 swap). macOS 와 동형.
 *  - 그 외 (win32/freebsd): yaml 2-source 만 (Windows Credential Manager 는 별도 후속 PR-W).
 *
 * PR-A 의 `KeychainSource.account` 필드를 사용하는 첫 builtin — service `goose` 가 generic 단어라
 * scope 가 필수. account 누락 시 (PR #29 closed 사유) wrong-entry 위험.
 */
describe('gooseSources — platform 별 분기 (multi-source + account scope 검증)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // 헬퍼: env 에서 GOOSE_DISABLE_KEYRING 제거(미설정) 후 platform stub.
  const stubPlatform = (platform: string, gooseDisableKeyring?: string) => {
    const env = { ...process.env };
    delete env.GOOSE_DISABLE_KEYRING;
    if (gooseDisableKeyring !== undefined) env.GOOSE_DISABLE_KEYRING = gooseDisableKeyring;
    vi.stubGlobal('process', { ...process, platform, env });
  };

  const YAML_SOURCES = [
    { type: 'file', path: '~/.config/goose/secrets.yaml', saveAs: 'goose-secrets.yaml' },
    { type: 'file', path: '~/.config/goose/config.yaml', saveAs: 'goose-config.yaml' }
  ];

  it('platform=darwin (기본 keyring) → keychain(service=goose, account=secrets) + secrets.yaml + config.yaml', async () => {
    stubPlatform('darwin');
    vi.resetModules();
    const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
    const goose = defs.find((c) => c.id === 'goose');
    expect(goose!.sources).toEqual([
      { type: 'keychain', service: 'goose', account: 'secrets', saveAs: 'goose-keyring.json' },
      ...YAML_SOURCES
    ]);
  });

  it('platform=linux (기본 keyring) → os-keyring(service=goose, account=secrets, secret-service) + secrets.yaml + config.yaml', async () => {
    // GOOSE_DISABLE_KEYRING 미설정 = Goose 기본 secret-service(keyring) 가정 → os-keyring 포함.
    stubPlatform('linux');
    vi.resetModules();
    const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
    const goose = defs.find((c) => c.id === 'goose');
    expect(goose!.sources).toEqual([
      {
        type: 'os-keyring',
        service: 'goose',
        account: 'secrets',
        backend: 'secret-service',
        saveAs: 'goose-keyring.json'
      },
      ...YAML_SOURCES
    ]);
  });

  // Goose 의 GOOSE_DISABLE_KEYRING env 시맨틱은 presence-only (`env::var(..).is_ok()`,
  // base.rs) — 값과 무관하게 **존재하면** file backend 다. mat 도 동일하게 맞춰
  // (gooseUsesFileBackend = env != null) 값 무관하게 os-keyring 을 생략한다. 0/false/빈
  // 문자열도 Goose 가 file backend 로 보므로, 이때 os-keyring 을 포함하면 stale keyring
  // 을 swap 하는 wrong-account 위험이 있다 (#59 quad-review HIGH, Goose 소스로 검증).
  it.each([
    ['linux', '1'], ['linux', 'true'], ['linux', 'YES'],
    ['linux', '0'], ['linux', 'false'], ['linux', ''],
    ['darwin', '1'], ['darwin', '0'], ['darwin', '']
  ])(
    'platform=%s + GOOSE_DISABLE_KEYRING=%j (존재=file backend) → keyring source 생략, yaml 2-source',
    async (platform, flag) => {
      stubPlatform(platform, flag);
      vi.resetModules();
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const goose = defs.find((c) => c.id === 'goose');
      expect(goose!.sources).toEqual(YAML_SOURCES);
    }
  );

  it.each(['win32', 'freebsd'])(
    'platform=%s → file source 2개 (secrets.yaml + config.yaml, keyring 미포함)',
    async (platform) => {
      stubPlatform(platform);
      vi.resetModules();
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const goose = defs.find((c) => c.id === 'goose');
      expect(goose!.sources).toEqual(YAML_SOURCES);
    }
  );
});

describe('session 메타데이터 (PR-S1 — 세션 격리)', () => {
  const find = (id: string) => BUILTIN_CLI_DEFS.find((c) => c.id === id)!;

  it('codex: session.roots 1개 (CODEX_HOME / ~/.codex), share=[config.toml] (issue #63-3)', () => {
    // config.toml 은 secret-free read-mostly 설정이라 base 공유 허용 (토큰은 auth.json 에 분리).
    expect(find('codex').session).toEqual({
      roots: [{ env: 'CODEX_HOME', base: '~/.codex', share: ['config.toml'] }]
    });
  });

  it('qwen: session.roots 1개 (QWEN_HOME / ~/.qwen), share 없음(혼재)', () => {
    expect(find('qwen').session).toEqual({
      roots: [{ env: 'QWEN_HOME', base: '~/.qwen' }]
    });
  });

  it('kimi: session.roots 1개 (KIMI_SHARE_DIR / ~/.kimi), share 없음(A=B)', () => {
    expect(find('kimi').session).toEqual({
      roots: [{ env: 'KIMI_SHARE_DIR', base: '~/.kimi' }]
    });
  });

  it('crush: session.roots 2개 (CRUSH_GLOBAL_CONFIG/DATA), share 없음', () => {
    expect(find('crush').session).toEqual({
      roots: [
        { env: 'CRUSH_GLOBAL_CONFIG', base: '~/.config/crush' },
        { env: 'CRUSH_GLOBAL_DATA', base: '~/.local/share/crush' }
      ]
    });
  });

  it('claude: session.roots 1개 (CLAUDE_CONFIG_DIR / ~/.claude), share 없음 (PR-2)', () => {
    // base 직속 자격증명(linux file source)이라 envSubdir 불필요. settings.json 은 자격증명+config
    // 혼재라 share 금지(세션 ephemeral). platform 무관 — session 은 unconditional 정의.
    expect(find('claude').session).toEqual({
      roots: [{ env: 'CLAUDE_CONFIG_DIR', base: '~/.claude' }]
    });
  });

  it('gemini: session.roots 1개 (GEMINI_CLI_HOME / ~/.gemini, envSubdir=.gemini), share 없음 (PR-3)', () => {
    // GEMINI_CLI_HOME 은 .gemini 의 부모를 가리킨다(소스 실측) → envSubdir 로 cred 루트를 한 단계
    // 내린다. settings.json write-back 가능성 → share=∅(통째 ephemeral). 2-cred(oauth_creds +
    // google_accounts)는 기존 runRecaptureLocked 가 원자 그룹 처리.
    expect(find('gemini').session).toEqual({
      roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini' }]
    });
  });

  it('opencode: EXPERIMENTAL session.roots 1개 (XDG_DATA_HOME / ~/.local/share/opencode, envSubdir=opencode)', () => {
    const expectedRoot = expectedOpenCodeDataRoot();
    expect(find('opencode').session?.roots).toHaveLength(1);
    expect(find('opencode').session!.roots[0]).toMatchObject({
      env: 'XDG_DATA_HOME',
      base: expectedRoot,
      envSubdir: 'opencode'
    });
    expect(find('opencode').session!.roots[0].warning).toContain('EXPERIMENTAL OpenCode');
  });

  it.each(['aider', 'goose'])(
    '%s: session 미지정(세션 격리 미지원)',
    (id) => {
      expect(find(id).session).toBeUndefined();
    }
  );

  it('share allow-list 회귀 가드: codex root 는 config.toml 1개, 그 외 모든 root 는 비어있음', () => {
    // codex 의 config.toml 은 secret-free 검증 완료(issue #63-3) — 유일한 비-∅ share.
    // 나머지 CLI root 에 새 share 항목을 추가할 때는 secret-free 여부를 먼저 검증하고 여기에 명시한다.
    for (const def of BUILTIN_CLI_DEFS) {
      for (const root of def.session?.roots ?? []) {
        if (def.id === 'codex' && root.env === 'CODEX_HOME') {
          expect(root.share).toEqual(['config.toml']);
        } else {
          expect(root.share ?? []).toEqual([]);
        }
      }
    }
  });

  it('정적 invariant: 모든 file 자격증명 source 는 정확히 1개 root 의 base 직속(rel 에 path 구분자 없음)', () => {
    // 각 session-capable CLI 의 file source path 가 어느 root base 의 직속 자식인지.
    // crush 2-root 가 서로 prefix 가 아니라 각 crush.json 이 정확히 1 root 에 귀속됨도 함께 검증.
    //
    // 비-file source(claude macOS=keychain 등)는 platform-split 으로 session 정의는 있으나 격리
    // 불가다 — planSession 이 런타임에 명시 throw 한다(아래 'planSession / claude' describe). 따라서
    // 본 정적 invariant 는 **file source 만** base 직속을 검증하고, 비-file source 는 건너뛴다.
    const rel = (base: string, p: string) => {
      const b = expandTilde(base).replace(/\/+$/, '') + '/';
      const f = expandTilde(p);
      return f.startsWith(b) ? f.slice(b.length) : null;
    };
    // 명시적 면제(code 리뷰 MEDIUM-1): session 정의가 있는데 현 platform 에서 file source 가 0개인
    // def 는 keychain/os-keyring 전용(claude macOS)이라 의도된 미지원이다(planSession 런타임 throw).
    // 그 외 def 가 file source 0개로 이 invariant 를 vacuous 통과하는 것을 막기 위해, 면제 목록에
    // 없으면 file source ≥1 을 명시 강제한다 — 향후 session 정의를 추가하는 def 의 회귀 가드.
    const KEYCHAIN_ONLY_CAPABLE = new Set(['claude']); // platform 에 따라 keychain-only 가능
    for (const def of BUILTIN_CLI_DEFS) {
      if (!def.session) continue;
      const fileSources = def.sources.filter((s): s is Extract<typeof s, { type: 'file' }> => s.type === 'file');
      if (fileSources.length === 0) {
        expect(KEYCHAIN_ONLY_CAPABLE.has(def.id)).toBe(true); // 의도된 keychain-only 미지원만 허용
        continue;
      }
      for (const src of fileSources) {
        const matches = def.session.roots.filter((r) => {
          const r2 = rel(r.base, src.path);
          return r2 !== null && !r2.includes('/');
        });
        expect(matches).toHaveLength(1); // 정확히 1 root, 직속
      }
    }
  });
});
