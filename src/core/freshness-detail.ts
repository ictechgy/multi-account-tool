/**
 * freshness 비교 결과의 detail 문구 생성.
 *
 * 한 번에 두 문구를 만든다:
 *  - `detail`: 항상 영어. `mat freshness --json` 에 그대로 나가는 안정된 값이라 언어 설정에 따라 바뀌지 않는다.
 *  - `localizedDetail`: 현재 언어. 표 출력과 TUI 에만 쓴다 (JSON 에서는 뺀다).
 *
 * adapter 는 문구를 직접 쓰지 않고 `freshnessDetail(key, ...args)` 로 만든다. 마스킹 같은 값 가공은
 * 인자를 넘기기 전에 끝내야 두 언어 문구가 같은 값을 담는다.
 */

import { messagesFor, msg, type Messages } from '../i18n/index.js';
import type { CompareResult } from './freshness.js';

type DetailCatalog = Messages['freshnessDetails'];
export type FreshnessDetailKey = keyof DetailCatalog;
type DetailArgs<K extends FreshnessDetailKey> = DetailCatalog[K] extends (...args: infer A) => string ? A : [];

export type FreshnessDetail = Required<Pick<CompareResult, 'detail' | 'localizedDetail'>>;

function render<K extends FreshnessDetailKey>(catalog: DetailCatalog, key: K, args: DetailArgs<K>): string {
  const entry = catalog[key] as unknown;
  return typeof entry === 'function' ? (entry as (...a: unknown[]) => string)(...args) : (entry as string);
}

export function freshnessDetail<K extends FreshnessDetailKey>(key: K, ...args: DetailArgs<K>): FreshnessDetail {
  return {
    detail: render(messagesFor('en').freshnessDetails, key, args),
    localizedDetail: render(msg().freshnessDetails, key, args)
  };
}

/** 기존 detail 뒤에 다른 detail 을 이어 붙인다 (두 언어 모두). base 에 detail 이 없으면 next 만. */
export function appendFreshnessDetail(
  base: Pick<CompareResult, 'detail' | 'localizedDetail'>,
  next: FreshnessDetail,
  separator = ''
): FreshnessDetail {
  if (!base.detail) return next;
  return {
    detail: `${base.detail}${separator}${next.detail}`,
    localizedDetail: `${base.localizedDetail ?? base.detail}${separator}${next.localizedDetail}`
  };
}

/** 화면 표시용 detail — 현재 언어 문구가 있으면 그것, 없으면 영어. */
export function displayDetail(result: Pick<CompareResult, 'detail' | 'localizedDetail'>): string | undefined {
  return result.localizedDetail ?? result.detail;
}

/** `--json` 직렬화용 replacer — 현재 언어 문구는 빼고 영어 `detail` 만 남긴다. */
export function freshnessJsonReplacer(key: string, value: unknown): unknown {
  return key === 'localizedDetail' ? undefined : value;
}
