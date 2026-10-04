/**
 * 영어 메시지 카탈로그 — 모든 locale 의 **기준 스키마**.
 *
 * 다른 locale 은 `Messages` 타입을 따르므로, 여기 키를 추가하면 ko.ts 에도 추가해야
 * 빌드가 통과한다 (누락 번역이 런타임이 아닌 typecheck 에서 잡힌다).
 * 보간이 필요한 메시지는 함수로 둔다.
 */
export const en = {
  lang: {
    missingValue: '--lang requires a value (en or ko)',
    invalidValue: (value: string) => `unsupported language for --lang: '${value}' (supported: en, ko)`
  },
  config: {
    usage: 'usage: mat config language [en|ko|--unset]',
    unknownKey: (key: string) => `mat config: unknown setting: ${key}`,
    invalidLanguage: (value: string) => `mat config: unsupported language: '${value}' (supported: en, ko)`,
    tooManyArgs: 'mat config: too many arguments',
    languageCurrent: (locale: string, source: string) => `language: ${locale} (from ${source})`,
    sourceLabels: {
      flag: '--lang',
      env: 'MAT_LANG',
      config: 'config.json',
      system: 'system locale'
    },
    languageSet: (name: string) => `Display language set to ${name}.`,
    languageUnset:
      'Display language setting removed. mat will follow MAT_LANG or the system locale, ' +
      'and will ask again the next time the TUI starts.',
    envOverrides: (value: string) => `Note: MAT_LANG=${value} is set and takes precedence over this setting.`
  }
};

export type Messages = typeof en;
