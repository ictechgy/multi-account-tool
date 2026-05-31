/**
 * PR-S2: session.ts 부작용 코어 (planSession / materializeSession / recaptureSession /
 * removeSessionDir) 단위 테스트. 임시 HOME fixture + 실제 파일/symlink.
 *
 * profile-store 는 partial mock — readProfileFile 는 실제, writeProfileFile 만 spy 로
 * 감싸 재캡처 실패/hang 을 주입한다 (C1 검증). materialize 의 자격증명 복사는 io-atomic
 * writeFileAtomic(실제) 를 쓰므로 mock 영향 없음.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/profile-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/profile-store.js')>();
  return { ...actual, writeProfileFile: vi.fn(actual.writeProfileFile) };
});

import {
  planSession,
  materializeSession,
  recaptureSession,
  removeSessionDir
} from '../../src/core/session.js';
import { writeProfileFile, readProfileFile } from '../../src/core/profile-store.js';
import { findCliDef } from '../../src/core/cli-defs.js';
import { sessionDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import type { CliDef } from '../../src/core/types.js';

const mockedWrite = vi.mocked(writeProfileFile);

let tmp: TmpHome;
let realWrite: typeof writeProfileFile;
beforeEach(async () => {
  tmp = await setupTmpHome();
  const actual = await vi.importActual<typeof import('../../src/core/profile-store.js')>(
    '../../src/core/profile-store.js'
  );
  realWrite = actual.writeProfileFile;
  // 각 테스트는 실제 write 동작으로 시작 — 실패 주입 테스트가 mockImplementation 으로 override.
  mockedWrite.mockReset();
  mockedWrite.mockImplementation(realWrite);
});
afterEach(async () => {
  await tmp.cleanup();
});

/** base 디렉토리에 파일 생성 (HOME 하위 절대경로). */
async function writeBaseFile(rel: string, content: string): Promise<string> {
  const abs = join(tmp.home, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, { mode: 0o600 });
  return abs;
}

const SID = 'codex-work-test0001';

describe('planSession', () => {
  it('codex: 단일 root/cred (auth.json, rel auth.json), share ∅', () => {
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    expect(plan).toMatchObject({ cli: 'codex', profile: 'work', id: SID });
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].env).toBe('CODEX_HOME');
    expect(plan.roots[0].share).toEqual([]);
    expect(plan.roots[0].creds).toEqual([
      expect.objectContaining({ saveAs: 'auth.json', rel: 'auth.json' })
    ]);
  });

  it('qwen: 단일 root 에 2 cred (settings.json/.env)', () => {
    const plan = planSession(findCliDef('qwen')!, 'work', SID);
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].creds.map((c) => c.rel).sort()).toEqual(['.env', 'settings.json']);
  });

  it('crush: 2 root 각 1 cred (비-prefix 매핑 정확)', () => {
    const plan = planSession(findCliDef('crush')!, 'work', SID);
    expect(plan.roots).toHaveLength(2);
    const byEnv = Object.fromEntries(plan.roots.map((r) => [r.env, r.creds.map((c) => c.rel)]));
    expect(byEnv['CRUSH_GLOBAL_CONFIG']).toEqual(['crush.json']);
    expect(byEnv['CRUSH_GLOBAL_DATA']).toEqual(['crush.json']);
  });

  it('비-file source(keychain) 가 섞이면 throw', () => {
    const bad: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'keychain', service: 'x', saveAs: 'k.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake' }] }
    };
    expect(() => planSession(bad, 'work', SID)).toThrow();
  });

  it('base 미커버 source 면 throw', () => {
    const bad: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.other/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake' }] }
    };
    expect(() => planSession(bad, 'work', SID)).toThrow();
  });

  it('비직속(base 하위 디렉토리 내부) source 면 throw', () => {
    const bad: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/sub/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake' }] }
    };
    expect(() => planSession(bad, 'work', SID)).toThrow();
  });

  it('share ∩ creds(rel) ≠ ∅ 면 throw (자격증명을 symlink 로 새지 않게)', () => {
    const bad: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['auth.json'] }] }
    };
    expect(() => planSession(bad, 'work', SID)).toThrow();
  });

  it('share disjoint 면 plan 에 반영 (메커니즘 보존)', () => {
    const def: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['config.toml'] }] }
    };
    const plan = planSession(def, 'work', SID);
    expect(plan.roots[0].share).toEqual(['config.toml']);
  });
});

describe('materializeSession — 빌트인 경로 (copy-isolate, share ∅)', () => {
  it('자격증명 = 0600 실파일(symlink 아님), 내용=프로필값', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt'); // 비-secret (ephemeral 대상)
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);

    const credPath = join(plan.roots[0].dir, 'auth.json');
    const st = await fs.lstat(credPath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(credPath, 'utf8')).toBe('TOKEN-A');
  });

  it('그 외 base 파일(config.toml)은 세션 디렉토리에 없음 (ephemeral)', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    await expect(fs.access(join(plan.roots[0].dir, 'config.toml'))).rejects.toThrow();
  });

  it('빌트인 share=∅ → 세션 디렉토리에 symlink 0개', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const entries = await fs.readdir(plan.roots[0].dir, { withFileTypes: true });
    expect(entries.some((e) => e.isSymbolicLink())).toBe(false);
  });

  it('base 부재 시에도 자격증명 격리본은 생성됨', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    expect(await fs.readFile(join(plan.roots[0].dir, 'auth.json'), 'utf8')).toBe('TOKEN-A');
  });

  it('세션 디렉토리가 이미 존재하면 throw (재사용 금지)', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await fs.mkdir(sessionDir(SID), { recursive: true });
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
  });

  it('자격증명 부재(프로필에 saveAs 없음) → throw + 세션 디렉토리 미잔류', async () => {
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });
});

