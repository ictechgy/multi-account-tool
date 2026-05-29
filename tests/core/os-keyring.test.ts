/**
 * os-keyring (Linux Secret Service / secret-tool) 단위 테스트.
 *
 * Mock 전략: node:child_process.spawn 을 vi.mock 으로 격리하고, docker 에서
 * 실측한 secret-tool 출력 포맷(docker/README.md, tests/fixtures/os-keyring)을
 * fake 응답으로 재현한다. 실제 keyring 무손상.
 *
 * 핵심 가드 (plan §164-200 + quad-review):
 *  - search 출력 채널 분리: block-header/secret=stdout, attribute=stderr.
 *  - N 카운트는 stdout 의 `[/N]` 헤더 수 (secret 내용/멀티라인 비의존).
 *  - 부재 = exit 0 + 빈 출력. exit≠0 은 daemon-down, code=-1 은 미설치로 구분.
 *  - store value 는 stdin (argv 미노출) — findSpawnCallsByArg 로 argv 검증.
 *  - N>1 → OsKeyringAccountMissingError (clear deletes-all data loss 차단).
 *  - parse-failure error 에 raw output(secret) 미포함.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';

import { readSource, sourceExists, writeSource } from '../../src/core/sources.js';
import { OsKeyringAccountMissingError } from '../../src/core/errors.js';
import type { OsKeyringSource } from '../../src/core/types.js';

const mockSpawn = vi.mocked(spawn);

afterEach(() => {
  mockSpawn.mockReset();
});

/** stdin 기록용 fake (secret 이 stdin 으로 전달됐는지 검증). */
class FakeStdin extends EventEmitter {
  public readonly writes: string[] = [];
  public ended = false;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

/** secret-tool 프로세스 시뮬레이션. stdout/stderr emit 후 close(또는 error). */
function fakeProc(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: FakeStdin;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new FakeStdin();
  setImmediate(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      return;
    }
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0);
  });
  return proc as unknown as ChildProcessWithoutNullStreams;
}

/** `secret-tool search --all` N=1 출력 (stdout=블록+secret, stderr=attribute). */
function searchN1(value: string, account: string, service = 'mat-svc') {
  return {
    stdout:
      `[/1]\nlabel = ${service}\nsecret = ${value}\n` +
      `created = 2026-01-01 00:00:00\nmodified = 2026-01-01 00:00:00\n`,
    stderr: `attribute.account = ${account}\nattribute.service = ${service}\n`,
  };
}

/** N=2 collision 출력 (stdout 2 블록, stderr 2 attribute set). */
function searchN2(service = 'mat-svc') {
  return {
    stdout:
      `[/1]\nlabel = ${service}\nsecret = tok-a\ncreated = 2026-01-01 00:00:00\nmodified = 2026-01-01 00:00:00\n` +
      `[/2]\nlabel = ${service}\nsecret = tok-b\ncreated = 2026-01-01 00:00:00\nmodified = 2026-01-01 00:00:00\n`,
    stderr:
      `attribute.account = alice\nattribute.service = ${service}\n` +
      `attribute.account = bob\nattribute.service = ${service}\n`,
  };
}

function findSpawnCallsByArg(action: string) {
  return mockSpawn.mock.calls.filter((call) => (call[1] as string[]).includes(action));
}

const src: OsKeyringSource = { type: 'os-keyring', service: 'mat-svc', account: 'alice', saveAs: 'cred.json' };

