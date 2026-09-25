/**
 * 표시 언어(locale) 결정 — 순수 함수만 둔다 (process.env / 파일 I/O 는 호출자가 주입).
 *
 * 우선순위:
 *   1. `--lang <en|ko>` (선행 전역 플래그)
 *   2. `MAT_LANG`
 *   3. config.json 의 `language`
 *   4. 시스템 locale (`LC_ALL` → `LC_MESSAGES` → `LANG`, POSIX 규칙대로 비어있지 않은 첫 값)
 *   5. `en`
 *
 * 2·3 의 인식 불가 값은 무시하고 다음 단계로 넘어간다. 1 의 인식 불가 값은 명시 입력
 * 오류라 호출자가 UsageError 로 거부한다.
 */

export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * `ko`, `ko-KR`, `ko_KR.UTF-8`, `en_US@euro` 등을 지원 locale 로 정규화.
 * 지원하지 않는 언어·`C`·`POSIX`·빈 값은 undefined.
 */
export function normalizeLocale(raw: string | undefined | null): Locale | undefined {
  if (raw == null) return undefined;
  const lang = raw.trim().toLowerCase().split(/[-_.@]/, 1)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(lang) ? (lang as Locale) : undefined;
}

type LocaleEnv = Partial<Record<'MAT_LANG' | 'LC_ALL' | 'LC_MESSAGES' | 'LANG', string | undefined>>;

/**
 * POSIX 규칙: LC_ALL > LC_MESSAGES > LANG 중 비어있지 않은 첫 값이 결정권을 가진다.
 * 그 값이 지원 언어가 아니면 (예: `C`, `fr_FR`) 뒤 변수로 넘어가지 않고 기본값을 쓴다.
 */
export function systemLocale(env: LocaleEnv): Locale {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[key];
    if (value != null && value.length > 0) return normalizeLocale(value) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

export interface LocaleInputs {
  /** `--lang` 값 (이미 정규화된 것). */
  flag?: Locale;
  env: LocaleEnv;
  /** config.json 의 `language` 원본 값. */
  configLanguage?: string;
}

export function resolveLocale(inputs: LocaleInputs): Locale {
  return (
    inputs.flag ??
    normalizeLocale(inputs.env.MAT_LANG) ??
    normalizeLocale(inputs.configLanguage) ??
    systemLocale(inputs.env)
  );
}

export type LangFlagResult =
  | { ok: true; lang?: string; rest: string[] }
  | { ok: false; rest: string[] };

/**
 * argv 선두의 `--lang <v>` / `--lang=<v>` 를 떼어낸다.
 *
 * 서브커맨드 앞(전역 위치)에서만 인식한다 — `mat exec ... -- <cmd...>` 처럼 뒤쪽 인자는
 * 자식 명령에 그대로 넘어가야 하므로 임의 위치 파싱은 하지 않는다.
 * 값이 빠진 `--lang` (마지막 인자) 은 `ok: false`.
 */
export function extractLangFlag(args: readonly string[]): LangFlagResult {
  const first = args[0];
  if (first === '--lang') {
    if (args.length < 2) return { ok: false, rest: [] };
    return { ok: true, lang: args[1], rest: args.slice(2) };
  }
  if (first != null && first.startsWith('--lang=')) {
    return { ok: true, lang: first.slice('--lang='.length), rest: args.slice(1) };
  }
  return { ok: true, rest: [...args] };
}
