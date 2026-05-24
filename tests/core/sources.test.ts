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
 *  - process.platform 분기 (darwin vs 그 외) 는 vi.stubGlobal 로 케이스별 override
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}));

import { spawn } from 'node:child_process';

import { readSource, sourceExists, writeSource } from '../../src/core/sources.js';
import type { FileSource, KeychainSource, KeychainStored } from '../../src/core/types.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const mockSpawn = vi.mocked(spawn);

/**
 * security CLI 응답 시뮬레이션용 fake process.
 * stdout/stderr 데이터를 비동기 emit 후 close 이벤트.
 * error 옵션이 있으면 close 대신 error 이벤트만 emit.
 */
function fakeProc(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  setImmediate(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      return;
    }
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0);
  });

  return proc;
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
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'secret-token\n' }) as never)
        // 2nd call: find -s (account 메타)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('user@example.com') }) as never);

      const raw = await readSource(KEYCHAIN_SRC);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.value).toBe('secret-token');
      expect(parsed.account).toBe('user@example.com');
    });

    it('account 없음 (빈 acct) → KeychainStored.account = undefined', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'secret-token' }) as never)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('') }) as never);

      const raw = await readSource(KEYCHAIN_SRC);
      const parsed = JSON.parse(raw!) as KeychainStored;
      expect(parsed.account).toBeUndefined();
    });

    it('항목 없음 (errSecItemNotFound, code 44) → null', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 44, stderr: 'security: ...could not be found in keychain.' }) as never
      );
      expect(await readSource(KEYCHAIN_SRC)).toBeNull();
    });

    it('항목 없음 (코드 다름 + "could not be found" 메시지) → null (regex fallback)', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 1, stderr: 'security: item could not be found' }) as never
      );
      expect(await readSource(KEYCHAIN_SRC)).toBeNull();
    });

    it('다른 에러 → throw (redacted message)', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 2, stderr: 'access denied' }) as never
      );
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/keychain 읽기 실패/);
    });

    it('non-darwin platform → throw "macOS 에서만 지원"', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/macOS 에서만 지원/);
    });
  });

  describe('writeSource(keychain) — backup → delete → add 시퀀스', () => {
    it('신규 (기존 없음): backup null → delete skip → add 만 호출', async () => {
      mockSpawn
        // keychainGetValue (find -w) → not found
        .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }) as never)
        // add-generic-password
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never);

      const stored: KeychainStored = { value: 'new-token', account: 'alice' };
      await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const addCall = mockSpawn.mock.calls[1];
      expect(addCall[1]).toContain('add-generic-password');
      expect(addCall[1]).toContain('-a');
      expect(addCall[1]).toContain('alice');
      expect(addCall[1]).toContain('-w');
      expect(addCall[1]).toContain('new-token');
    });

    it('기존 있음: backup value + account 조회 → 정확한 acct 로 delete → add', async () => {
      mockSpawn
        // 1. keychainGetValue (find -w) → 'old-token'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token\n' }) as never)
        // 2. keychainGetAccount (find -s) → 'bob'
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }) as never)
        // 3. delete (with -a bob)
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never)
        // 4. add (new)
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never);

      const stored: KeychainStored = { value: 'new-token', account: 'alice' };
      await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

      const deleteCall = mockSpawn.mock.calls[2];
      expect(deleteCall[1]).toContain('delete-generic-password');
      // 정확한 acct (bob) 로 delete — service-only 삭제 회피
      expect(deleteCall[1]).toContain('-a');
      expect(deleteCall[1]).toContain('bob');
    });

    it('기존 있음 but account 못 잡음: console.warn + service-only delete', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* 캡처 */ });
      try {
        mockSpawn
          .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }) as never)
          // account 조회 실패 (코드 0 인데 acct 파싱 안 됨)
          .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'no acct line here' }) as never)
          // delete (service-only)
          .mockReturnValueOnce(fakeProc({ code: 0 }) as never)
          // add
          .mockReturnValueOnce(fakeProc({ code: 0 }) as never);

        const stored: KeychainStored = { value: 'new', account: 'alice' };
        await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/account 를 파악할 수 없어/));
        const deleteCall = mockSpawn.mock.calls[2];
        expect(deleteCall[1]).not.toContain('-a');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('add 실패 시 backup 으로 롤백 + 원본 에러 throw', async () => {
      mockSpawn
        // backup value 있음
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old-token' }) as never)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }) as never)
        // delete OK
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never)
        // add 실패
        .mockReturnValueOnce(fakeProc({ code: 5, stderr: 'add failed' }) as never)
        // 롤백 add (성공)
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never);

      const stored: KeychainStored = { value: 'new', account: 'alice' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/keychain 쓰기 실패/);

      // 롤백: add (with backup value 'old-token', acct 'bob')
      const rollbackCall = mockSpawn.mock.calls[4];
      expect(rollbackCall[1]).toContain('add-generic-password');
      expect(rollbackCall[1]).toContain('old-token');
      expect(rollbackCall[1]).toContain('bob');
    });

    it('add 실패 + 롤백도 실패 → "백업 복구도 실패" note 포함', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old' }) as never)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }) as never)
        .mockReturnValueOnce(fakeProc({ code: 0 }) as never)
        .mockReturnValueOnce(fakeProc({ code: 5, stderr: 'add failed' }) as never)
        // 롤백 add 도 실패
        .mockReturnValueOnce(fakeProc({ code: 6, stderr: 'rollback also failed' }) as never);

      const stored: KeychainStored = { value: 'new' };
      await expect(writeSource(KEYCHAIN_SRC, JSON.stringify(stored)))
        .rejects.toThrow(/백업 복구도 실패/);
    });

    it('백업 delete 자체가 실패 → throw "백업 항목 삭제 실패"', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: 'old' }) as never)
        .mockReturnValueOnce(fakeProc({ code: 0, stdout: findOutputWithAcct('bob') }) as never)
        // delete 실패
        .mockReturnValueOnce(fakeProc({ code: 7, stderr: 'delete failed' }) as never);

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
          .mockReturnValueOnce(fakeProc({ code: 44, stderr: 'not found' }) as never)
          .mockReturnValueOnce(fakeProc({ code: 0 }) as never);

        const stored: KeychainStored = { value: 'v' };  // account 없음
        await writeSource(KEYCHAIN_SRC, JSON.stringify(stored));

        const addCall = mockSpawn.mock.calls[1];
        expect(addCall[1]).toContain('env-user');
      } finally {
        if (origUser === undefined) delete process.env.USER;
        else process.env.USER = origUser;
      }
    });
  });

  describe('sourceExists(keychain)', () => {
    it('존재 → true', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 0, stdout: findOutputWithAcct('a') }) as never
      );
      expect(await sourceExists(KEYCHAIN_SRC)).toBe(true);
    });

    it('없음 (code 44) → false', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ code: 44, stderr: 'not found' }) as never
      );
      expect(await sourceExists(KEYCHAIN_SRC)).toBe(false);
    });
  });

  describe('runCommand 의 spawn error/close race', () => {
    it('spawn error 이벤트 → code -1, stderr 에 에러 메시지', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeProc({ error: new Error('ENOENT: /usr/bin/security') }) as never
      );
      // error 이벤트 → keychainGetValue 의 readKeychainSerialized 가 throw 안 던지고 null 반환
      // (코드 -1 이고 KEYCHAIN_NOT_FOUND_CODE/RE 매칭 안 됨 → 'keychain 읽기 실패' throw)
      await expect(readSource(KEYCHAIN_SRC)).rejects.toThrow(/keychain 읽기 실패.*-1/);
    });
  });
});