describe('os-keyring — readSource (search --all)', () => {
  it('N=0 (부재, exit 0 + 빈 출력) → null', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, stdout: '', stderr: '' }));
    expect(await readSource(src)).toBeNull();
  });

  it('N=1 → {value, account} JSON (account 는 stderr 에서 역조회)', async () => {
    const out = searchN1('tok-alice', 'alice');
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...out }));
    const r = await readSource(src);
    expect(JSON.parse(r!)).toEqual({ value: 'tok-alice', account: 'alice' });
  });

  it('N=1 멀티라인 secret (등호/개행 포함) → 정확 추출', async () => {
    const out = searchN1('has=eq\nand-newline', 'weird');
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...out }));
    const r = await readSource(src);
    expect(JSON.parse(r!).value).toBe('has=eq\nand-newline');
  });

  it('secret 안에 "[/x]" 가 있어도 N 카운트는 stdout 헤더 수로 안정 (멀티라인 비의존)', async () => {
    // secret 본문에 가짜 블록 헤더처럼 보이는 줄이 있어도 anchored 정규식이 카운트를 흔들지 않음.
    const out = searchN1('line1\n[/fake] not a header', 'alice');
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...out }));
    const r = await readSource(src);
    // 단일 블록으로 정상 파싱돼야 한다 (N>1 오분류로 throw 하지 않음).
    expect(JSON.parse(r!).value).toContain('[/fake]');
  });

  it('N>1 (collision) → OsKeyringAccountMissingError', async () => {
    const serviceOnly: OsKeyringSource = { type: 'os-keyring', service: 'mat-svc', saveAs: 'cred.json' };
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...searchN2() }));
    await expect(readSource(serviceOnly)).rejects.toBeInstanceOf(OsKeyringAccountMissingError);
  });

  it('exit≠0 (daemon-down) → throw (keyring daemon 안내)', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 1, stderr: 'Cannot connect to D-Bus' }));
    await expect(readSource(src)).rejects.toThrow(/keyring daemon/);
  });

  it('spawn error (미설치, code=-1) → throw (libsecret-tools 설치 안내)', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ error: new Error('spawn ENOENT') }));
    await expect(readSource(src)).rejects.toThrow(/libsecret-tools/);
  });

  it('N=1 인데 secret 추출 실패 → 구조적 throw, raw output(secret 후보) 미포함', async () => {
    // 블록 헤더는 있지만 'secret = ' 라인 부재 → 파싱 실패. 에러에 raw stdout 누설 금지.
    // non-token-shaped secret(token redaction 정규식에 안 걸림)으로 누설 직접 검증.
    const leak = 'xyzzy-plain-secret';
    mockSpawn.mockReturnValueOnce(
      fakeProc({ code: 0, stdout: `[/1]\nlabel = mat-svc\nbogus = ${leak}\n`, stderr: 'attribute.account = alice\n' })
    );
    const err = await readSource(src).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/파싱 실패/);
    expect(err.message).not.toContain(leak);
  });
});

