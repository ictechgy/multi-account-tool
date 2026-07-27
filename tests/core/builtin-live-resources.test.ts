/**
 * builtin 라이브 자격증명 소유권 가드 회귀 테스트.
 *
 * 실측 기반: 아래 SQUATTING_CASES 는 v0.8.1 빌드에서 **전부 ACCEPTED** 였던 입력이다.
 * 가드를 되돌리면 이 표가 그대로 실패한다.
 *
 * 죽은 arm(디렉토리 containment, win-credential)은 **합성 인덱스**로 검증한다 — 실제 builtin
 * 인덱스로 쓰면 goose zone 체크가 먼저 잡아 공허하게 통과하고, 가드를 지워도 초록이 된다.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  buildLiveResourceIndex,
  findLiveResourceCollision,
  liveResourceKeyOf
} from '../../src/core/builtin-live-resources.js';
import { BUILTIN_CLI_DEFS, reservedLiveResources } from '../../src/core/cli-defs.js';
import type { CliDef, Source } from '../../src/core/types.js';

const def = (id: string, ...sources: Source[]): CliDef => ({ id, name: id, sources });
const index = () => buildLiveResourceIndex(BUILTIN_CLI_DEFS, reservedLiveResources());

/** v0.8.1 에서 전부 통과했던 스쿼팅 입력. */
const SQUATTING_CASES: Array<[string, Source]> = [
  ['codex auth file', { type: 'file', path: '~/.codex/auth.json', saveAs: 'x.json' }],
  ['claude credentials file', { type: 'file', path: '~/.claude/.credentials.json', saveAs: 'x.json' }],
  ['gemini oauth file', { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'x.json' }],
  ['grok auth file', { type: 'file', path: '~/.grok/auth.json', saveAs: 'x.json' }],
  ['kimi config file', { type: 'file', path: '~/.kimi/config.toml', saveAs: 'x.json' }],
  ['goose secrets.yaml', { type: 'file', path: '~/.config/goose/secrets.yaml', saveAs: 'x.json' }],
  ['goose provider cache', { type: 'file', path: '~/.config/goose/gemini_oauth/tokens.json', saveAs: 'x.json' }],
  ['goose keychain (account 생략)', { type: 'keychain', service: 'goose', saveAs: 'x.json' }],
  ['goose keychain (정확 일치)', { type: 'keychain', service: 'goose', account: 'secrets', saveAs: 'x.json' }],
  ['claude keychain', { type: 'keychain', service: 'Claude Code-credentials', saveAs: 'x.json' }],
  ['goose os-keyring (타 플랫폼 표기)', { type: 'os-keyring', service: 'goose', account: 'secrets', backend: 'secret-service', saveAs: 'x.json' }],
  ['opencode xdg 기본 경로', { type: 'file', path: '~/.local/share/opencode/auth.json', saveAs: 'x.json' }]
];

describe('builtin live resource 소유권 — 인덱스 자기점검', () => {
  it('인덱스가 비어 있지 않다', () => {
    // 인덱스가 비면 가드는 조용히 아무것도 막지 않는다. 다른 모든 단언보다 먼저 죽어야 한다.
    expect(index().size).toBeGreaterThan(10);
  });

  it('builtin 자신의 source 는 자기 인덱스와 충돌로 보고되지 않는다 (자기 자신은 add 전에 조회)', () => {
    // getAllCliDefs 는 builtin 을 인덱스에 넣고 plugin 만 조회한다. 여기서는 빈 인덱스로
    // builtin 을 조회해 false positive 가 없음을 고정한다.
    const empty = buildLiveResourceIndex([]);
    for (const builtin of BUILTIN_CLI_DEFS) {
      expect(findLiveResourceCollision(builtin, empty), builtin.id).toBeUndefined();
    }
  });
});

describe('builtin live resource 소유권 — 실측 스쿼팅 입력', () => {
  it.each(SQUATTING_CASES)('%s 는 거부된다', (_label, src) => {
    const collision = findLiveResourceCollision(def('squat', src), index());
    expect(collision).toBeDefined();
    expect(collision?.ownerCliId).toBeTruthy();
    expect(collision?.sourceIndex).toBe(0);
  });

  it('대소문자 변형도 거부된다 (darwin/win32)', () => {
    const variant = def('squat', { type: 'file', path: '~/.CODEX/Auth.json', saveAs: 'x.json' });
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(findLiveResourceCollision(variant, index())).toBeDefined();
    } else {
      expect(findLiveResourceCollision(variant, index())).toBeUndefined();
    }
  });

  it('구역 밖 경로와 무관한 keychain 은 통과한다 (과잉 거부 방지)', () => {
    const ok = def('mine',
      { type: 'file', path: '~/.config/myapp/creds.json', saveAs: 'a.json' },
      { type: 'keychain', service: 'myapp', account: 'me', saveAs: 'b.json' }
    );
    expect(findLiveResourceCollision(ok, index())).toBeUndefined();
  });
});

