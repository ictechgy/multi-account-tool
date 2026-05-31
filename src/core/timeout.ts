/**
 * 재캡처/원복 write 의 타임아웃 유틸 — `mat exec` 와 `mat session` 이 공유한다.
 *
 * 단일 출처로 둔 이유 (PR #61 2회차 Claude MEDIUM): 동일 env `MAT_EXEC_RECAPTURE_TIMEOUT_MS`
 * 가 두 모듈의 default(10s)를 제어하는데 양쪽에 복제돼 있으면 한쪽만 바뀌어 silently
 * divergent 한 동작이 될 수 있다. exec.ts / session.ts 가 모두 본 모듈을 import 한다.
 */

/**
 * 재캡처 write 의 타임아웃 (ms, default 10s). `MAT_EXEC_RECAPTURE_TIMEOUT_MS` 로 override
 * 가능 (양의 유한수만 허용). **호출 시점 평가** — test/daemon 이 env 를 동적으로 바꿔도 다음
 * 호출부터 반영되고, module-load 시점 미설정으로 default 고정되던 회귀를 막는다.
 */
export function getRecaptureTimeoutMs(): number {
  const raw = process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
  if (!raw) return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/**
 * Promise.race timeout — Promise 가 먼저 resolve 해도 timer cleanup 보장.
 *
 * 주의: timeout 은 underlying 작업을 **취소하지 못한다**. 취소 불가능한데 늦게 완료되면
 * 상태를 오염시키는 작업(예: 라이브 파일 rename commit)에는 쓰지 말 것 — late-landing 이
 * 롤백 이후를 덮어 split 을 유발한다 (PR #61 2회차 Codex/Forge H1). byte-write 처럼 stall
 * 가능하지만 늦게 완료돼도 격리된 staging 만 건드리는 작업에만 적용한다.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