describe('os-keyring — writeSource (backup→clear→store→rollback)', () => {
  const serialized = JSON.stringify({ value: 'new-tok', account: 'alice' });

  it('backup N=1 → clear(기존 account) → store(new). 성공', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProc({ code: 0, ...searchN1('old-tok', 'alice') })) // backup
      .mockReturnValueOnce(fakeProc({ code: 0 })) // clear
      .mockReturnValueOnce(fakeProc({ code: 0 })); // store
    await writeSource(src, serialized);
    expect(findSpawnCallsByArg('clear').length).toBe(1);
    expect(findSpawnCallsByArg('store').length).toBe(1);
  });

  it('store value 는 argv 가 아니라 stdin 으로 전달된다 (argv 미노출)', async () => {
    // proc 는 spawn 호출 시점에 생성한다(close emit 의 setImmediate 가 listener
    // 등록보다 먼저 발생해 이벤트가 유실되는 것을 방지).
    let storeProc: ChildProcessWithoutNullStreams | undefined;
    mockSpawn
      .mockImplementationOnce(() => fakeProc({ code: 0, ...searchN1('old-tok', 'alice') }))
      .mockImplementationOnce(() => fakeProc({ code: 0 }))
      .mockImplementationOnce(() => {
        storeProc = fakeProc({ code: 0 });
        return storeProc;
      });
    await writeSource(src, serialized);
    const [storeCall] = findSpawnCallsByArg('store');
    // argv 에 secret 미포함.
    expect((storeCall[1] as string[]).join(' ')).not.toContain('new-tok');
    // stdin 으로 전달됨.
    expect((storeProc as unknown as { stdin: FakeStdin }).stdin.writes).toContain('new-tok');
  });

  it('backup N=0 → clear 없이 store 만', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProc({ code: 0, stdout: '', stderr: '' })) // backup 부재
      .mockReturnValueOnce(fakeProc({ code: 0 })); // store
    await writeSource(src, serialized);
    expect(findSpawnCallsByArg('clear').length).toBe(0);
    expect(findSpawnCallsByArg('store').length).toBe(1);
  });

  it('store 실패 → backup 으로 rollback store', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProc({ code: 0, ...searchN1('old-tok', 'alice') })) // backup
      .mockReturnValueOnce(fakeProc({ code: 0 })) // clear
      .mockReturnValueOnce(fakeProc({ code: 1, stderr: 'store failed' })) // store 실패
      .mockReturnValueOnce(fakeProc({ code: 0 })); // rollback store
    await expect(writeSource(src, serialized)).rejects.toThrow(/쓰기 실패/);
    // store 2회 (새 값 + rollback)
    expect(findSpawnCallsByArg('store').length).toBe(2);
  });

  it('store 실패 + rollback 도 실패 → 양쪽 에러 surface', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProc({ code: 0, ...searchN1('old-tok', 'alice') }))
      .mockReturnValueOnce(fakeProc({ code: 0 }))
      .mockReturnValueOnce(fakeProc({ code: 1 })) // store 실패
      .mockReturnValueOnce(fakeProc({ code: 2 })); // rollback 실패
    await expect(writeSource(src, serialized)).rejects.toThrow(/백업 복구도 실패/);
  });

  it('backup N>1 → OsKeyringAccountMissingError, store 미실행 (data loss 차단)', async () => {
    const serviceOnly: OsKeyringSource = { type: 'os-keyring', service: 'mat-svc', saveAs: 'cred.json' };
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...searchN2() }));
    await expect(writeSource(serviceOnly, serialized)).rejects.toBeInstanceOf(OsKeyringAccountMissingError);
    expect(findSpawnCallsByArg('store').length).toBe(0);
  });

  it('account 우선순위: src.account 가 stored.account 보다 우선', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeProc({ code: 0, stdout: '', stderr: '' })) // backup 부재
      .mockReturnValueOnce(fakeProc({ code: 0 })); // store
    // stored.account=bob 이지만 src.account=alice 가 우선되어야.
    await writeSource(src, JSON.stringify({ value: 'v', account: 'bob' }));
    const [storeCall] = findSpawnCallsByArg('store');
    const argv = storeCall[1] as string[];
    expect(argv[argv.indexOf('account') + 1]).toBe('alice');
  });

  it('corrupt backup (value 가 문자열 아님) → throw (store 미실행)', async () => {
    await expect(writeSource(src, JSON.stringify({ value: 123 }))).rejects.toThrow(/손상/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('os-keyring — sourceExists / 입력 검증', () => {
  it('N>=1 → true', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, ...searchN1('t', 'alice') }));
    expect(await sourceExists(src)).toBe(true);
  });

  it('N=0 → false', async () => {
    mockSpawn.mockReturnValueOnce(fakeProc({ code: 0, stdout: '', stderr: '' }));
    expect(await sourceExists(src)).toBe(false);
  });

  it('빈 문자열 account → throw (service-only fallthrough 차단)', async () => {
    const bad: OsKeyringSource = { type: 'os-keyring', service: 'mat-svc', account: '', saveAs: 'c.json' };
    await expect(readSource(bad)).rejects.toThrow(/유효하지 않습니다/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('NUL 포함 account → throw', async () => {
    const bad: OsKeyringSource = { type: 'os-keyring', service: 'mat-svc', account: 'a\x00b', saveAs: 'c.json' };
    await expect(readSource(bad)).rejects.toThrow(/유효하지 않습니다/);
  });
});
