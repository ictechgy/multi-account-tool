/**
 * 자격증명 경로 **별칭 우회** 회귀 테스트 (Gate 1 — 소유권 판정).
 *
 * v0.8.2 빌드 실측으로 확인된 우회를 고정한다. 당시 결과:
 *
 * | 별칭 형태            | plugin 로드 | readSource 가 실제 토큰 반환 | writeSource 가 실제 파일 훼손 |
 * |---------------------|------------|---------------------------|---------------------------|
 * | 디렉토리 symlink     | 통과        | 반환함                     | 훼손함                     |
 * | 파일 symlink        | 통과        | 반환함                     | 훼손 안 함                  |
 * | hardlink            | 통과        | 반환함                     | 훼손 안 함                  |
 *
 * 쓰기가 두 경우에 막혔던 것은 `io-atomic.ts` 가 tmp 를 `O_EXCL|O_NOFOLLOW` 로 열고 rename 하기
 * 때문이지 소유권 판정 덕분이 아니었다. 즉 **읽기는 보편적 유출 채널**이었다.
 *
 * 단정 규약: "throw 했다" 로 만족하지 않는다 — 다른 이유로 throw 해도 초록이 되기 때문이다.
 * **plugin 이 아예 로드되지 않는다**는 것을 직접 단정한다.
 *
 * 실제 파일시스템을 쓴다(mock 아님). symlink/hardlink 시맨틱이 판정 대상이므로 mock 은 무의미하다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { resetCliDefCache } from '../../src/core/cli-defs.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const REAL_TOKEN = 'REAL-CODEX-TOKEN';

async function writePlugin(home: string, id: string, path: string): Promise<void> {
  const dir = join(home, '.multi-account-tool', 'cli-defs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({
    id, name: id, sources: [{ type: 'file', path, saveAs: 'x.json' }]
  }));
}

async function loadedIds(): Promise<string[]> {
  resetCliDefCache();
  const { getAllCliDefs } = await import('../../src/core/cli-defs.js');
  return getAllCliDefs().map(d => d.id);
}

describe('자격증명 경로 별칭 우회 — Gate 1 소유권 판정', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex', 'auth.json'), REAL_TOKEN);
  });

  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('디렉토리 symlink 별칭은 거부된다 (v0.8.2 에서 read+write 둘 다 뚫렸던 케이스)', async () => {
    await fs.symlink(join(tmp.home, '.codex'), join(tmp.home, 'aliasdir'));
    await writePlugin(tmp.home, 'diralias', '~/aliasdir/auth.json');
    expect(await loadedIds()).not.toContain('diralias');
  });

  it('파일 symlink 별칭은 거부된다', async () => {
    await fs.symlink(join(tmp.home, '.codex', 'auth.json'), join(tmp.home, 'aliasfile.json'));
    await writePlugin(tmp.home, 'filealias', '~/aliasfile.json');
    expect(await loadedIds()).not.toContain('filealias');
  });

  it('hardlink 는 거부된다 — 경로 해석으로 접히지 않으므로 inode 축이 필요하다', async () => {
    await fs.link(join(tmp.home, '.codex', 'auth.json'), join(tmp.home, 'hard.json'));
    await writePlugin(tmp.home, 'hardalias', '~/hard.json');
    expect(await loadedIds()).not.toContain('hardalias');
  });

  it('로드 시점에 대상이 **부재**했다가 나중에 생겨도 별칭은 정경으로 접힌다', async () => {
    // bounded resolve 는 존재하는 최장 접두만 해석하고 꼬리를 이어 붙이므로, 대상 파일이
    // 아직 없어도 `~/aliasdir/notyet.json` 은 `~/.codex/notyet.json` 으로 접힌다.
    await fs.symlink(join(tmp.home, '.codex'), join(tmp.home, 'aliasdir'));
    await writePlugin(tmp.home, 'absentalias', '~/aliasdir/auth.json');
    expect(await loadedIds()).not.toContain('absentalias');
  });

  it('정경 표기 직접 선언도 계속 거부된다 (v0.8.2 가 이미 막던 것 — 회귀 방지)', async () => {
    await writePlugin(tmp.home, 'canon', '~/.codex/auth.json');
    expect(await loadedIds()).not.toContain('canon');
  });

  it('대소문자 변형도 거부된다 (darwin/win32)', async () => {
    await writePlugin(tmp.home, 'casevar', '~/.CODEX/Auth.json');
    const ids = await loadedIds();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(ids).not.toContain('casevar');
    } else {
      expect(ids).toContain('casevar');
    }
  });
});

describe('자격증명 경로 별칭 우회 — 정상 사용자는 막지 않는다', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); resetCliDefCache(); });
  afterEach(async () => { resetCliDefCache(); await tmp.cleanup(); });

  it('구역 밖 자기 경로를 선언한 plugin 은 통과한다', async () => {
    await fs.mkdir(join(tmp.home, '.config', 'myapp'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.config', 'myapp', 'creds.json'), 'MINE');
    await writePlugin(tmp.home, 'mine', '~/.config/myapp/creds.json');
    expect(await loadedIds()).toContain('mine');
  });

  it('dotfiles 관리자처럼 `~/.config` 자체가 symlink 여도 자기 경로 plugin 은 통과한다', async () => {
    // 이 케이스가 막히면 stow/chezmoi 사용자가 전부 브릭된다. 해석은 "거부" 가 아니라
    // "같은 실물이면 같은 리소스" 판정이므로 builtin 을 안 건드리는 한 통과해야 한다.
    await fs.mkdir(join(tmp.home, 'dotfiles', 'config', 'myapp'), { recursive: true });
    await fs.writeFile(join(tmp.home, 'dotfiles', 'config', 'myapp', 'creds.json'), 'MINE');
    await fs.symlink(join(tmp.home, 'dotfiles', 'config'), join(tmp.home, '.config'));
    await writePlugin(tmp.home, 'dotmine', '~/.config/myapp/creds.json');
    expect(await loadedIds()).toContain('dotmine');
  });

  it('부재 경로를 선언한 plugin 은 통과한다 (자격증명 파일은 아직 없는 것이 정상)', async () => {
    await writePlugin(tmp.home, 'notyet', '~/.config/myapp/notyet.json');
    expect(await loadedIds()).toContain('notyet');
  });
});
