/**
 * Gate 2(I/O 시점 게이트) + goose 하드닝 identity 재키잉 회귀 테스트.
 *
 * Gate 1(`credential-alias-bypass.test.ts`)은 **선언**을 심사한다. 여기서는 그 다음 두 가지를 고정한다:
 *
 * 1. **로드 이후에 생긴 별칭** — Gate 1 을 통과한 def 가 나중에 별칭이 되어도 I/O 가 거부된다.
 * 2. **완화가 실제로 작동한다** — `~/.config` 를 symlink 로 관리하는 사용자의 goose provider
 *    캐시 read/write 가 성공한다. v0.8.2 에서는 `unsafe Goose provider cache parent` 로 실패했다.
 *
 * (2)는 **보호를 넓히는 변경이 아니라 푸는 변경**이라 특히 회귀 고정이 필요하다. 그래서
 * "비-private 조상은 여전히 거부된다"(I7)를 같은 파일에 함께 둔다 — 완화가 무결성 검사까지
 * 지워버리면 그 테스트가 빨개진다.
 *
 * 실제 파일시스템을 쓴다(mock 아님). symlink 시맨틱이 판정 대상이므로 mock 은 무의미하다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { resetCliDefCache } from '../../src/core/cli-defs.js';
import { readSource, removeSource, sourceExists, writeSource } from '../../src/core/sources.js';
import type { DirectorySource, FileSource } from '../../src/core/types.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const REAL_TOKEN = 'REAL-CODEX-TOKEN';

const file = (path: string): FileSource => ({ type: 'file', path, saveAs: 'x.json' });
const gooseTokens = file('~/.config/goose/gemini_oauth/tokens.json');
const gooseDir: DirectorySource = {
  type: 'directory', path: '~/.config/goose/githubcopilot',
  saveAs: 'd.json', maxEntries: 8, maxBytes: 4096, maxDepth: 3
};

async function writePlugin(home: string, id: string, path: string): Promise<void> {
  const dir = join(home, '.multi-account-tool', 'cli-defs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({ id, name: id, sources: [{ type: 'file', path, saveAs: 'x.json' }] }));
}

async function loadedIds(): Promise<string[]> {
  resetCliDefCache();
  const { getAllCliDefs } = await import('../../src/core/cli-defs.js');
  return getAllCliDefs().map(d => d.id);
}

/** `~/.config` 를 `~/dotfiles/config` 로 관리하는 stow/chezmoi 사용자 환경. */
async function symlinkDotfilesConfig(home: string): Promise<string> {
  const real = join(home, 'dotfiles', 'config');
  await fs.mkdir(real, { recursive: true });
  // **명시 mode 필수.** umask 002(Fedora/RHEL 의 UPG 기본, 다수 CI 이미지)에서는 0775 가 되어
  // group-writable 조상이 되고, 같은 PR 이 문서화한 "비-private 조상 거부" 에 걸려 완화 테스트가
  // 거짓 실패한다. `recursive: true` 는 중간 디렉토리에 mode 를 적용하지 않으므로 따로 준다.
  await fs.chmod(join(home, 'dotfiles'), 0o700);
  await fs.chmod(real, 0o700);
  await fs.symlink(real, join(home, '.config'));
  return real;
}

