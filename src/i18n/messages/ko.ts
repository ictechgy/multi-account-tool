import type { Messages } from './en.js';
import { cli } from './ko/cli.js';
import { sessionCli } from './ko/sessionCli.js';
import { app } from './ko/app.js';
import { screens } from './ko/screens.js';
import { formatters } from './ko/formatters.js';
import { validators } from './ko/validators.js';
import { widgets } from './ko/widgets.js';
import { freshnessDetails } from './ko/freshnessDetails.js';
import { pluginDefs } from './ko/pluginDefs.js';
import { coreValidation } from './ko/coreValidation.js';
import { credentials } from './ko/credentials.js';

/** 한국어 메시지 카탈로그. 키 구조는 en.ts 의 `Messages` 를 따른다. */
export const ko: Messages = {
  lang: {
    missingValue: '--lang 에 값이 필요합니다 (en 또는 ko)',
    invalidValue: (value: string) => `--lang 에 지원하지 않는 언어입니다: '${value}' (지원: en, ko)`
  },
  config: {
    usage: '사용법: mat config language [en|ko|--unset]',
    unknownKey: (key: string) => `mat config: 알 수 없는 설정: ${key}`,
    invalidLanguage: (value: string) => `mat config: 지원하지 않는 언어입니다: '${value}' (지원: en, ko)`,
    tooManyArgs: 'mat config: 인자가 너무 많습니다',
    languageCurrent: (locale: string, source: string) => `언어: ${locale} (출처: ${source})`,
    sourceLabels: {
      flag: '--lang',
      env: 'MAT_LANG',
      config: 'config.json',
      system: '시스템 locale'
    },
    languageSet: (name: string) => `표시 언어를 ${name}(으)로 설정했습니다.`,
    languageUnset:
      '표시 언어 설정을 지웠습니다. 이제 MAT_LANG 또는 시스템 locale 을 따르며, ' +
      '다음 TUI 시작 때 언어를 다시 묻습니다.',
    envOverrides: (value: string) => `참고: MAT_LANG=${value} 이(가) 설정돼 있어 이 설정보다 우선합니다.`
  },
  cli,
  sessionCli,
  app,
  screens,
  formatters,
  validators,
  widgets,
  freshnessDetails,
  pluginDefs,
  coreValidation,
  credentials
};
