import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRecaptureTimeoutMs, withTimeout } from '../../src/core/timeout.js';

describe('timeout utilities', () => {
  const original = process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    else process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = original;
    vi.useRealTimers();
  });

  it('getRecaptureTimeoutMs: env 미설정이면 default 10s', () => {
    delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    expect(getRecaptureTimeoutMs()).toBe(10_000);
  });

  it('getRecaptureTimeoutMs: 양의 유한수 override 는 호출 시점에 반영', () => {
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '750';
    expect(getRecaptureTimeoutMs()).toBe(750);

    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '1250';
    expect(getRecaptureTimeoutMs()).toBe(1250);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', 'not-a-number'])(
    'getRecaptureTimeoutMs: invalid override(%s)는 default 로 폴백',
    (value) => {
      process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = value;
      expect(getRecaptureTimeoutMs()).toBe(10_000);
    }
  );

  it('withTimeout: 원 promise 가 먼저 resolve 되면 값을 반환하고 timer 를 정리', async () => {
    vi.useFakeTimers();

    const result = await withTimeout(Promise.resolve('ok'), 1_000, 'fast-op');

    expect(result).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withTimeout: 제한 시간 초과 시 label 포함 에러로 reject 하고 timer 를 정리', async () => {
    vi.useFakeTimers();

    const result = withTimeout(new Promise<string>(() => { /* never settles */ }), 50, 'slow-op');
    const assertion = expect(result).rejects.toThrow('slow-op timeout after 50ms');
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