describe('Gate 2 — 로드 이후에 생긴 별칭은 I/O 시점에 거부된다', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex', 'auth.json'), REAL_TOKEN);
    // 로드 시점에는 별칭이 아닌 자기 디렉토리 — Gate 1 을 정당하게 통과한다.
    await fs.mkdir(join(tmp.home, 'myapp'), { recursive: true });
    await fs.writeFile(join(tmp.home, 'myapp', 'auth.json'), 'PLUGIN-OWN');
    await writePlugin(tmp.home, 'later', '~/myapp/auth.json');
  });

  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  /** 로드 후 `~/myapp` 를 `~/.codex` 로 바꿔치기한다. */
  async function swapInAlias(): Promise<void> {
    expect(await loadedIds()).toContain('later');   // 전제: Gate 1 은 통과했다
    await fs.rm(join(tmp.home, 'myapp'), { recursive: true });
    await fs.symlink(join(tmp.home, '.codex'), join(tmp.home, 'myapp'));
  }

  const src = file('~/myapp/auth.json');

  it('readSource 가 실제 토큰을 반환하지 않는다', async () => {
    await swapInAlias();
    await expect(readSource(src)).rejects.toThrow(/unsafe credential resource/);
  });

  it('sourceExists / writeSource / removeSource 도 모두 거부되고 실제 파일은 그대로다', async () => {
    await swapInAlias();
    await expect(sourceExists(src)).rejects.toThrow(/unsafe credential resource/);
    await expect(writeSource(src, 'ATTACKER')).rejects.toThrow(/unsafe credential resource/);
    await expect(removeSource(src)).rejects.toThrow(/unsafe credential resource/);
    expect(await fs.readFile(join(tmp.home, '.codex', 'auth.json'), 'utf8')).toBe(REAL_TOKEN);
  });

  it('거부 메시지에 경로가 들어가지 않는다 (detector/doctor 를 통해 화면까지 도달한다)', async () => {
    await swapInAlias();
    // 메시지는 고정 문자열이어야 한다 — HOME 절대경로도, 해석된 실물 경로도, 선언 표기도 없다.
    const err = await readSource(src).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain(tmp.home);
    expect(message).not.toContain('myapp');
    expect(message).not.toContain('.codex');
  });
});

describe('Gate 2 — 정상 접근은 막지 않는다', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); resetCliDefCache(); });
  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  it('builtin 정경 경로 접근은 통과한다 (면제는 객체 identity 가 아니라 정경 표기로 판정한다)', async () => {
    // 같은 경로를 가리키는 **새로 만든** source 객체다. 객체 identity 로 면제했다면 여기서 막힌다.
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex', 'auth.json'), REAL_TOKEN);
    expect(await readSource(file('~/.codex/auth.json'))).toBe(REAL_TOKEN);
  });

  it('구역 밖 자기 경로는 통과한다', async () => {
    await fs.mkdir(join(tmp.home, '.config', 'myapp'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.config', 'myapp', 'creds.json'), 'MINE');
    expect(await readSource(file('~/.config/myapp/creds.json'))).toBe('MINE');
  });

  it('부재 source 는 오늘과 동일하게 조용히 skip 된다 (AC6)', async () => {
    expect(await readSource(file('~/.config/myapp/notyet.json'))).toBeNull();
    expect(await sourceExists(file('~/.config/myapp/notyet.json'))).toBe(false);
  });
});

describe('goose 하드닝 — dotfiles 사용자 완화 (AC4)', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); resetCliDefCache(); });
  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  it('`~/.config` 가 symlink 여도 provider 캐시를 쓰고 읽을 수 있다', async () => {
    // v0.8.2 에서는 이 테스트가 `unsafe Goose provider cache parent` 로 실패했다.
    const real = await symlinkDotfilesConfig(tmp.home);
    await writeSource(gooseTokens, 'GOOSE-TOKEN');
    expect(await readSource(gooseTokens)).toBe('GOOSE-TOKEN');
    // 바이트가 **해석된 실물 위치**에 놓인다 — 완화의 관측 가능한 결과다(§CHANGELOG Changed).
    expect(await fs.readFile(join(real, 'goose', 'gemini_oauth', 'tokens.json'), 'utf8')).toBe('GOOSE-TOKEN');
  });

  it('`~/.config` 가 symlink 여도 provider 디렉토리 source 가 동작한다', async () => {
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'goose', 'githubcopilot'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(real, 'goose', 'githubcopilot', 'hosts.json'), 'COPILOT');
    expect(await sourceExists(gooseDir)).toBe(true);
    expect(await readSource(gooseDir)).toContain('hosts.json');
  });

  it('removeSource 도 symlink 환경에서 동작한다 (롤백 경로)', async () => {
    await symlinkDotfilesConfig(tmp.home);
    await writeSource(gooseTokens, 'GOOSE-TOKEN');
    await removeSource(gooseTokens);
    expect(await sourceExists(gooseTokens)).toBe(false);
  });

  it('자격증명 **파일 자신**이 symlink 면 계속 거부된다 (완화는 조상에만 적용된다)', async () => {
    // 리뷰가 잡은 회귀. 경로를 전면 해석하면 leaf symlink 까지 따라가, 실측으로 공격자 파일을
    // 읽고 **피해자 토큰을 공격자 파일에 썼다**. v0.8.2 가 막던 것을 완화가 함께 지워버렸다.
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'goose', 'gemini_oauth'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(tmp.home, 'evil'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(tmp.home, 'evil', 'planted.json'), 'ATTACKER-PLANTED');
    await fs.symlink(join(tmp.home, 'evil', 'planted.json'), join(real, 'goose', 'gemini_oauth', 'tokens.json'));

    await expect(readSource(gooseTokens)).rejects.toThrow(/unsafe Goose provider cache file/);
    await expect(writeSource(gooseTokens, 'VICTIM-TOKEN')).rejects.toThrow(/unsafe Goose provider cache file/);
    // 공격자 파일이 피해자 토큰으로 덮이지 않았다는 것까지 단정한다 — throw 만으로는 부족하다.
    expect(await fs.readFile(join(tmp.home, 'evil', 'planted.json'), 'utf8')).toBe('ATTACKER-PLANTED');
  });

  it('디렉토리 source **루트 자신**이 symlink 면 계속 거부된다', async () => {
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'goose'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(tmp.home, 'evildir'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(tmp.home, 'evildir', 'x.json'), 'ATTACKER-DIR');
    await fs.symlink(join(tmp.home, 'evildir'), join(real, 'goose', 'githubcopilot'));
    await expect(readSource(gooseDir)).rejects.toThrow(/symlink/);
  });

  it('완화 이후에도 **비-private 조상**은 계속 거부된다 (I7 — 완화가 무결성 검사를 지우지 않았다)', async () => {
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'goose'), { recursive: true });
    await fs.chmod(join(real, 'goose'), 0o777);
    await expect(readSource(gooseTokens)).rejects.toThrow(/unsafe Goose provider cache parent/);
  });
});

