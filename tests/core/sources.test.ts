/**
 * sources 단위 테스트.
 *
 * file/keychain dual-branch 의 readSource/writeSource/sourceExists + 내부 헬퍼
 * (runCommand, keychainSet 의 backup/rollback 시퀀스) 검증.
 *
 * Mock 전략:
 *  - file branch: real fs (setupTmpHome 의 \$HOME 격리)
 *  - keychain branch: node:child_process.spawn 을 vi.mock 으로 격리 + 가상
 *    security CLI 응답 시뮬레이션 (실제 사용자 keychain 무손상)
 *  - process.platform 분기 (darwin vs 그 외) 는 Object.defineProperty 로 케이스별 override
 *    (vi.stubGlobal 은 process 전체를 교체하지 않으므로 platform 만 변경하려면 defineProperty 가 정확)
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}));

import { spawn } from 'node:child_process';

import { readSource, runCommand, sourceExists, writeSource } from '../../src/core/sources.js';
import { KeychainAccountMissingError } from '../../src/core/errors.js';
import type { FileSource, KeychainSource, KeychainStored } from '../../src/core/types.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const mockSpawn = vi.mocked(spawn);

/**
 * security CLI 응답 시뮬레이션용 fake process.
 * stdout/stderr 데이터를 비동기 emit 후 close 이벤트.
 * error 옵션이 있으면 close 대신 error 이벤트만 emit.
 *
 * 반환 타입은 `ChildProcessWithoutNullStreams` 로 cast (spawn 호환) — `as never`
 * 캐스트를 callsite 마다 반복하지 않고 한 곳에 격리.
 */
/**
 * fakeProc 의 writable stdin sink.
 * runCommand 의 stdin 주입 경로 (proc.stdin.write/end) 를 검증할 수 있도록 write 호출을
 * 기록한다. `stdinError` 가 주어지면 write 시 'error' 이벤트를 emit 해 EPIPE 류를 시뮬레이션.
 * `throwOnWrite` 가 주어지면 write 호출 시 동기 throw — Node 의 write-after-end /
 * destroyed stdin (ERR_STREAM_*) 동기 throw 를 재현해 runCommand 의 try/catch 흡수를 검증한다.
 */
class FakeStdin extends EventEmitter {
  /** write 로 전달된 chunk 누적 — secret 이 stdin 으로 전달됐는지 검증용. */
  public readonly writes: string[] = [];
  /** end() 가 호출됐는지 기록 — stdin EOF 전달 검증용. */
  public ended = false;

  constructor(
    private readonly stdinError?: Error,
    /** write 시 동기 throw 할 에러 (write-after-end / destroyed 재현용) */
    private readonly throwOnWrite?: Error,
  ) {
    super();
  }

  write(chunk: string): boolean {
    // 동기 throw 재현: settled-guard 우회 (Promise reject) 가 일어나면 안 됨을 검증하기 위한 결함 주입.
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.writes.push(chunk);
    // EPIPE 시뮬레이션: 자식이 stdin 을 먼저 닫은 경우 write 가 error 이벤트를 낸다.
    if (this.stdinError) setImmediate(() => this.emit('error', this.stdinError));
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

function fakeProc(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  /** error 후 close 도 emit (production 의 ENOENT 시 실제 동작 — settled-guard 검증용) */
  emitCloseAfterError?: boolean;
  /** stdin.write 시 emit 할 에러 (EPIPE 류 — settled-guard 검증용) */
  stdinError?: Error;
  /** stdin.write 시 동기 throw 할 에러 (write-after-end / destroyed 재현 — HIGH 결함 가드) */
  stdinThrowOnWrite?: Error;
}): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: FakeStdin;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new FakeStdin(opts.stdinError, opts.stdinThrowOnWrite);

  setImmediate(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      if (opts.emitCloseAfterError) {
        // 다음 tick 에 close 도 emit — runCommand 의 settled flag 가 무시해야 한다.
        setImmediate(() => proc.emit('close', -1));
      }
      return;
    }
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0);
  });

  return proc as unknown as ChildProcessWithoutNullStreams;
}

