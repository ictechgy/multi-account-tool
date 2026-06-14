/**
 * PR-S5: 세션 격리 통합 테스트 (실제 runSession + materialize/recapture, spawn 은 fake-cli).
 *
 * 검증 (Gap #9):
 *  1) 라운드트립: fake-cli 가 격리본 rewrite → 종료 재캡처가 프로필에 반영.
 *  2) 동시 2세션: 각 세션이 서로 다른 격리본을 봄(env 분리) + 세션 id 상이.
 *  3) base 비-secret/자격증명 무손상 (copy-isolate — 세션은 복사본만 수정).
 *
 * runSession 은 `$SHELL` 을 spawn 하므로 SHELL 을 실행 가능한 fake-cli 로 지정한다.
 * 그 외(findCliDef/profile-store/paths)는 모두 실제 — 진짜 파일 격리를 검증.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeProfileFile, readProfileFile } from '../../src/core/profile-store.js';
import { runSession } from '../../src/core/session.js';
import { sessionsDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLI = join(FIXTURES, 'fake-cli.mjs');
const FAKE_CLI_MULTICRED = join(FIXTURES, 'fake-cli-multicred.mjs');
const FAKE_CLI_GEMINI = join(FIXTURES, 'fake-cli-gemini.mjs');

let tmp: TmpHome;
let originalShell: string | undefined;
let originalExpectCodexSkill: string | undefined;

beforeEach(async () => {
  tmp = await setupTmpHome();
  await fs.chmod(FAKE_CLI, 0o755); // git +x 미보존 환경 대비
  originalShell = process.env.SHELL;
  originalExpectCodexSkill = process.env.EXPECT_CODEX_SKILL;
  process.env.SHELL = FAKE_CLI; // runSession 이 spawn 할 "subshell"
});
afterEach(async () => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalExpectCodexSkill === undefined) delete process.env.EXPECT_CODEX_SKILL;
  else process.env.EXPECT_CODEX_SKILL = originalExpectCodexSkill;
  await tmp.cleanup();
});

describe('session 통합 — 라운드트립 + 동시 격리', () => {
  it('라운드트립: fake-cli 가 격리본 rewrite → 프로필에 재캡처', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'ORIG');
    const result = await runSession({ cliId: 'codex', profileName: 'work' });
    expect(result.code).toBe(0);
    expect(result.recaptureError).toBeUndefined();
    const after = await readProfileFile('codex', 'work', 'auth.json');
    expect(after).toMatch(/^ORIG\+ROT:codex-work-[0-9a-f]{8}$/);
    // 세션 디렉토리 정리됨
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('동시 2세션: 각자 자기 프로필 격리본을 봄 (env 분리) + 세션 id 상이', async () => {
    await writeProfileFile('codex', 'alpha', 'auth.json', 'TOKEN-ALPHA');
    await writeProfileFile('codex', 'beta', 'auth.json', 'TOKEN-BETA');

    await Promise.all([
      runSession({ cliId: 'codex', profileName: 'alpha' }),
      runSession({ cliId: 'codex', profileName: 'beta' })
    ]);

    const a = await readProfileFile('codex', 'alpha', 'auth.json');
    const b = await readProfileFile('codex', 'beta', 'auth.json');
    // 각 세션은 자기 토큰만 봤다 (격리). 상대 토큰 누설 0.
    expect(a).toMatch(/^TOKEN-ALPHA\+ROT:codex-alpha-[0-9a-f]{8}$/);
    expect(b).toMatch(/^TOKEN-BETA\+ROT:codex-beta-[0-9a-f]{8}$/);
    expect(a).not.toContain('BETA');
    expect(b).not.toContain('ALPHA');
    // 모든 세션 디렉토리 정리됨
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('base 비-secret/자격증명 무손상 (copy-isolate)', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'ORIG');
    // 실제 base ~/.codex 에 자격증명 + 비-secret config 미리 생성.
    const baseDir = join(tmp.home, '.codex');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(join(baseDir, 'auth.json'), 'BASE-LIVE');
    await fs.writeFile(join(baseDir, 'config.toml'), 'model=gpt');

    await runSession({ cliId: 'codex', profileName: 'work' });

    // 세션은 격리 복사본만 수정 → 실제 base 는 무손상.
    expect(await fs.readFile(join(baseDir, 'auth.json'), 'utf8')).toBe('BASE-LIVE');
    expect(await fs.readFile(join(baseDir, 'config.toml'), 'utf8')).toBe('model=gpt');
    // 프로필만 재캡처됨.
    expect(await readProfileFile('codex', 'work', 'auth.json')).toMatch(/^ORIG\+ROT:/);
  });

  it('codex skills/ 는 세션 CODEX_HOME 으로 복사되지만 base 로 write-back 되지 않음', async () => {
    process.env.EXPECT_CODEX_SKILL = '1';
    await writeProfileFile('codex', 'work', 'auth.json', 'ORIG');
    const baseDir = join(tmp.home, '.codex');
    await fs.mkdir(join(baseDir, 'skills', 'demo'), { recursive: true });
    await fs.writeFile(join(baseDir, 'skills', 'demo', 'SKILL.md'), '# Demo skill');

    const result = await runSession({ cliId: 'codex', profileName: 'work' });

    expect(result.code).toBe(0);
    expect(result.recaptureError).toBeUndefined();
    expect(await fs.readFile(join(baseDir, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo skill');
    expect(await readProfileFile('codex', 'work', 'auth.json')).toMatch(/^ORIG\+ROT:/);
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });
});

/**
 * issue #62: 동시 같은-프로필 multi-cred(Qwen) 재캡처가 프로필 단위 락으로 직렬화돼
 * cred 별 winner 분기 split 을 제거하는지 검증 (BLOCKING-2 / 시나리오 2③ 불변식 가드).
 *
 * Qwen 은 단일 QWEN_HOME root 에 settings.json + .env 2 cred 를 가진다. 락 없이 두 세션이
 * 동시에 commit 하면 cred 단위 interleave 로 cred-A 는 S1 winner·cred-B 는 S2 winner 인
 * 어느 세션에도 속하지 않는 split 세대가 가능하다(compare-and-restore 는 cred 별 독립이라
 * 흡수 못 함). 락이 backup-read→commit→rollback 전체를 직렬화하면 최종 두 cred 가 **단일
 * 일관 세대**(같은 세션 ROT 마커)가 된다.
 */
