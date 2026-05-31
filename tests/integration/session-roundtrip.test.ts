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

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.mjs');

let tmp: TmpHome;
let originalShell: string | undefined;

beforeEach(async () => {
  tmp = await setupTmpHome();
  await fs.chmod(FAKE_CLI, 0o755); // git +x 미보존 환경 대비
  originalShell = process.env.SHELL;
  process.env.SHELL = FAKE_CLI; // runSession 이 spawn 할 "subshell"
});
afterEach(async () => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
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
});