describe('예약 리소스 — 등록 경로가 갈라지면 안 된다', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); resetCliDefCache(); });
  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  /**
   * `~/.claude/.credentials.json` 은 darwin 에서 **예약 전용** 리소스다(builtin 은 keychain 을 쓴다).
   * `reserve()` 가 어휘 키만 등록하던 동안, `~/.claude` 를 symlink 로 관리하면 해석 키가 어디에도
   * 없어서 plugin 이 **해석된 정경 표기**를 직접 선언하면 두 게이트를 모두 통과하고 진짜
   * 자격증명을 읽었다(실측). `nlink === 1` 이라 inode 폴백도 건너뛰어 아무것도 잡지 못했다.
   */
  async function symlinkedClaudeDir(home: string): Promise<string> {
    const real = join(home, 'dotfiles', 'claude');
    await fs.mkdir(real, { recursive: true, mode: 0o700 });
    await fs.chmod(join(home, 'dotfiles'), 0o700);   // 중간 디렉토리는 mode 가 적용되지 않는다
    await fs.writeFile(join(real, '.credentials.json'), 'REAL-CLAUDE-CREDS');
    await fs.symlink(real, join(home, '.claude'));
    return real;
  }

  it('Gate 1 — 예약 리소스의 해석된 정경 표기를 선언한 plugin 은 거부된다', async () => {
    const real = await symlinkedClaudeDir(tmp.home);
    await writePlugin(tmp.home, 'resquat', join(real, '.credentials.json'));
    expect(await loadedIds()).not.toContain('resquat');
  });

  it('Gate 2 — 같은 표기로의 I/O 도 거부되고 진짜 자격증명이 새지 않는다', async () => {
    const real = await symlinkedClaudeDir(tmp.home);
    await expect(readSource(file(join(real, '.credentials.json')))).rejects.toThrow(/unsafe credential resource/);
  });

  it('builtin 자신의 선언 표기 접근은 계속 통과한다 (면제가 좁아졌지만 정상 경로는 막지 않는다)', async () => {
    await symlinkedClaudeDir(tmp.home);
    expect(await readSource(file('~/.claude/.credentials.json'))).toBe('REAL-CLAUDE-CREDS');
  });
});

