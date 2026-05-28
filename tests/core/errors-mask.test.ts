/**
 * `maskIdentifier` 회귀 가드 — quad-review MED consensus fix.
 *
 * raw email / accountId 가 CLI 출력 / `--json` / CI 로그에 노출되지 않도록
 * stable fingerprint 로 변환. 본 테스트가 contract 를 잠근다.
 */

import { describe, expect, it } from 'vitest';

import { maskIdentifier } from '../../src/core/errors.js';

describe('maskIdentifier', () => {
  it('동일 입력 → 동일 fingerprint (stable, 비교 가능)', () => {
    expect(maskIdentifier('alice@example.com')).toBe(maskIdentifier('alice@example.com'));
  });

  it('다른 입력 → 다른 fingerprint', () => {
    expect(maskIdentifier('alice')).not.toBe(maskIdentifier('bob'));
  });

  it('출력 형식 = <hash:[0-9a-f]{12}> (PR-U: 8 → 12 hex 확장, birthday bound 48-bit)', () => {
    const masked = maskIdentifier('user@example.com');
    expect(masked).toMatch(/^<hash:[0-9a-f]{12}>$/);
  });

  it('raw 값 미포함 — email/accountId 등 식별자 노출 차단', () => {
    const masked = maskIdentifier('alice@example.com');
    expect(masked).not.toContain('alice');
    expect(masked).not.toContain('example.com');
  });

  it('빈 문자열 → <empty> (hash collision 회피)', () => {
    expect(maskIdentifier('')).toBe('<empty>');
  });
});
