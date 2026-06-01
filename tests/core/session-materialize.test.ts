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
  // writeProfileFile(롤백) + stageProfileFile/commitStagedFile(2-phase) 을 spy 로 감싸
  // 실패/hang 을 주입한다 (H1 검증). 기본은 실제 동작.
  return {
    ...actual,
    writeProfileFile: vi.fn(actual.writeProfileFile),
    stageProfileFile: vi.fn(actual.stageProfileFile),
    commitStagedFile: vi.fn(actual.commitStagedFile)
  };
});

import {
  planSession,
  materializeSession,
  recaptureSession,
  removeSessionDir
} from '../../src/core/session.js';
import {
  writeProfileFile,
  readProfileFile,
  stageProfileFile,
  commitStagedFile
} from '../../src/core/profile-store.js';
import { findCliDef } from '../../src/core/cli-defs.js';
import { profileFilePath, sessionDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import type { CliDef } from '../../src/core/types.js';

const mockedWrite = vi.mocked(writeProfileFile);
const mockedStage = vi.mocked(stageProfileFile);
const mockedCommit = vi.mocked(commitStagedFile);

let tmp: TmpHome;
let realWrite: typeof writeProfileFile;
let realStage: typeof stageProfileFile;
let realCommit: typeof commitStagedFile;
beforeEach(async () => {
  tmp = await setupTmpHome();
  const actual = await vi.importActual<typeof import('../../src/core/profile-store.js')>(
    '../../src/core/profile-store.js'
  );
  realWrite = actual.writeProfileFile;
  realStage = actual.stageProfileFile;
  realCommit = actual.commitStagedFile;
  // 각 테스트는 실제 동작으로 시작 — 실패/hang 주입 테스트가 mockImplementation 으로 override.
  mockedWrite.mockReset();
  mockedWrite.mockImplementation(realWrite);
  mockedStage.mockReset();
  mockedStage.mockImplementation(realStage);
  mockedCommit.mockReset();
  mockedCommit.mockImplementation(realCommit);
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

/** 테스트용 지연 — late-landing 모사 등에 사용. */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('planSession', () => {
  it('codex: 단일 root/cred (auth.json, rel auth.json), share=[config.toml] (issue #63-3)', () => {
    // config.toml 은 secret-free 검증 완료 — base 공유 허용 (토큰은 auth.json 에 분리).
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    expect(plan).toMatchObject({ cli: 'codex', profile: 'work', id: SID });
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].env).toBe('CODEX_HOME');
    expect(plan.roots[0].share).toEqual(['config.toml']);
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

  it.each(['../escape', '/etc/passwd', 'a/../b', 'sub/../../x', '..'])(
    'share traversal 항목 (%s) 면 throw (allow-list fail-open 차단)',
    (bad) => {
      const def: CliDef = {
        id: 'fakecli', name: 'Fake',
        sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
        session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: [bad] }] }
      };
      expect(() => planSession(def, 'work', SID)).toThrow();
    }
  );

  it('share 정상 nested 항목은 정규화돼 plan 에 반영', () => {
    const def: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['sub/config.toml'] }] }
    };
    const plan = planSession(def, 'work', SID);
    expect(plan.roots[0].share).toEqual(['sub/config.toml']);
  });
});