describe('session 통합 — 동시 같은-프로필 multi-cred 직렬화 (Qwen, #62)', () => {
  beforeEach(async () => {
    await fs.chmod(FAKE_CLI_MULTICRED, 0o755); // git +x 미보존 환경 대비
    process.env.SHELL = FAKE_CLI_MULTICRED; // multi-cred fake-cli 로 교체
  });
  // afterEach 는 상위 describe 밖 전역 afterEach 가 SHELL 복원 + tmp cleanup 수행.

  it('(15) 동시 2세션 같은 프로필 → 두 cred 가 단일 일관 세대 (cred 별 winner 분기 0)', async () => {
    await writeProfileFile('qwen', 'work', 'qwen-settings.json', 'SETTINGS');
    await writeProfileFile('qwen', 'work', 'qwen.env', 'ENV');

    // 같은 cli·같은 프로필을 동시에 2세션 실행 — 락이 재캡처 전체를 직렬화해야 한다.
    await Promise.all([
      runSession({ cliId: 'qwen', profileName: 'work' }),
      runSession({ cliId: 'qwen', profileName: 'work' })
    ]);

    const settings = await readProfileFile('qwen', 'work', 'qwen-settings.json');
    const env = await readProfileFile('qwen', 'work', 'qwen.env');
    expect(settings).not.toBeNull();
    expect(env).not.toBeNull();

    // 각 cred 의 **마지막 ROT 마커 세션 id** 를 추출 — 핵심 불변식: 두 cred 가 동일 세션.
    const lastMarker = (s: string): string => {
      const all = [...s.matchAll(/\+ROT:(qwen-work-[0-9a-f]{8})/g)];
      return all.length ? all[all.length - 1][1] : '';
    };
    const settingsWinner = lastMarker(settings!);
    const envWinner = lastMarker(env!);
    expect(settingsWinner).toMatch(/^qwen-work-[0-9a-f]{8}$/);
    // cred 별 winner 분기 0 — 두 cred 의 최종 세대가 같은 세션이어야 (split 없음).
    expect(envWinner).toBe(settingsWinner);
    // 모든 세션 디렉토리 정리됨.
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });
});

