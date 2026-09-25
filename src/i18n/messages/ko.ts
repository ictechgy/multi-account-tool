import type { Messages } from './en.js';

/** 한국어 메시지 카탈로그. 키 구조는 en.ts 의 `Messages` 를 따른다. */
export const ko: Messages = {
  lang: {
    missingValue: '--lang 에 값이 필요합니다 (en 또는 ko)',
    invalidValue: (value: string) => `--lang 에 지원하지 않는 언어입니다: '${value}' (지원: en, ko)`
  }
};
