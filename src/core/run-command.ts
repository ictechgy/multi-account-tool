import { spawn } from 'node:child_process';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * spawn 실패 시의 errno (NodeJS.ErrnoException.code — 예: 'ENOENT', 'EACCES').
   * 정상 종료(close)에선 undefined. spawn 'error' 핸들러에서만 기록한다.
   *
   * **왜 필요한가** (#73 quad-review): spawn 실패는 모두 code=-1 로 settle 되지만,
   * 'secret-tool 미설치(ENOENT)' 와 '실행 권한 없음(EACCES)·기타' 는 의미가 다르다.
   * os-keyring 읽기 soft-fail 은 ENOENT 만 대상이어야 하므로 (그 외 spawn 실패는
   * fail-closed throw), 호출자가 errno 로 구분할 수 있도록 보존한다.
   * 기존 code=-1 반환은 그대로 유지해 다른 호출자(keychain 등)는 무영향이다.
   */
  spawnErrno?: string;
}

/**
 * 외부 명령을 spawn 으로 안전하게 실행.
 * error/close 이벤트가 모두 발생할 수 있으므로 settled 가드로 단일 resolve 보장.
 *
 * `stdinData` 가 주어지면 그 값을 자식 프로세스의 stdin 으로 write 후 end 한다.
 * 이는 secret 을 argv (외부에서 ps 등으로 관측 가능) 가 아니라 stdin 으로 전달하기
 * 위한 경로다 — Linux `secret-tool store` 가 value 를 stdin 으로 받기 때문이며,
 * PR-3b 의 os-keyring 구현이 이 경로를 사용한다. `stdinData` 미주어지면 stdin 을
 * 전혀 건드리지 않아 기존 keychain/file 호출과 동작이 byte-동등하다.
 */
export function runCommand(cmd: string, args: string[], stdinData?: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    // spawnErrno 는 spawn 'error' 핸들러에서만 채워 호출자가 ENOENT(미설치)와
    // EACCES 등 다른 spawn 실패를 구분할 수 있게 한다 (#73). close 경로엔 미전달.
    const settle = (code: number, errMsg?: string, spawnErrno?: string): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr: errMsg ?? stderr, spawnErrno });
    };
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // err.code 는 NodeJS.ErrnoException 의 errno 문자열 (예: 'ENOENT', 'EACCES').
    // code=-1 반환은 하위호환을 위해 유지하고, errno 만 추가로 보존한다.
    proc.on('error', (err) => settle(-1, err.message, (err as NodeJS.ErrnoException).code));
    proc.on('close', (code) => settle(code ?? -1));
    // stdin 주입 — secret 을 argv (ps 등으로 관측 가능) 가 아니라 stdin 으로 전달 (PR-3b secret-tool store).
    // stdin 쪽 에러(EPIPE / write-after-end / destroyed)는 흡수만 한다 (빈 처리가 아니라 의도된 흡수):
    //   - settle 은 항상 proc 의 'close'/'error' 가 실제 exit code 로 수행한다.
    //     → stdin error 로 조기 settle 하면 stdout/stderr 미drain + exit code 미상의 불완전 CmdResult 가 된다.
    //   - 'error' 이벤트 미처리 시 자식이 stdin 을 먼저 닫은 race 에서 unhandled error 로 프로세스가 죽는다.
    //   - write()/end() 는 write-after-end / destroyed stdin 에서 동기 throw 가능 (ERR_STREAM_*).
    //     이 throw 가 Promise executor 본문을 빠져나가면 settled-guard 를 우회해 Promise 가 reject 된다 → try/catch 로 흡수.
    // 전제: secret-tool store 의 stdin 실패는 자식 종료를 동반(close 따라옴)하고, spawn 실패는 proc 'error' 가
    //   settle 하므로, "stdin error 만 오고 close 가 안 오는" hang 케이스는 실무상 발생하지 않는다.
    if (stdinData !== undefined) {
      proc.stdin.on('error', () => { /* 흡수 — settle 은 'close'/'error' 가 수행 */ });
      try {
        proc.stdin.write(stdinData);
        proc.stdin.end();
      } catch {
        // write-after-end / destroyed stdin 의 동기 throw 흡수 — settle 은 'close'/'error' 가 수행.
      }
    }
  });
}