/**
 * mockSpawn.mock.calls 에서 특정 security CLI action 을 인자에 포함한 호출들을 반환.
 * 각 항목은 spawn 호출 튜플 `[cmd, args]` (call[0] = SECURITY_BIN, call[1] = argv).
 *
 * `mock.calls[N]` 매직 인덱스는 spawn 호출 순서 변경 시 silently mis-mapping 위험 —
 * find by argument 로 시퀀스 변화에 견고화.
 */
function findSpawnCallsByArg(action: string) {
  return mockSpawn.mock.calls.filter(call => (call[1] as string[]).includes(action));
}

/** security CLI 의 find-generic-password (account 포함) 출력 형식 시뮬레이션. */
function findOutputWithAcct(acct: string): string {
  return [
    'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    `    "acct"<blob>="${acct}"`,
    '    "svce"<blob>="Test Service"'
  ].join('\n');
}

describe('sources — file branch (real fs)', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.clearAllMocks();
    await tmp.cleanup();
  });

  it('readSource(file): 파일 존재 → 내용 반환', async () => {
    const path = join(tmp.home, 'auth.json');
    await fs.writeFile(path, '{"token":"x"}');
    const src: FileSource = { type: 'file', path, saveAs: 'auth.json' };
    expect(await readSource(src)).toBe('{"token":"x"}');
  });

  it('readSource(file): 파일 없음 → null (ENOENT swallow)', async () => {
    const src: FileSource = { type: 'file', path: join(tmp.home, 'absent.json'), saveAs: 'a.json' };
    expect(await readSource(src)).toBeNull();
  });

  it('readSource(file): ~/ tilde 가 home 으로 확장됨', async () => {
    const path = join(tmp.home, 'home-rel.json');
    await fs.writeFile(path, 'home-value');
    const src: FileSource = { type: 'file', path: '~/home-rel.json', saveAs: 'a.json' };
    expect(await readSource(src)).toBe('home-value');
  });

  it('writeSource(file): atomic write + 0o600 권한', async () => {
    const path = join(tmp.home, 'new.json');
    const src: FileSource = { type: 'file', path, saveAs: 'a.json' };
    await writeSource(src, '{"v":1}');

    expect(await fs.readFile(path, 'utf8')).toBe('{"v":1}');
    const stat = await fs.stat(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writeSource(file): 기존 파일 atomic replace', async () => {
    const path = join(tmp.home, 'existing.json');
    await fs.writeFile(path, 'old');
    const src: FileSource = { type: 'file', path, saveAs: 'a.json' };
    await writeSource(src, 'new');
    expect(await fs.readFile(path, 'utf8')).toBe('new');
  });

  it('sourceExists(file): 존재 → true, 없음 → false', async () => {
    const path = join(tmp.home, 'check.json');
    const src: FileSource = { type: 'file', path, saveAs: 'a.json' };
    expect(await sourceExists(src)).toBe(false);
    await fs.writeFile(path, 'x');
    expect(await sourceExists(src)).toBe(true);
  });

  it('readSource(file): non-ENOENT 에러 (EISDIR — path 가 디렉토리) → throw 전파', async () => {
    // production readFileOrNull 의 catch 는 ENOENT 만 swallow → 다른 에러 (EISDIR 등) 는 그대로 throw.
    const dirPath = join(tmp.home, 'is-a-dir');
    await fs.mkdir(dirPath);
    const src: FileSource = { type: 'file', path: dirPath, saveAs: 'a.json' };
    await expect(readSource(src)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('sources — keychain branch (spawn mock, darwin 가정)', () => {
  let tmp: TmpHome;
  let originalPlatform: NodeJS.Platform;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
    // process.platform 을 darwin 으로 stub (sources.ts 는 함수 호출 시점에 검사).
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    await tmp.cleanup();
  });

  const KEYCHAIN_SRC: KeychainSource = {
    type: 'keychain',
    service: 'Test Service',
    saveAs: 'credentials.json'
  };

  describe('readSource(keychain)', () => {
    it('항목 존재 → KeychainStored JSON (value + account)', async () => {
      mockSpawn
        // 1st call: find -s -w (value)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'secret-token\n' }))
        // 2nd call: find -s (account 메타)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('user@example.com') }));

      const raw = await readSource(KEYCHAIN_SRC);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.value).toBe('secret-token');
      expect(parsed.account).toBe('user@example.com');
    });

    it('account 없음 (빈 acct) → KeychainStored.account = undefined', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'secret-token' }))
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('') }));

      const raw = await readSource(KEYCHAIN_SRC);
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.account).toBeUndefined();
    });

    it('keychainGetAccount regex: acct 라인 없는 stdout → account=undefined (false-negative 안전)', async () => {
      // production keychainGetAccount 의 `/"acct"<blob>="([^"]*)"/` 가 매치 안 되면 null 반환.
      // 따라서 KeychainStored.account = undefined 가 안전한 fallback.
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'secret-token' }))
        // stdout 에 acct 라인 자체가 없음 (security CLI 출력 형식이 다른 경우)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'keychain: "/Users/test/Library/..."\nclass: "genp"' }));

      const raw = await readSource(KEYCHAIN_SRC);
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.value).toBe('secret-token');
      expect(parsed.account).toBeUndefined();
    });

    it('항목 없음 (errSecItemNotFound, code 44) → null', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 44, stderr: 'security: ...could not be found in keychain.' })
      );
      expect(await readSource(KEYCHAIN_SRC)).toBeNull();
    });

    it('항목 없음 (코드 다름 + "could not be found" 메시지) → null (regex fallback)', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 1, stderr: 'security: item could not be found' })
      );
      expect(await readSource(KEYCHAIN_SRC)).toBeNull();
    });

    it('다른 에러 → throw (redacted message)', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 2, stderr: 'access denied' })
      );
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/keychain 읽기 실패/);
    });

    it('non-darwin platform → throw "macOS 에서만 지원"', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/macOS 에서만 지원/);
    });
  });

  describe('writeSource(keychain) — backup → delete → add 시퀀스', () => {
    it('신규 (기존 없음): backup null → delete skip → add 만 호출 (SECURITY_BIN + -A ACL 검증)', async () => {
      mockSpawn
        // keychainGetValue (find -w) → not found
        .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }))
        // add-generic-password
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new-token', account: 'alice' };
      await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      // find by argument — spawn 호출 순서 변경에도 견고.
      const [addCall] = findSpawnCallsByArg('add-generic-password');
      expect(addCall).toBeDefined();
      // SECURITY_BIN 절대경로 검증 — PATH shim 우회 방어 (sources.ts SECURITY_BIN 상수).
      expect(addCall[0]).toBe('/usr/bin/security');
      expect(addCall[1]).toContain('-a');
      expect(addCall[1]).toContain('alice');
      expect(addCall[1]).toContain('-w');
      expect(addCall[1]).toContain('new-token');
      // -A ACL 플래그 검증 (회귀 가드 — README "보안" 섹션의 의도된 trade-off).
      expect(addCall[1]).toContain('-A');
    });

    it('기존 있음: backup value + account 조회 → 정확한 acct 로 delete → add', async () => {
      mockSpawn
        // 1. keychainGetValue (find -w) → 'old-token'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token\n' }))
        // 2. keychainGetAccount (find -s) → 'bob'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }))
        // 3. delete (with -a bob)
        .mockReturnValueOnce(fakeProc({ code: 0 }))
        // 4. add (new)
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new-token', account: 'alice' };
      await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

      const [deleteCall] = findSpawnCallsByArg('delete-generic-password');
      expect(deleteCall).toBeDefined();
      // 정확한 acct (bob) 로 delete — service-only 삭제 회피
      expect(deleteCall[1]).toContain('-a');
      expect(deleteCall[1]).toContain('bob');
    });

    it('기존 있음 but account 못 잡음: KeychainAccountMissingError throw — delete/add 명령 미발급', async () => {
      // 회귀 가드: 이전 버전은 console.warn 후 service-only delete 를 수행해
      // 동일 service 의 타 항목까지 영구 삭제될 위험이 있었다. 새 정책은 throw 로
      // swap 자체를 거부 — Keychain 의 acct 메타가 비정상이면 사용자가 수동 정리해야 함.
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }))
        // account 조회: code 0 이지만 acct 라인 없음 → keychainGetAccount = null
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'no acct line here' }));

      const stored: KeychainStored = { value: 'new', account: 'alice' };
      // PR #10 quad-review Claude-2 합의: KeychainAccountMissingError 클래스로 분기 가능.
      // rejects.toThrow(Class) 는 instanceof 검증.
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(KeychainAccountMissingError);

      // PR #10 quad-review Forge-2 합의: 보안 invariant 직접 검증.
      // 호출 횟수 (toHaveBeenCalledTimes(2)) 는 fragile — 무해한 read 추가 시 false fail.
      // 대신 mutation 명령 (delete-generic-password / add-generic-password) 부재를 명시 검증.
      const mutations = mockSpawn.mock.calls.filter(call => {
        const args = call[1] as string[];
        return args.some(a => a === 'delete-generic-password' || a === 'add-generic-password');
      });
      expect(mutations).toEqual([]);
    });

    it('KeychainAccountMissingError: error.service 필드로 호출자가 어느 service 인지 분기 가능', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old' }))
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'no acct' }));

      const stored: KeychainStored = { value: 'new' };
      try {
        await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(KeychainAccountMissingError);
        expect((err as KeychainAccountMissingError).service).toBe('Test Service');
        expect((err as KeychainAccountMissingError).name).toBe('KeychainAccountMissingError');
      }
    });

    it('add 실패 시 backup 으로 롤백 + 원본 에러 throw', async () => {
      mockSpawn
        // backup value 있음
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }))
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }))
        // delete OK
        .mockReturnValueOnce(fakeProc({ code: 0 }))
        // add 실패
        .mockReturnValueOnce(fakeProc({ code: 5, stderr: 'add failed' }))
        // 롤백 add (성공)
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new', account: 'alice' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/keychain 쓰기 실패/);

      // 롤백 add 는 add-generic-password 호출 중 두 번째 (첫 번째는 실패한 새 값 시도).
      const addCalls = findSpawnCallsByArg('add-generic-password');
      expect(addCalls).toHaveLength(2);
      const rollbackCall = addCalls[1];
      expect(rollbackCall[0]).toBe('/usr/bin/security');
      expect(rollbackCall[1]).toContain('old-token');
      expect(rollbackCall[1]).toContain('bob');
      // 롤백 add 도 -A 포함 (회귀 가드 — backup ACL 보존, Claude 토큰 접근 권한 유지).
      expect(rollbackCall[1]).toContain('-A');
    });

    it('add 실패 + 롤백도 실패 → "백업 복구도 실패" note 포함', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old' }))
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }))
        .mockReturnValueOnce(fakeProc({ code: 0 }))
        .mockReturnValueOnce(fakeProc({ code: 5, stderr: 'add failed' }))
        // 롤백 add 도 실패
        .mockReturnValueOnce(fakeProc({ code: 6, stderr: 'rollback also failed' }));

      const stored: KeychainStored = { value: 'new' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/백업 복구도 실패/);
    });

    it('백업 delete 자체가 실패 → throw "백업 항목 삭제 실패"', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old' }))
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }))
        // delete 실패
        .mockReturnValueOnce(fakeProc({ code: 7, stderr: 'delete failed' }));

      const stored: KeychainStored = { value: 'new' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/백업 항목 삭제 실패/);
    });

    it('non-darwin → throw "macOS 에서만 지원"', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const stored: KeychainStored = { value: 'x' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/macOS 에서만 지원/);
    });

    it('account 미지정 시 $USER 또는 default 사용', async () => {
      const origUser = process.env.USER;
      process.env.USER = 'env-user';
      try {
        mockSpawn
          .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }))
          .mockReturnValueOnce(fakeProc({ code: 0 }));

        const stored: KeychainStored = { value: 'v' };  // account 없음
        await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

        const [addCall] = findSpawnCallsByArg('add-generic-password');
        expect(addCall).toBeDefined();
        expect(addCall[1]).toContain('env-user');
      } finally {
        if (origUser === undefined) delete process.env.USER;
        else process.env.USER = origUser;
      }
    });
  });

  describe('sourceExists(keychain)', () => {
    it('존재 → true (stdout 무관, code 만 확인)', async () => {
      // production keychainExists 는 r.code === 0 만 본다. stdout 페이로드는 무관.
      // 비워서 misleading 회피.
      mockSpawn.mockReturnValueOnce(fakeProc({ code: 0 }));
      expect(await sourceExists(KEYCHAIN_SRC)).toBe(true);
      // find -s 호출 (find -w 가 아님) 검증 — `-w` 가 없어야 함.
      const [findCall] = findSpawnCallsByArg('find-generic-password');
      expect(findCall).toBeDefined();
      expect(findCall[1]).not.toContain('-w');
    });

    it('없음 (code 44) → false', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 44, stderr: 'not found' })
      );
      expect(await sourceExists(KEYCHAIN_SRC)).toBe(false);
    });
  });

  /**
   * KeychainSource.account 가 명시된 경우 — Goose/Copilot 류 multi-account 시나리오.
   *
   * 핵심 invariant:
   *   1) 모든 find/delete/exists 호출이 `-a src.account` 로 scope → 동일 service 의
   *      타 account 항목은 영향 없음.
   *   2) 새 항목 add 의 `-a` 도 src.account 사용 (stored.account 가 달라도 덮어씀).
   *   3) src.account 항목이 존재하지 않으면 delete skip → 다른 account 항목 보존된 채 신규 add.
   */
  describe('KeychainSource.account 명시 — multi-account scope', () => {
    const SCOPED_SRC: KeychainSource = {
      type: 'keychain',
      service: 'goose',
      account: 'secrets',
      saveAs: 'goose-secrets.json'
    };

    function argsAfter(args: string[], flag: string): string | undefined {
      const i = args.indexOf(flag);
      return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    }

    it('readSource: find -s service -a account -w 로 scope (다른 account 항목 미간섭)', async () => {
      mockSpawn
        // 1) keychainGetValue (find -s -a -w)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'scoped-token' }))
        // 2) keychainGetAccount (find -s -a)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('secrets') }));

      const raw = await readSource(SCOPED_SRC);
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.value).toBe('scoped-token');
      expect(parsed.account).toBe('secrets');

      const findCalls = findSpawnCallsByArg('find-generic-password');
      expect(findCalls).toHaveLength(2);
      // 두 호출 모두 -a secrets 포함
      for (const call of findCalls) {
        expect(call[1]).toContain('-a');
        expect(argsAfter(call[1] as string[], '-a')).toBe('secrets');
      }
    });

    it('sourceExists: -a account 로 scope — 해당 account 항목만 검사', async () => {
      mockSpawn.mockReturnValueOnce(fakeProc({ code: 0 }));
      expect(await sourceExists(SCOPED_SRC)).toBe(true);

      const [findCall] = findSpawnCallsByArg('find-generic-password');
      expect(findCall[1]).toContain('-a');
      expect(argsAfter(findCall[1] as string[], '-a')).toBe('secrets');
      expect(findCall[1]).not.toContain('-w');
    });

    it('writeSource (신규, 같은 service 의 타 account 존재): -a account scoped find → 신규로 인식 → delete skip + add 만 -a src.account', async () => {
      // 회귀 가드: src.account scope 가 적용되지 않으면 keychainGetValue 가 service-only 로
      // 다른 account 항목을 잘못 잡아 backup → delete 로 그 항목을 영구 삭제하는 사고 발생.
      mockSpawn
        // keychainGetValue (find -s -a secrets -w) → not found (다른 account 항목은 무시)
        .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }))
        // add (신규)
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new-token' };
      await writeSource(SCOPED_SRC, JSON.stringify(stored));

      // mutation 명령 검증 — delete 부재, add 1회.
      const deleteCalls = findSpawnCallsByArg('delete-generic-password');
      expect(deleteCalls).toEqual([]);
      const addCalls = findSpawnCallsByArg('add-generic-password');
      expect(addCalls).toHaveLength(1);
      expect(argsAfter(addCalls[0][1] as string[], '-a')).toBe('secrets');

      // backup find 도 -a 로 scope 되었는지 검증 (회귀 가드 핵심).
      const findCalls = findSpawnCallsByArg('find-generic-password');
      expect(findCalls.every(c => (c[1] as string[]).includes('-a'))).toBe(true);
      expect(findCalls.every(c => argsAfter(c[1] as string[], '-a') === 'secrets')).toBe(true);
    });

    it('writeSource (기존 같은 account 항목 존재): scoped backup → delete -a account → add -a account', async () => {
      mockSpawn
        // keychainGetValue (find -s -a secrets -w) → 'old-token'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }))
        // keychainGetAccount (find -s -a secrets) → 'secrets'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('secrets') }))
        // delete -s goose -a secrets
        .mockReturnValueOnce(fakeProc({ code: 0 }))
        // add
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new-token', account: 'secrets' };
      await writeSource(SCOPED_SRC, JSON.stringify(stored));

      const [deleteCall] = findSpawnCallsByArg('delete-generic-password');
      expect(argsAfter(deleteCall[1] as string[], '-a')).toBe('secrets');
      const [addCall] = findSpawnCallsByArg('add-generic-password');
      expect(argsAfter(addCall[1] as string[], '-a')).toBe('secrets');
    });

    it('writeSource: src.account 우선순위 — stored.account 가 달라도 src.account 로 add', async () => {
      // src.account 가 정의에 명시되어 있으면, 캡처 시점 stored.account 가 다른 값이어도
      // 정의가 의도한 account 로 복원해야 한다 (multi-account 도구의 명시적 swap 의도 보존).
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }))
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'v', account: 'different-user' };
      await writeSource(SCOPED_SRC, JSON.stringify(stored));

      const [addCall] = findSpawnCallsByArg('add-generic-password');
      // src.account ('secrets') 가 우선 — stored.account ('different-user') 가 아닌.
      expect(argsAfter(addCall[1] as string[], '-a')).toBe('secrets');
      expect(addCall[1]).not.toContain('different-user');
    });

    it.each([
      ['빈 문자열', ''],
      ['NUL 포함', 'has\x00nul']
    ])('writeSource: src.account 가 유효하지 않으면 (%s) throw — security CLI 호출 0회 (quad-review 합의 HIGH)', async (_label, badAccount) => {
      // 회귀 가드 (quad-review Codex 합의 high confidence): 이전 동작은 빈 문자열 fallthrough 로
      // `keychainSet` 의 `scopeAccount` 인자가 빈 문자열이 되어 backup lookup/delete 가
      // service-only 로 떨어졌다 — 동일 service 의 임의 account 항목을 잘못 잡아 영구
      // 삭제할 위험. 새 정책은 `assertValidKeychainSource` 가 source 진입부에서 throw 한다.
      // parseSource 가 외부 입력은 거르지만, internal API 사용자나 corrupt 정의가 직접
      // 잘못된 account 를 넣어도 silent fallback 으로 떨어지지 않게 차단.
      const badSrc: KeychainSource = {
        type: 'keychain',
        service: 'goose',
        account: badAccount,
        saveAs: 'goose-secrets.json'
      };

      const stored: KeychainStored = { value: 'v', account: 'stored-user' };
      await expect(writeSource(badSrc, JSON.stringify(stored)))
        .rejects.toThrow(/KeychainSource\.account 가 유효하지 않습니다/);

      // security CLI 가 호출되어선 안 됨 — 검증은 spawn 보다 먼저.
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('readSource: src.account 가 유효하지 않으면 throw — backup find scope 누설 차단', async () => {
      // 회귀 가드: readKeychainSerialized 도 동일 검증 (sourceExists 와 함께 모든 keychain 진입점).
      const badSrc: KeychainSource = {
        type: 'keychain', service: 'goose', account: '', saveAs: 'a.json'
      };
      await expect(readSource(badSrc))
        .rejects.toThrow(/KeychainSource\.account 가 유효하지 않습니다/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('sourceExists: src.account 가 유효하지 않으면 throw — find 호출 0회', async () => {
      const badSrc: KeychainSource = {
        type: 'keychain', service: 'goose', account: '\x00', saveAs: 'a.json'
      };
      await expect(sourceExists(badSrc))
        .rejects.toThrow(/KeychainSource\.account 가 유효하지 않습니다/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('src.account 검증 오류는 opaque service 를 raw 로 노출하지 않는다', async () => {
      const opaqueService = 'a'.repeat(32);
      const badSrc: KeychainSource = {
        type: 'keychain',
        service: opaqueService,
        account: '',
        saveAs: 'a.json'
      };
      await expect(readSource(badSrc))
        .rejects.toThrow(/service=\[redacted\]/);
      await expect(readSource(badSrc))
        .rejects.not.toThrow(opaqueService);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('writeSource: stored.account 에 NUL 포함 시 hasAccount 가 거부 → USER fallback (NUL 일관성)', async () => {
      // 회귀 가드 (quad-review Codex-2 LOW 합의): stored.account 가 corrupt 로 NUL 포함시
      // 이전엔 hasAccount("\x00user") 가 truthy → spawn argv 에 NUL 전달 → 실패.
      // 새 정책: hasAccount 가 NUL 차단 → stored.account 우선순위 통과 못 함 → USER fallback.
      const origUser = process.env.USER;
      process.env.USER = 'env-user';
      try {
        mockSpawn
          .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }))
          .mockReturnValueOnce(fakeProc({ code: 0 }));

        // src.account 미지정 (legacy 단일-account source), stored.account 가 NUL 포함.
        const stored: KeychainStored = { value: 'v', account: 'has\x00nul' };
        await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

        const [addCall] = findSpawnCallsByArg('add-generic-password');
        // NUL 거부 → 다음 우선순위 USER 채택.
        expect(argsAfter(addCall[1] as string[], '-a')).toBe('env-user');
        expect(addCall[1]).not.toContain('has\x00nul');
      } finally {
        if (origUser === undefined) delete process.env.USER;
        else process.env.USER = origUser;
      }
    });

    it('writeSource: corrupt KeychainStored (value 가 문자열 아님) → throw, security CLI 호출 0회', async () => {
      // 회귀 가드: legacy/corrupt backup 파일이 들어와도 -w undefined argv build 사고 차단.
      const corrupt = JSON.stringify({ value: 42, account: 'x' });  // value: number
      await expect(writeSource(KEYCHAIN_SRC, corrupt))
        .rejects.toThrow(/keychain backup 이 손상되었습니다/);
      // security CLI 자체가 호출되어선 안 됨 — corrupt 검증은 parse 직후.
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('keychainSet rollback: add 실패 시 backupAccount 명시 사용 — wrong-account 복구 회귀 가드', async () => {
      // 117행 가드(KeychainAccountMissingError)로 backupAccount 는 backup 분기 진입 시
      // 항상 truthy 보장. rollback 의 -a 인자는 새 항목 account 가 아닌 backupAccount.
      // 회귀 가드: 미래에 117행 가드가 약화되어도 rollback 이 wrong-account 로 복구 안 함.
      mockSpawn
        // backup value 있음
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }))
        // backup account = bob
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }))
        // delete OK
        .mockReturnValueOnce(fakeProc({ code: 0 }))
        // add 실패 — 새 account 는 'alice'
        .mockReturnValueOnce(fakeProc({ code: 5, stderr: 'add failed' }))
        // 롤백 add — backupAccount(bob) 사용해야 함, alice 가 아니라.
        .mockReturnValueOnce(fakeProc({ code: 0 }));

      const stored: KeychainStored = { value: 'new', account: 'alice' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/keychain 쓰기 실패/);

      const addCalls = findSpawnCallsByArg('add-generic-password');
      expect(addCalls).toHaveLength(2);
      const [, rollbackCall] = addCalls;
      // rollback 의 -a 는 정확히 backupAccount('bob') — `|| account` fallback 으로 'alice' 가 새지 않음.
      expect(argsAfter(rollbackCall[1] as string[], '-a')).toBe('bob');
      expect(rollbackCall[1]).not.toContain('alice');
    });
  });

  describe('runCommand 의 spawn error/close race', () => {
    it('spawn error 이벤트 → code -1 으로 settle (keychain 읽기 실패 throw)', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ error: new Error('ENOENT: /usr/bin/security') })
      );
      // error 이벤트 → code -1 settle → KEYCHAIN_NOT_FOUND 아니므로 throw.
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/keychain 읽기 실패.*-1/);
    });

    it('spawn error 후 close 도 emit → settled-guard 가 2번째 호출 무시 (단일 settle 보장)', async () => {
      // production runCommand 의 settled flag 가 정확히 동작하는지 — error → close 시퀀스에서
      // 두 번째 emit 이 무시되어야 한다 (단일 resolve, 두 번 reject/처리 안 함).
      mockSpawn.mockReturnValueOnce(
        fakeProc({ error: new Error('ENOENT'), emitCloseAfterError: true })
      );
      // throw 1회만 발생 — race 로 두 번 throw 되거나 unhandled rejection 발생하면 안 됨.
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/keychain 읽기 실패/);
    });
  });
});