describe('builtin live resource 소유권 — keyring 와일드카드 양방향', () => {
  it('조회가 account 를 생략하면 같은 service 의 특정 account 소유자와 충돌한다', () => {
    // 가장 파괴적인 케이스: account 없는 restore 는 `-s service` 로 builtin 항목을 찾아 삭제한다.
    const idx = buildLiveResourceIndex([def('owner', { type: 'keychain', service: 'svc', account: 'real', saveAs: 'o.json' })]);
    const probe = def('squat', { type: 'keychain', service: 'svc', saveAs: 'x.json' });
    expect(findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('owner');
  });

  it('인덱스가 와일드카드를 소유하면 특정 account 조회도 충돌한다', () => {
    const idx = buildLiveResourceIndex([def('owner', { type: 'keychain', service: 'svc', saveAs: 'o.json' })]);
    const probe = def('squat', { type: 'keychain', service: 'svc', account: 'whatever', saveAs: 'x.json' });
    expect(findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('owner');
  });

  it('keychain 과 os-keyring 은 하나의 identity family 로 비교된다', () => {
    const idx = buildLiveResourceIndex([def('owner', { type: 'keychain', service: 'svc', account: 'a', saveAs: 'o.json' })]);
    const probe = def('squat', { type: 'os-keyring', service: 'svc', account: 'a', backend: 'secret-service', saveAs: 'x.json' });
    expect(findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('owner');
  });
});

describe('builtin live resource 소유권 — 합성 인덱스 (현 릴리스에서 효과 0 인 arm)', () => {
  it('builtin directory source 하위 파일은 거부된다', () => {
    // 실제 builtin directory 2 개는 모두 goose 구역 안이라 zone 체크가 먼저 잡는다.
    // 이 arm 이 실제로 동작하는지는 구역 밖 합성 인덱스로만 검증할 수 있다.
    const idx = buildLiveResourceIndex([
      def('owner', { type: 'directory', path: '~/.config/othercli/tree', saveAs: 'o.tree.json', maxEntries: 8, maxBytes: 1024, maxDepth: 3 })
    ]);
    const exact = def('squat', { type: 'file', path: '~/.config/othercli/tree', saveAs: 'x.json' });
    expect(findLiveResourceCollision(exact, idx)?.ownerCliId).toBe('owner');
  });

  it('win-credential 은 targetName + account 로 비교된다 (builtin 은 아직 0 개)', () => {
    const idx = buildLiveResourceIndex([
      def('owner', { type: 'win-credential', targetName: 'tgt', account: 'acct', credentialType: 'generic', persist: 'local-machine', saveAs: 'o.json' })
    ]);
    const probe = def('squat', { type: 'win-credential', targetName: 'TGT', account: 'ACCT', credentialType: 'generic', persist: 'local-machine', saveAs: 'x.json' });
    expect(findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('owner');
    // builtin 에 win-credential source 가 없다는 사실 자체를 고정한다 — 생기면 이 단언이 깨져
    // arm 라벨("현 릴리스 효과 0")을 갱신하게 만든다.
    expect(BUILTIN_CLI_DEFS.flatMap(d => d.sources).some(s => s.type === 'win-credential')).toBe(false);
  });

  it('env-secret 은 소유권 키를 갖지 않는다 (런타임 차단 중)', () => {
    const src: Source = {
      type: 'env-secret', envName: 'X', saveAs: 'x.json',
      backend: { kind: 'linux-secret-service', handle: 'h' }, accountKey: 'a'
    };
    expect(liveResourceKeyOf(src)).toBeNull();
  });
});

describe('builtin live resource 소유권 — 인덱스는 플랫폼/env 에 조건부여선 안 된다', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('GOOSE_DISABLE_KEYRING 이 설정돼도 goose keyring 리소스는 계속 예약된다', async () => {
    // mat 자신의 env 로만 keyring 을 끄면 goose 는 여전히 keyring 을 쓴다 — 인덱스에서
    // 사라지면 같은 머신에서 라이브 스쿼팅이 가능해진다.
    vi.stubEnv('GOOSE_DISABLE_KEYRING', '1');
    vi.resetModules();
    const cliDefs = await import('../../src/core/cli-defs.js');
    const brs = await import('../../src/core/builtin-live-resources.js');
    const idx = brs.buildLiveResourceIndex(cliDefs.BUILTIN_CLI_DEFS, cliDefs.reservedLiveResources());
    const probe: CliDef = { id: 'squat', name: 'S', sources: [{ type: 'keychain', service: 'goose', account: 'secrets', saveAs: 'x.json' }] };
    expect(brs.findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('goose');
  });

  it('XDG_DATA_HOME 이 설정돼도 opencode 의 xdg 기본 경로는 계속 예약된다', async () => {
    vi.stubEnv('XDG_DATA_HOME', '/tmp/relocated-xdg');
    vi.resetModules();
    const cliDefs = await import('../../src/core/cli-defs.js');
    const brs = await import('../../src/core/builtin-live-resources.js');
    const idx = brs.buildLiveResourceIndex(cliDefs.BUILTIN_CLI_DEFS, cliDefs.reservedLiveResources());
    const probe: CliDef = { id: 'squat', name: 'S', sources: [{ type: 'file', path: '~/.local/share/opencode/auth.json', saveAs: 'x.json' }] };
    expect(brs.findLiveResourceCollision(probe, idx)?.ownerCliId).toBe('opencode');
    // 재배치된 경로도 함께 예약돼야 한다.
    const relocated: CliDef = { id: 'squat2', name: 'S', sources: [{ type: 'file', path: '/tmp/relocated-xdg/opencode/auth.json', saveAs: 'x.json' }] };
    expect(brs.findLiveResourceCollision(relocated, idx)?.ownerCliId).toBe('opencode');
  });
});
