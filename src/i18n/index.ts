/**
 * i18n 진입점 — 현재 locale 상태와 메시지 조회.
 *
 * `cli.tsx` 가 시작 시 `setLocale()` 로 한 번 확정한다. 확정 전에 `msg()` 가 불리면
 * (예: core 모듈 단위 테스트) 환경 변수만으로 locale 을 정한다 — config.json 은
 * 비동기 I/O 라 여기서는 읽지 않는다.
 */

import { en, type Messages } from './messages/en.js';
import { ko } from './messages/ko.js';
import { resolveLocale, type Locale } from './locale.js';

export { normalizeLocale, resolveLocale, extractLangFlag, SUPPORTED_LOCALES, type Locale } from './locale.js';
export type { Messages } from './messages/en.js';

const CATALOGS: Record<Locale, Messages> = { en, ko };

let current: Locale | undefined;

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  current ??= resolveLocale({ env: process.env });
  return current;
}

/** 현재 locale 의 메시지 카탈로그. */
export function msg(): Messages {
  return CATALOGS[getLocale()];
}