describe('runCommand — stdin 주입 (PR-3a infra, secret-tool store 전제)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) stdinData 주어지면 그 값이 proc.stdin.write 에 전달되고 end() 호출됨', async () => {
    // FakeStdin 의 writes/ended 를 검증하기 위해 fakeProc 를 직접 참조한다.
    const proc = fakeProc({ code: 0, stdout: 'ok' });
    mockSpawn.mockReturnValueOnce(proc);

    await runCommand('/usr/bin/secret-tool', ['store'], 'my-secret-value');

    const stdin = (proc as unknown as { stdin: { writes: string[]; ended: boolean } }).stdin;
    expect(stdin.writes).toEqual(['my-secret-value']);
    expect(stdin.ended).toBe(true);
  });

  it('(b) stdinData 로 준 secret 은 argv (spawn args) 에 절대 나타나지 않음 — 미노출 회귀 가드', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0 }));

    const secret = 'super-secret-token-xyz';
    await runCommand('/usr/bin/secret-tool', ['store', '--label=Test'], secret);

    // spawn 의 모든 호출의 argv (call[1]) 어디에도 secret 이 없어야 한다.
    for (const call of mockSpawn.mock.calls) {
      const argv = call[1] as string[];
      expect(argv).not.toContain(secret);
      expect(argv.some(a => a.includes(secret))).toBe(false);
    }
  });

  it('(c) stdin write 에러(EPIPE) 는 흡수되고 settle 은 close 의 exit code 로 수행 — error 가 settle 을 가로채지 않음', async () => {
    // stdin.write 시 error 를 emit 하는 fakeProc (stdin error 가 close 보다 먼저 큐잉됨 — 결정론적).
    // 채택 설계(흡수+close): stdin error 는 흡수만 하고 settle 은 close 가 실제 exit code(0)로 수행해야 한다.
    mockSpawn.mockReturnValueOnce(
      fakeProc({ code: 0, stdout: 'done', stdinError: new Error('EPIPE') })
    );

    const result = await runCommand('/usr/bin/secret-tool', ['store'], 'val');
    // stdin EPIPE 후에도 close 의 code(0)로 settle — stdin error 가 settle(-1) 로 가로채면 실패.
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('(c-2) stdin write 가 동기 throw 해도 Promise reject 없이 close 의 exit code 로 settle — HIGH 결함 회귀 가드', async () => {
    // write-after-end / destroyed stdin 의 동기 throw 재현. fix 전이면 throw 가 Promise executor 를
    // 빠져나가 settled-guard 를 우회 → Promise reject. fix 후엔 try/catch 흡수 → close 가 정상 settle.
    mockSpawn.mockReturnValueOnce(
      fakeProc({ code: 0, stdout: 'done', stdinThrowOnWrite: new Error('ERR_STREAM_WRITE_AFTER_END') })
    );

    // reject 없이 단일 값으로 완료해야 하며, code 는 close 의 값(0)이어야 한다.
    const result = await runCommand('/usr/bin/secret-tool', ['store'], 'val');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('(d) stdinData 미주어지면 stdin 미접촉 — 기존 동작 byte-동등 (write/end 미호출)', async () => {
    const proc = fakeProc({ code: 0, stdout: 'plain' });
    mockSpawn.mockReturnValueOnce(proc);

    const result = await runCommand('/usr/bin/security', ['find-generic-password']);

    const stdin = (proc as unknown as { stdin: { writes: string[]; ended: boolean } }).stdin;
    expect(stdin.writes).toEqual([]);
    expect(stdin.ended).toBe(false);
    expect(result.stdout).toBe('plain');
    expect(result.code).toBe(0);
  });
});

// os-keyring branch 의 실제 구현(secret-tool) 검증은 tests/core/os-keyring.test.ts 참조.
// PR-1 의 "미구현 throw" 가드는 PR-3b 구현으로 대체되었다.