describe('materializeSession — 빌트인 경로 (copy-isolate, share=[config.toml])', () => {
  it('자격증명 = 0600 실파일(symlink 아님), 내용=프로필값', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt'); // share 대상 — base 에 실파일 필요
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);

    const credPath = join(plan.roots[0].dir, 'auth.json');
    const st = await fs.lstat(credPath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(credPath, 'utf8')).toBe('TOKEN-A');
  });

  it('config.toml 은 base 원본으로의 symlink 로 세션 디렉토리에 공유됨 (issue #63-3)', async () => {
    // config.toml 이 share 에 있으므로 materializeSession 이 base 원본을 symlink 로 연결한다.
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const linkPath = join(plan.roots[0].dir, 'config.toml');
    const st = await fs.lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true); // symlink 로 공유
    expect(await fs.readFile(linkPath, 'utf8')).toBe('model=gpt'); // 내용은 base 원본
  });

  it('codex share=[config.toml] → 세션 디렉토리에 symlink 1개(config.toml), cred(auth.json)는 실파일', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const entries = await fs.readdir(plan.roots[0].dir, { withFileTypes: true });
    const symlinks = entries.filter((e) => e.isSymbolicLink()).map((e) => e.name);
    expect(symlinks).toEqual(['config.toml']); // symlink 는 config.toml 1개
    const authSt = await fs.lstat(join(plan.roots[0].dir, 'auth.json'));
    expect(authSt.isSymbolicLink()).toBe(false); // 자격증명은 실파일
  });

  it('base 에 config.toml 부재 시 — throw 없이 materialize 성공, config.toml 링크 미생성 (optional skip)', async () => {
    // config.toml 은 read-mostly 설정이므로 부재해도 세션 진행에 지장 없다.
    // materializeShareLink 는 ENOENT 를 skip(return)하고 세션을 정상 완료해야 한다.
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    // config.toml 미생성 — base 에 없음
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    // throw 없이 완료 (optional share skip)
    await expect(materializeSession(plan)).resolves.toBeUndefined();
    // config.toml 링크 미생성
    const linkPath = join(plan.roots[0].dir, 'config.toml');
    await expect(fs.access(linkPath)).rejects.toThrow();
    // creds 격리본(auth.json)은 정상 생성됨
    expect(await fs.readFile(join(plan.roots[0].dir, 'auth.json'), 'utf8')).toBe('TOKEN-A');
  });

  it('base 에 config.toml 있을 때 자격증명 격리본은 생성됨', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
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

  it('allow-list 대상이 base 에 부재면 skip — throw 없이 materialize 성공, 링크 미생성 (optional)', async () => {
    // config.toml 등 read-mostly 설정 파일이 없어도 세션은 정상 진행된다.
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    // config.toml 미생성
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).resolves.toBeUndefined();
    // config.toml 링크 미생성
    const linkPath = join(plan.roots[0].dir, 'config.toml');
    await expect(fs.access(linkPath)).rejects.toThrow();
    // creds 격리본(auth.json — cred.rel) 은 정상 생성됨
    // fakeDef source path=~/.fake/auth.json → cred.rel='auth.json', absInSession=dir/auth.json
    expect(await fs.readFile(join(plan.roots[0].dir, 'auth.json'), 'utf8')).toBe('TOK');
  });

  it('정상 nested share → 세션 하위 디렉토리에 symlink 생성', async () => {
    const nestedDef: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['sub/config.toml'] }] }
    };
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await writeBaseFile('.fake/sub/config.toml', 'nested-shared');
    const plan = planSession(nestedDef, 'work', SID);
    await materializeSession(plan);
    const linkPath = join(plan.roots[0].dir, 'sub', 'config.toml');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(linkPath, 'utf8')).toBe('nested-shared');
  });

  it('base 측 부모가 symlink 로 base 밖을 가리키면 거부 (realpath 봉쇄, §4.2)', async () => {
    const nestedDef: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['sub/config.toml'] }] }
    };
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    // base 밖(~/.outside)에 실제 파일 + base 안 'sub' 를 그 디렉토리로 향하는 symlink 로 escape.
    await writeBaseFile('.outside/config.toml', 'escaped');
    await fs.mkdir(join(tmp.home, '.fake'), { recursive: true });
    await fs.symlink(join(tmp.home, '.outside'), join(tmp.home, '.fake', 'sub'));
    const plan = planSession(nestedDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
    await expect(fs.access(sessionDir(SID))).rejects.toThrow(); // 세션 디렉토리 미잔류
  });

  it('allow-list 대상이 디렉토리면 거부 (isFile — 통째 노출 차단, #8)', async () => {
    const dirDef: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['sub'] }] }
    };
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    // 'sub' 를 디렉토리로 생성 (그 안에 파일 포함) → 디렉토리 share 는 거부돼야 한다.
    await fs.mkdir(join(tmp.home, '.fake', 'sub'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.fake', 'sub', 'secret'), 'x');
    const plan = planSession(dirDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });
});