/**
 * PR-3: gemini 2-cred 세션 격리 라운드트립. gemini 는 GEMINI_CLI_HOME 이 `.gemini` 의 부모를
 * 가리켜 envSubdir='.gemini' 로 cred 루트를 한 단계 내린다(소스 실측). 실제 빌트인 gemini def
 * (findCliDef 미mock — 통합)로 runSession 을 돌려, 격리본이 `<주입dir>/.gemini/<rel>` 에 만들어지고
 * 두 cred(oauth_creds + google_accounts)가 종료 재캡처로 프로필에 함께 반영되는지 검증한다.
 */
describe('session 통합 — gemini 2-cred 라운드트립 (envSubdir, PR-3)', () => {
  beforeEach(async () => {
    await fs.chmod(FAKE_CLI_GEMINI, 0o755); // git +x 미보존 환경 대비
    process.env.SHELL = FAKE_CLI_GEMINI; // gemini fake-cli 로 교체
  });
  // afterEach 는 상위 describe 밖 전역 afterEach 가 SHELL 복원 + tmp cleanup 수행.

  it('라운드트립: 격리본 .gemini/ 하위 rewrite → 두 cred 모두 프로필에 재캡처', async () => {
    await writeProfileFile('gemini', 'work', 'oauth_creds.json', 'OAUTH');
    await writeProfileFile('gemini', 'work', 'google_accounts.json', 'ACCTS');

    const result = await runSession({ cliId: 'gemini', profileName: 'work' });
    expect(result.code).toBe(0);
    expect(result.recaptureError).toBeUndefined();

    const oauth = await readProfileFile('gemini', 'work', 'oauth_creds.json');
    const accts = await readProfileFile('gemini', 'work', 'google_accounts.json');
    // 두 cred 모두 동일 세션 ROT 마커로 재캡처 — 2-cred 원자 그룹 반영.
    expect(oauth).toMatch(/^OAUTH\+ROT:gemini-work-[0-9a-f]{8}$/);
    expect(accts).toMatch(/^ACCTS\+ROT:gemini-work-[0-9a-f]{8}$/);
    // 세션 디렉토리 정리됨.
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('base ~/.gemini 자격증명 무손상 (copy-isolate — 세션은 격리본만 수정)', async () => {
    await writeProfileFile('gemini', 'work', 'oauth_creds.json', 'OAUTH');
    await writeProfileFile('gemini', 'work', 'google_accounts.json', 'ACCTS');
    // 실제 base ~/.gemini 에 자격증명 미리 생성.
    const baseDir = join(tmp.home, '.gemini');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(join(baseDir, 'oauth_creds.json'), 'BASE-OAUTH');
    await fs.writeFile(join(baseDir, 'google_accounts.json'), 'BASE-ACCTS');

    await runSession({ cliId: 'gemini', profileName: 'work' });

    // 세션은 격리 복사본만 수정 → 실제 base 무손상.
    expect(await fs.readFile(join(baseDir, 'oauth_creds.json'), 'utf8')).toBe('BASE-OAUTH');
    expect(await fs.readFile(join(baseDir, 'google_accounts.json'), 'utf8')).toBe('BASE-ACCTS');
    // 프로필만 재캡처됨.
    expect(await readProfileFile('gemini', 'work', 'oauth_creds.json')).toMatch(/^OAUTH\+ROT:/);
  });
});