describe('materializeSession — allow-list 메커니즘 (가짜 def, share)', () => {
  const fakeDef: CliDef = {
    id: 'fakecli', name: 'Fake',
    sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
    session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['config.toml'] }] }
  };

  it('allow-list 항목 = base 원본을 가리키는 symlink', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    const target = await writeBaseFile('.fake/config.toml', 'shared-config');
    const plan = planSession(fakeDef, 'work', SID);
    await materializeSession(plan);
    const linkPath = join(plan.roots[0].dir, 'config.toml');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(linkPath)).toBe(await fs.realpath(target));
  });

  it('allow-list 대상이 base 에서 symlink 면 거부 + 세션 디렉토리 미잔류', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await writeBaseFile('.fake/real.toml', 'x');
    await fs.symlink(join(tmp.home, '.fake/real.toml'), join(tmp.home, '.fake/config.toml'));
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });

  it('allow-list 대상이 base 에 부재면 거부', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
  });
});

describe('recaptureSession — 원자성 + cred 단위 timeout 롤백 (C1)', () => {
  /** 격리본을 수정해 "CLI 가 rewrite" 상황 모사. */
  async function setupQwenSession(): Promise<ReturnType<typeof planSession>> {
    await writeProfileFile('qwen', 'work', 'qwen-settings.json', 'OLD-SET');
    await writeProfileFile('qwen', 'work', 'qwen.env', 'OLD-ENV');
    const plan = planSession(findCliDef('qwen')!, 'work', SID);
    await materializeSession(plan);
    // 격리본 rewrite (CLI 가 새 토큰을 쓴 상황 모사)
    const root = plan.roots[0];
    await fs.writeFile(join(root.dir, 'settings.json'), 'NEW-SET');
    await fs.writeFile(join(root.dir, '.env'), 'NEW-ENV');
    return plan;
  }

  it('정상: 격리본 둘 다 프로필로 재캡처', async () => {
    const plan = await setupQwenSession();
    await recaptureSession(plan);
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('NEW-SET');
    expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('NEW-ENV');
  });

  it('일반 실패: 2번째 write 실패 → 1번째 백업 원복(split 0) + 에러', async () => {
    const plan = await setupQwenSession();
    let call = 0;
    mockedWrite.mockImplementation((cli, prof, file, val) => {
      call++;
      if (call === 2) return Promise.reject(new Error('disk full'));
      return realWrite(cli, prof, file, val); // 적용(call1) + 롤백(call3) 은 실제 write
    });
    await expect(recaptureSession(plan)).rejects.toThrow(/disk full/);
    // 두 cred 모두 종료 전(OLD) 값 — split 0
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OLD-SET');
    expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('OLD-ENV');
  });

  it('timeout: 2번째 write hang → cred 단위 timeout → 1번째 백업 원복(split 0) + 에러', async () => {
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '50'; // 짧은 timeout (fake timer 없이)
    try {
      const plan = await setupQwenSession();
      let call = 0;
      mockedWrite.mockImplementation((cli, prof, file, val) => {
        call++;
        if (call === 2) return new Promise<void>(() => { /* never resolves → hang */ });
        return realWrite(cli, prof, file, val);
      });
      await expect(recaptureSession(plan)).rejects.toThrow(/timeout/i);
      // 1번째 cred 가 백업(OLD)으로 원복됨 — 전체-race 였다면 롤백 안 돼 NEW 로 남음 (C1)
      expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OLD-SET');
    } finally {
      delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    }
  });

  it('격리본 부재 cred 는 skip (재캡처 안 함)', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'OLD');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    await fs.rm(join(plan.roots[0].dir, 'auth.json')); // CLI 가 격리본 삭제 모사
    mockedWrite.mockClear();
    await recaptureSession(plan);
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('OLD'); // 변경 없음
  });
});

describe('removeSessionDir', () => {
  it('traversal id throw', async () => {
    await expect(removeSessionDir('../escape')).rejects.toThrow();
  });

  it('정상 id → 디렉토리 삭제, symlink 대상 base 무손상', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    const target = await writeBaseFile('.fake/config.toml', 'shared');
    const def: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['config.toml'] }] }
    };
    await writeBaseFile('.fake/auth.json', 'base-tok');
    const plan = planSession(def, 'work', SID);
    await materializeSession(plan);
    await removeSessionDir(SID);
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
    // symlink 가 가리키던 base 원본은 남아있음
    expect(await fs.readFile(target, 'utf8')).toBe('shared');
  });
});