describe('commitStagedFile 계약 (PR #61 2회차 #4)', () => {
  it('예상 패턴(<file>.recap-<hex>) 아닌 staging 경로는 거부', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'X');
    const finalPath = profileFilePath('codex', 'work', 'auth.json');
    const foreign = `${finalPath}.evil`; // .recap-<hex> 아님
    await fs.writeFile(foreign, 'Y');
    await expect(commitStagedFile(foreign, 'codex', 'work', 'auth.json')).rejects.toThrow();
    // 라이브 프로필 무변경
    expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('X');
  });

  it('staging 이 symlink 면 거부', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'X');
    const finalPath = profileFilePath('codex', 'work', 'auth.json');
    const link = `${finalPath}.recap-deadbeef`;
    await fs.symlink(finalPath, link); // basename 패턴은 맞지만 symlink
    await expect(commitStagedFile(link, 'codex', 'work', 'auth.json')).rejects.toThrow();
  });

  it('정상 staging(stageProfileFile 산출)은 commit 성공', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'OLD');
    const sp = await stageProfileFile('codex', 'work', 'auth.json', 'NEW');
    await commitStagedFile(sp, 'codex', 'work', 'auth.json');
    expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('NEW');
  });
});

describe('recaptureSession — 2-phase stage/commit 원자성 (H1)', () => {
  /** 격리본을 수정해 "CLI 가 rewrite" 상황 모사 (qwen = 2 cred). */
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

  it('정상: 격리본 둘 다 프로필로 재캡처(stage→commit)', async () => {
    const plan = await setupQwenSession();
    await recaptureSession(plan);
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('NEW-SET');
    expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('NEW-ENV');
    // staging 잔여 없음 (전부 commit rename).
    const dir = join(profileFilePath('qwen', 'work', 'qwen.env'), '..');
    const leftover = (await fs.readdir(dir)).filter((f) => f.includes('.recap-'));
    expect(leftover).toEqual([]);
  });

  it('commit 실패: 2번째 commit reject → 1번째 backup 원복(split 0) + 에러', async () => {
    const plan = await setupQwenSession();
    let call = 0;
    mockedCommit.mockImplementation((sp, cli, prof, file) => {
      call++;
      if (call === 2) return Promise.reject(new Error('disk full'));
      return realCommit(sp, cli, prof, file); // commit1 + 롤백 write 는 실제
    });
    await expect(recaptureSession(plan)).rejects.toThrow(/disk full/);
    // 두 cred 모두 종료 전(OLD) — commit1 은 롤백, commit2 는 미수행. split 0.
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OLD-SET');
    expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('OLD-ENV');
  });

  it('stage hang: 2번째 stage hang → timeout → 라이브 무손상(commit 0, split 0)', async () => {
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '50'; // 짧은 timeout (fake timer 없이)
    try {
      const plan = await setupQwenSession();
      let call = 0;
      mockedStage.mockImplementation((cli, prof, file, val) => {
        call++;
        if (call === 2) return new Promise<string>(() => { /* never resolves → hang */ });
        return realStage(cli, prof, file, val);
      });
      await expect(recaptureSession(plan)).rejects.toThrow(/timeout/i);
      // commit 이 한 번도 일어나지 않음 → 둘 다 종료 전(OLD). hung stage 가 나중에 landing 해도
      // staging 임시파일만 오염되고 라이브 프로필엔 닿지 않는다 (H1 핵심 보장).
      expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OLD-SET');
      expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('OLD-ENV');
    } finally {
      delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    }
  });

  it('stage timeout 후 staging 이 늦게 생성돼도 라이브 무변경 (late-land 격리, #3)', async () => {
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '50';
    try {
      const plan = await setupQwenSession();
      let call = 0;
      mockedStage.mockImplementation(async (cli, prof, file, val) => {
        call++;
        // 2번째 stage 는 timeout(50ms) 이후에 실제 staging 파일을 생성 — late-landing 모사.
        if (call === 2) {
          await delay(150);
          return realStage(cli, prof, file, val);
        }
        return realStage(cli, prof, file, val);
      });
      await expect(recaptureSession(plan)).rejects.toThrow(/timeout/i);
      // late staging 완료 시간을 준 뒤에도 라이브 프로필은 OLD — 늦은 write 가 staging 만
      // 만들고 commit(rename) 은 0회라 라이브에 닿지 않는다 (H1 핵심 보장의 코드 고정).
      await delay(220);
      expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OLD-SET');
      expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('OLD-ENV');
      // late-land staging 은 자기 cleanup 으로 정리됨 — 자격증명 든 고아 `.recap-*` 잔류 0 (#3).
      const profDir = join(profileFilePath('qwen', 'work', 'qwen.env'), '..');
      const litter = (await fs.readdir(profDir)).filter((f) => f.includes('.recap-'));
      expect(litter).toEqual([]);
    } finally {
      delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    }
  });

  it('commit 은 timeout 으로 감싸지 않음 — 느리지만 성공하는 commit 을 끝까지 기다려 반영 (#1)', async () => {
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '50';
    try {
      const plan = await setupQwenSession();
      // commit 을 timeout(50ms)보다 느리게(150ms) — 그러나 성공. commit 이 withTimeout 으로
      // 감싸였다면 50ms 에 timeout throw 했겠지만, 감싸지 않으므로 끝까지 기다려 정상 반영한다.
      mockedCommit.mockImplementation(async (sp, cli, prof, file) => {
        await delay(150);
        return realCommit(sp, cli, prof, file);
      });
      await recaptureSession(plan); // timeout 던지지 않고 완료
      expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('NEW-SET');
      expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('NEW-ENV');
    } finally {
      delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    }
  });

  it('compare-and-restore: 롤백 중 동시 세션이 commit 값을 덮었으면 clobber 안 함 (#2)', async () => {
    const plan = await setupQwenSession();
    let call = 0;
    mockedCommit.mockImplementation(async (sp, cli, prof, file) => {
      call++;
      if (call === 1) {
        await realCommit(sp, cli, prof, file); // settings commit → 라이브=NEW-SET
        // 동시 다른 세션이 settings 프로필을 자기 값으로 덮은 상황 모사
        await writeProfileFile('qwen', 'work', 'qwen-settings.json', 'OTHER-SESSION');
        return;
      }
      return Promise.reject(new Error('disk full')); // env commit 실패 → 롤백 트리거
    });
    await expect(recaptureSession(plan)).rejects.toThrow(/disk full/);
    // 롤백이 현재값(OTHER-SESSION)을 stale backup(OLD-SET)으로 clobber 하지 않는다 — 현재값이
    // 우리가 commit 한 NEW-SET 가 아니므로 건드리지 않음 (last-writer-wins 보존).
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBe('OTHER-SESSION');
  });

  it('null-backup 롤백: 종료 전 없던 cred 가 commit 후 후속 실패 → 삭제로 원복(split 0)', async () => {
    await writeProfileFile('qwen', 'work', 'qwen-settings.json', 'OLD-SET');
    await writeProfileFile('qwen', 'work', 'qwen.env', 'OLD-ENV');
    const plan = planSession(findCliDef('qwen')!, 'work', SID);
    await materializeSession(plan);
    await fs.writeFile(join(plan.roots[0].dir, 'settings.json'), 'NEW-SET');
    await fs.writeFile(join(plan.roots[0].dir, '.env'), 'NEW-ENV');
    // 종료 전 외부 삭제 모사 → settings 프로필 파일 부재 = preflight backup null.
    await fs.rm(profileFilePath('qwen', 'work', 'qwen-settings.json'));
    // settings(idx0) commit 성공 → .env(idx1) commit 실패 → 롤백: settings 는 backup null → 삭제.
    mockedCommit.mockImplementation((sp, cli, prof, file) =>
      file === 'qwen.env'
        ? Promise.reject(new Error('disk full'))
        : realCommit(sp, cli, prof, file)
    );
    await expect(recaptureSession(plan)).rejects.toThrow(/disk full/);
    expect(await readProfileFile('qwen', 'work', 'qwen-settings.json')).toBeNull(); // 삭제로 원복
    expect(await readProfileFile('qwen', 'work', 'qwen.env')).toBe('OLD-ENV'); // 미커밋 → 무변경
  });

  it('격리본 부재 cred 는 skip (stage/commit 안 함)', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'OLD');
    await writeBaseFile('.codex/config.toml', 'model=gpt'); // share 대상 — base 에 실파일 필요
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    await fs.rm(join(plan.roots[0].dir, 'auth.json')); // CLI 가 격리본 삭제 모사
    mockedStage.mockClear();
    mockedCommit.mockClear();
    await recaptureSession(plan);
    expect(mockedStage).not.toHaveBeenCalled();
    expect(mockedCommit).not.toHaveBeenCalled();
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
