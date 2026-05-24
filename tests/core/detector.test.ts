/**
 * detector 단위 테스트.
 *
 * sources.sourceExists 를 vi.mock 으로 격리해 fs 의존 없이 각 source 의 present/missing
 * 시나리오를 결정적으로 검증. detectAll 이 BUILTIN_CLI_DEFS 순서대로 결과를 반환하는지,
 * gemini (2 source) 의 partial 케이스에서 hasAnyLiveCredential 만 true 인지 등.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/sources.js', () => ({
  sourceExists: vi.fn()
}));

import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import { detectAll } from '../../src/core/detector.js';
import { sourceExists } from '../../src/core/sources.js';
import type { Source } from '../../src/core/types.js';

const mockSourceExists = vi.mocked(sourceExists);

describe('detectAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('모든 source 존재 → hasLiveCredentials true, missing 비어있음', async () => {
    mockSourceExists.mockResolvedValue(true);
    const results = await detectAll();
    for (const r of results) {
      expect(r.hasLiveCredentials).toBe(true);
      expect(r.hasAnyLiveCredential).toBe(true);
      expect(r.missing).toEqual([]);
      expect(r.present.length).toBe(r.cli.sources.length);
    }
  });

  it('모든 source 부재 → 두 flag 모두 false, present 비어있음', async () => {
    mockSourceExists.mockResolvedValue(false);
    const results = await detectAll();
    for (const r of results) {
      expect(r.hasLiveCredentials).toBe(false);
      expect(r.hasAnyLiveCredential).toBe(false);
      expect(r.present).toEqual([]);
      expect(r.missing.length).toBe(r.cli.sources.length);
    }
  });

  it('gemini partial (oauth_creds.json 존재, google_accounts.json 부재) → hasAnyLive true, hasLive false', async () => {
    // gemini.sources[0] = oauth_creds.json (true), sources[1] = google_accounts.json (false)
    mockSourceExists.mockImplementation(async (src: Source) =>
      src.saveAs === 'oauth_creds.json'
    );
    const results = await detectAll();
    const gemini = results.find((r) => r.cli.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.hasLiveCredentials).toBe(false);  // 하나가 missing
    expect(gemini!.hasAnyLiveCredential).toBe(true);  // 하나는 present
    expect(gemini!.present).toEqual(['oauth_creds.json']);
    expect(gemini!.missing).toEqual(['google_accounts.json']);
  });

  it('결과는 BUILTIN_CLI_DEFS 순서를 보존', async () => {
    mockSourceExists.mockResolvedValue(true);
    const results = await detectAll();
    expect(results.map((r) => r.cli.id)).toEqual(
      BUILTIN_CLI_DEFS.map((c) => c.id)
    );
  });

  it('sourceExists 는 모든 source 에 대해 정확히 한 번씩 호출됨 (병렬)', async () => {
    mockSourceExists.mockResolvedValue(true);
    await detectAll();
    const totalSources = BUILTIN_CLI_DEFS.reduce((sum, c) => sum + c.sources.length, 0);
    expect(mockSourceExists).toHaveBeenCalledTimes(totalSources);
  });

  it('sourceExists 가 reject 하면 detectAll 도 reject (에러 무시 안 함)', async () => {
    mockSourceExists.mockRejectedValue(new Error('fs unavailable'));
    await expect(detectAll()).rejects.toThrow('fs unavailable');
  });
});
