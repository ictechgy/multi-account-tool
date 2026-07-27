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

/**
 * 이 HOME 이 놓인 파일시스템이 대소문자를 구분하지 않는지 **실제로** 확인한다.
 *
 * `process.platform` 은 대리 변수일 뿐이다. macOS 는 case-sensitive APFS 볼륨으로도 포맷할 수
 * 있고, 그런 러너에서는 `~/.CODEX/Auth.json` 이 전혀 다른(부재) 경로라 "거부되어야 한다" 는
 * 단정이 거짓 실패를 낸다. 반대로 Linux 에서 대소문자 무시 마운트를 쓰면 통과 단정이 깨진다.
 */
async function fsFoldsCase(home: string): Promise<boolean> {
  const probe = join(home, '.mat-case-probe');
  await fs.writeFile(probe, 'x');
  try {
    await fs.stat(join(home, '.MAT-CASE-PROBE'));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { force: true });
  }
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

  it('대상 파일이 **아직 없어도** 별칭은 정경으로 접힌다', async () => {
    // bounded resolve 는 존재하는 최장 접두만 해석하고 꼬리를 이어 붙이므로, 대상 파일이
    // 아직 없어도 `~/aliasdir/auth.json` 은 `~/.codex/auth.json` 으로 접힌다.
    //
    // leaf 를 **실제로 지워야** 이 테스트가 의미를 갖는다. 공유 beforeEach 가 auth.json 을
    // 만들어 두므로 그대로 두면 "leaf 가 존재할 때만 별칭을 접는" fail-open 회귀가 이 테스트를
    // 통과해 버린다 (리뷰가 잡은 결함 — 주석은 부재를 말하는데 픽스처는 존재했다).
    await fs.rm(join(tmp.home, '.codex', 'auth.json'));
    await fs.symlink(join(tmp.home, '.codex'), join(tmp.home, 'aliasdir'));
    await writePlugin(tmp.home, 'absentalias', '~/aliasdir/auth.json');
    expect(await loadedIds()).not.toContain('absentalias');
  });

  it('정경 표기 직접 선언도 계속 거부된다 (v0.8.2 가 이미 막던 것 — 회귀 방지)', async () => {
    await writePlugin(tmp.home, 'canon', '~/.codex/auth.json');
    expect(await loadedIds()).not.toContain('canon');
  });

  it('대소문자 변형은 파일시스템이 대소문자를 접을 때만 거부된다', async () => {
    // 기대값을 `process.platform` 이 아니라 **실측한 파일시스템 속성**에서 끌어온다
    // (case-sensitive APFS 볼륨이나 대소문자 무시 마운트에서 거짓 실패/통과를 막는다).
    const folds = await fsFoldsCase(tmp.home);
    await writePlugin(tmp.home, 'casevar', '~/.CODEX/Auth.json');
    const ids = await loadedIds();
    if (folds) expect(ids).not.toContain('casevar');
    else expect(ids).toContain('casevar');
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