describe('goose 예약구역 — 별칭으로 뚫리지 않는다', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); resetCliDefCache(); });
  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  it('별칭 표기로 예약구역 안을 선언하면 거부된다', async () => {
    // 예약구역은 "builtin 이 지금 쓰는 경로" 보다 넓다. 그래서 소유권 검사만으로는 안 잡히고
    // 구역 판정이 identity 를 봐야 잡힌다.
    await fs.mkdir(join(tmp.home, '.config', 'goose', 'newprovider'), { recursive: true });
    await fs.symlink(join(tmp.home, '.config', 'goose', 'newprovider'), join(tmp.home, 'gsalias'));
    await writePlugin(tmp.home, 'zonealias', '~/gsalias/tokens.json');
    expect(await loadedIds()).not.toContain('zonealias');
  });

  it('해석된 정경 표기를 **직접** 선언해도 거부된다 (구역 루트도 해석해야 닫힌다)', async () => {
    // dotfiles 사용자의 진짜 구역은 `~/dotfiles/config/goose/` 다. 대상만 해석하는 구현은
    // 이 입력을 놓친다 — 이미 해석형이라 해석해도 그대로이기 때문이다.
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'goose', 'newprovider'), { recursive: true });
    await writePlugin(tmp.home, 'zonedirect', `${real}/goose/newprovider/tokens.json`);
    expect(await loadedIds()).not.toContain('zonedirect');
  });

  it('로드 **이후** 구역 안으로 별칭된 source 는 I/O 시점에 거부된다', async () => {
    // 예약구역은 소유권보다 넓다 — 구역 안이지만 어떤 builtin source 도 아닌 경로가 있고,
    // 그런 경로는 소유권 검사에 걸리지 않는다. 로드 시점에만 구역을 보면 여기가 뚫린다.
    await fs.mkdir(join(tmp.home, '.config', 'goose', 'newprovider'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(tmp.home, '.config', 'goose', 'newprovider', 'tokens.json'), 'GOOSE-NEW');
    await fs.symlink(join(tmp.home, '.config', 'goose', 'newprovider'), join(tmp.home, 'gsalias'));
    await expect(readSource(file('~/gsalias/tokens.json'))).rejects.toThrow(/unsafe credential resource/);
  });

  it('구역 루트를 해석할 수 없어도 무관한 파일 I/O 를 막지 않는다', async () => {
    // 이 판정은 리뷰 도중 두 번 뒤집혔다. 최종 근거:
    //
    // 대상이 해석됐는데 구역 루트가 해석되지 않는다면, 구역 **안**의 어떤 경로도 해석될 수 없다
    // (같은 깨진 구성요소를 지나야 한다). 즉 그 조합 자체가 대상이 구역 밖임을 증명한다.
    // 한때 여기서 거부하도록 했더니, 이 판정이 Gate 2 의 모든 일반 파일 경로에 쓰이는 탓에
    // `~/.config` 가 ELOOP 이면 goose 와 무관한 파일 읽기까지 막혔다 — 도달 불가능한 fail-open 을
    // 닫으려다 실재하는 가용성 회귀를 얻은 것이다.
    await fs.mkdir(join(tmp.home, 'myapp'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(tmp.home, 'myapp', 'creds.json'), 'MINE');
    await fs.symlink(join(tmp.home, '.config'), join(tmp.home, '.config'));   // ELOOP
    expect(await readSource(file('~/myapp/creds.json'))).toBe('MINE');
  });

  it('구역 루트를 해석할 수 없어도 어휘적으로 구역 안인 경로는 계속 거부된다', async () => {
    // 완화의 반대쪽 경계. 어휘 판정이 먼저 걸러내므로 루트 해석과 무관하게 유지된다.
    const { classifyGoosePathByIdentity } = await import('../../src/core/goose-provider-cache.js');
    await fs.symlink(join(tmp.home, '.config'), join(tmp.home, '.config'));   // ELOOP
    expect(classifyGoosePathByIdentity('~/.config/goose/newprovider/tokens.json')).toBe('reserved-nonadmitted');
  });

  it('구역 밖 dotfiles 경로는 통과한다 (과잉 거부 방지)', async () => {
    const real = await symlinkDotfilesConfig(tmp.home);
    await fs.mkdir(join(real, 'myapp'), { recursive: true });
    await writePlugin(tmp.home, 'dotmine', `${real}/myapp/creds.json`);
    expect(await loadedIds()).toContain('dotmine');
  });
});
