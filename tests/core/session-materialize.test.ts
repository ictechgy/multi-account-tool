/**
 * PR-S2: session.ts 부작용 코어 (planSession / materializeSession / recaptureSession /
 * removeSessionDir) 단위 테스트. 임시 HOME fixture + 실제 파일/symlink.
 *
 * profile-store 는 partial mock — readProfileFile 는 실제, writeProfileFile 만 spy 로
 * 감싸 재캡처 실패/hang 을 주입한다 (C1 검증). materialize 의 자격증명 복사는 io-atomic
 * writeFileAtomic(실제) 를 쓰므로 mock 영향 없음.
 */

import { execFileSync } from 'node:child_process';
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

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  return (thrown as Error).message;
}

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

  it('share nested(다중 세그먼트) 항목은 거부 — 단일 세그먼트만 허용 (nested-path TOCTOU 제거, quad-review)', () => {
    const def: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: '~/.fake/auth.json', saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: '~/.fake', share: ['sub/config.toml'] }] }
    };
    expect(() => planSession(def, 'work', SID)).toThrow(/단일 세그먼트/);
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

  it('config.toml 은 base 원본의 0600 복사로 세션 디렉토리에 격리됨 (copy-isolate, #72)', async () => {
    // config.toml 이 share 에 있으므로 materializeSession 이 base 원본을 복사한다(symlink 아님).
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const copyPath = join(plan.roots[0].dir, 'config.toml');
    const st = await fs.lstat(copyPath);
    expect(st.isSymbolicLink()).toBe(false); // symlink 아님 — 복사본
    expect(st.mode & 0o777).toBe(0o600); // 자격증명과 동일 0600
    expect(await fs.readFile(copyPath, 'utf8')).toBe('model=gpt'); // 내용은 base 원본
  });

  it('세션 config.toml 복사본 수정은 base 로 write-back 되지 않음 (copy-isolate 핵심 보장, #72)', async () => {
    // codex mcp add/plugin add 가 세션 안에서 config.toml 을 수정하는 상황을 모사: 세션 격리본을
    // 직접 덮어쓴 뒤 base 원본이 무손상인지 확인한다. symlink 공유였다면 base 가 함께 바뀐다.
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    const target = await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const copyPath = join(plan.roots[0].dir, 'config.toml');
    // 세션 안에서 config 수정(mcp 서버 추가 등) 모사.
    await fs.writeFile(copyPath, 'model=gpt\n[mcp_servers.added]\ncommand = "x"\n');
    // base 원본은 무손상 — write-back 없음 (symlink 였다면 함께 바뀜).
    expect(await fs.readFile(target, 'utf8')).toBe('model=gpt');
    // 격리본만 바뀜.
    expect(await fs.readFile(copyPath, 'utf8')).toContain('[mcp_servers.added]');
  });

  it('recaptureSession 은 share(config.toml)를 재캡처하지 않음 — write-back 없음 (#72)', async () => {
    // PR 의 두 번째 핵심 주장 가드: share 는 cred 가 아니라 종료 재캡처(write-back) 대상이 아니다.
    // collectRecaptureItems 가 root.share 를 순회하도록 잘못 바뀌면 이 가드가 FAIL 한다(회귀 방어).
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    const target = await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    // 세션 안에서 config 수정(codex mcp add 등) 모사.
    await fs.writeFile(
      join(plan.roots[0].dir, 'config.toml'),
      'model=gpt\n[mcp_servers.x]\ncommand = "y"\n'
    );
    await recaptureSession(plan);
    // config.toml 은 cred 가 아니므로 프로필로 재캡처되지 않는다 (share 미순회 가드).
    expect(await readProfileFile('codex', 'work', 'config.toml')).toBeNull();
    // base config.toml 도 무손상 (재캡처는 base 를 건드리지 않는다).
    expect(await fs.readFile(target, 'utf8')).toBe('model=gpt');
    // 대조군: 자격증명(auth.json)은 정상 재캡처된다.
    expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('TOKEN-A');
  });

  it('codex share=[config.toml] → 세션 디렉토리에 복사본 config.toml(symlink 0개), cred(auth.json)도 실파일', async () => {
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    await writeBaseFile('.codex/config.toml', 'model=gpt');
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    await materializeSession(plan);
    const entries = await fs.readdir(plan.roots[0].dir, { withFileTypes: true });
    const symlinks = entries.filter((e) => e.isSymbolicLink()).map((e) => e.name);
    expect(symlinks).toEqual([]); // copy-isolate — symlink 0개
    const configSt = await fs.lstat(join(plan.roots[0].dir, 'config.toml'));
    expect(configSt.isSymbolicLink()).toBe(false); // config.toml 은 복사본(실파일)
    const authSt = await fs.lstat(join(plan.roots[0].dir, 'auth.json'));
    expect(authSt.isSymbolicLink()).toBe(false); // 자격증명도 실파일
  });

  it('base 에 config.toml 부재 시 — throw 없이 materialize 성공, config.toml 복사본 미생성 (optional skip)', async () => {
    // config.toml 은 read-mostly 설정이므로 부재해도 세션 진행에 지장 없다.
    // materializeShareCopy 는 ENOENT 를 skip(return)하고 세션을 정상 완료해야 한다.
    await writeProfileFile('codex', 'work', 'auth.json', 'TOKEN-A');
    // config.toml 미생성 — base 에 없음
    const plan = planSession(findCliDef('codex')!, 'work', SID);
    // throw 없이 완료 (optional share skip)
    await expect(materializeSession(plan)).resolves.toBeUndefined();
    // config.toml 복사본 미생성
    const copyPath = join(plan.roots[0].dir, 'config.toml');
    await expect(fs.access(copyPath)).rejects.toThrow();
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

  it('allow-list 항목 = base 원본의 0600 복사 (symlink 아님, base 무손상)', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    const target = await writeBaseFile('.fake/config.toml', 'shared-config');
    const plan = planSession(fakeDef, 'work', SID);
    await materializeSession(plan);
    const copyPath = join(plan.roots[0].dir, 'config.toml');
    const st = await fs.lstat(copyPath);
    expect(st.isSymbolicLink()).toBe(false); // 복사본 — symlink 아님
    expect(st.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(copyPath, 'utf8')).toBe('shared-config'); // 내용=base 원본
    expect(await fs.realpath(copyPath)).not.toBe(await fs.realpath(target)); // 별도 파일(공유 아님)
  });

  it('allow-list 대상이 base 에서 symlink 면 거부 + 세션 디렉토리 미잔류', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await writeBaseFile('.fake/real.toml', 'x');
    await fs.symlink(join(tmp.home, '.fake/real.toml'), join(tmp.home, '.fake/config.toml'));
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow();
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });

  it('allow-list symlink 오류 메시지의 path control char 를 sanitize', async () => {
    const controlBase = join(tmp.home, 'fake-\x1b[31m');
    const def: CliDef = {
      id: 'fakecli', name: 'Fake',
      sources: [{ type: 'file', path: join(controlBase, 'auth.json'), saveAs: 'a.json' }],
      session: { roots: [{ env: 'FAKE_HOME', base: controlBase, share: ['config.toml'] }] }
    };
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await fs.mkdir(controlBase, { recursive: true });
    await fs.writeFile(join(controlBase, 'real.toml'), 'x');
    await fs.symlink(join(controlBase, 'real.toml'), join(controlBase, 'config.toml'));

    const plan = planSession(def, 'work', SID);
    const message = await rejectedMessage(materializeSession(plan));

    expect(message).toContain('allow-list 대상이 symlink');
    expect(message).toContain('fake-?[31m');
    expect(message).not.toMatch(CONTROL_CHAR_RE);
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });

  it('allow-list realpath escape 오류 메시지의 nested path control char 를 sanitize (방어적 plan)', async () => {
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await writeBaseFile('.fake/auth.json', 'base-tok');
    const outside = join(tmp.home, 'outside-share');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, 'config.toml'), 'shared');
    const linkName = 'link-\x1b[31m';
    await fs.symlink(outside, join(tmp.home, '.fake', linkName));
    const plan = planSession(fakeDef, 'work', SID);
    // public planSession 은 nested share 를 거부한다. 여기서는 assertContainedRealpath 의
    // defense-in-depth throw 메시지를 검증하기 위해 plan 객체만 직접 변형한다.
    plan.roots[0].share = [`${linkName}/config.toml`];

    const message = await rejectedMessage(materializeSession(plan));

    expect(message).toContain('allow-list 대상이 base 밖');
    expect(message).toContain('link-?[31m');
    expect(message).not.toMatch(CONTROL_CHAR_RE);
    await expect(fs.access(sessionDir(SID))).rejects.toThrow();
  });

  it('allow-list 대상이 base 에 부재면 skip — throw 없이 materialize 성공, 링크 미생성 (optional)', async () => {
    // config.toml 등 read-mostly 설정 파일이 없어도 세션은 정상 진행된다.
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    // config.toml 미생성
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).resolves.toBeUndefined();
    // config.toml 복사본 미생성
    const copyPath = join(plan.roots[0].dir, 'config.toml');
    await expect(fs.access(copyPath)).rejects.toThrow();
    // creds 격리본(auth.json — cred.rel) 은 정상 생성됨
    // fakeDef source path=~/.fake/auth.json → cred.rel='auth.json', absInSession=dir/auth.json
    expect(await fs.readFile(join(plan.roots[0].dir, 'auth.json'), 'utf8')).toBe('TOK');
  });

  // (제거) 'nested share 복사' / 'base 측 부모 symlink escape 거부' 테스트는 share 가 단일 세그먼트로
  // 제한되며 폐기됐다 — nested share 는 planSession 에서 거부돼 materialize 에 도달하지 않는다(위
  // 'share nested 항목은 거부' 가 plan 단계 거부를 고정). base 측 share 대상 자체가 symlink 인 경우의
  // 거부는 'allow-list 대상이 base 에서 symlink 면 거부' 테스트가 단일 세그먼트로 그대로 커버한다.

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

  it('allow-list 대상이 FIFO(특수파일)면 거부 (isFile 가드 — open 블록 차단)', async () => {
    // isFile() 가드가 디렉토리뿐 아니라 FIFO/소켓 등 비-일반 파일도 거부하는지(open 전 차단)
    // 명시 회귀 가드. FIFO 를 O_RDONLY 로 열면 writer 부재 시 블록될 수 있어, isFile() 거부가 중요.
    await writeProfileFile('fakecli', 'work', 'a.json', 'TOK');
    await fs.mkdir(join(tmp.home, '.fake'), { recursive: true });
    execFileSync('mkfifo', [join(tmp.home, '.fake', 'config.toml')]);
    const plan = planSession(fakeDef, 'work', SID);
    await expect(materializeSession(plan)).rejects.toThrow(/일반 파일이 아닙니다/);
    await expect(fs.access(sessionDir(SID))).rejects.toThrow(); // 세션 디렉토리 미잔류
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

  it('정상 id → 디렉토리 삭제, 복사 원본 base 무손상 (copy-isolate)', async () => {
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
    // 복사 원본 base 는 남아있음 (격리본만 삭제 — symlink 가 아니라 별도 파일).
    expect(await fs.readFile(target, 'utf8')).toBe('shared');
  });
});
