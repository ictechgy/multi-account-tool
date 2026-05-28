/**
 * 자격증명 source 의 종류.
 * - file: 파일시스템 경로
 * - keychain: macOS Keychain의 generic password 항목
 */
export type SourceType = 'file' | 'keychain';

/**
 * 파일 기반 자격증명 source.
 * @example { type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }
 */
export interface FileSource {
  type: 'file';
  /** 절대 경로. 선행 `~/` 는 home 디렉토리로 확장된다. */
  path: string;
  /** 프로필 디렉토리 내 저장될 파일명. */
  saveAs: string;
}

/**
 * macOS Keychain 기반 자격증명 source.
 * 디스크에는 {@link KeychainStored} JSON 으로 직렬화되어 저장된다.
 *
 * `account` 가 정의되면 mat 의 모든 keychain 조작이 `-s service -a account`
 * 항목 하나로 scope 제한된다 — 동일 service 의 타 account 항목은 영향 없음.
 * Goose (service `goose` 의 단일 entry account=`secrets`), GitHub Copilot CLI
 * (multi-account 시 `/user switch`) 등 generic service 또는 multi-account
 * 시나리오에서 wrong-entry swap 을 차단한다.
 *
 * `account` 가 없으면 기존 단일-account 동작 (service 만으로 lookup, acct
 * 메타를 자동 감지해 정확한 항목 delete → add) 을 유지 — Claude/Codex 같은
 * 단일 account 사용자는 회귀 없음.
 */
export interface KeychainSource {
  type: 'keychain';
  /** Keychain 의 service 이름 (예: "Claude Code-credentials") */
  service: string;
  /**
   * 선택. Keychain 항목의 account (acct). 지정하면 mat 가 정확히 이 account
   * 의 항목만 읽고 쓴다. 미지정 시 단일 account 사용자 전제 (현재 동작).
   *
   * 빈 문자열은 undefined 와 동치가 아니다 — `cli-defs-plugin.parseSource` 가
   * 빈 문자열을 명시 거부하고, `sources.ts` 의 `hasAccount` 가드도 length>0 만
   * 통과시킨다. 이는 internal 호출에 빈 문자열이 새어 들어와 service-only
   * fallback 으로 multi-account scope 가 silent 하게 깨지는 사고를 차단.
   */
  account?: string;
  /** 프로필 디렉토리 내 저장될 파일명. */
  saveAs: string;
}

export type Source = FileSource | KeychainSource;

/**
 * 하나의 AI CLI 정의.
 * 새로운 CLI 를 추가하려면 BUILTIN_CLI_DEFS 에 항목을 추가한다.
 */
export interface CliDef {
  /** 내부 식별자 (예: 'claude') */
  id: string;
  /** 화면 표시용 이름 */
  name: string;
  /** 이 CLI 의 자격증명을 구성하는 source 들 */
  sources: Source[];
}

/** 프로필 메타데이터. profiles/<cli>/<name>/meta.json 에 저장. */
export interface Profile {
  name: string;
  cli: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  updatedAt: string;
  /** 선택적 사람이 읽는 라벨 */
  label?: string;
}

/**
 * CLI 별 활성 프로필 매핑.
 * 값이 없는 CLI 는 키가 부재하므로 lookup 시 `string | undefined` 로 다뤄야 한다.
 */
export type ActiveMap = Partial<Record<string, string>>;

/** 전역 설정 파일 (config.json) 스키마 */
export interface Config {
  version: 1;
  active: ActiveMap;
  /**
   * 첫 실행 시 자동 가져오기 프롬프트를 이미 표시했는지.
   * true 가 되면 다음 실행부터 자동 프롬프트를 띄우지 않는다 (수동 캡처는 항상 가능).
   */
  firstImportPromptShown?: boolean;
  /**
   * PR-G: TUI 에서 freshness dialog (재캡처/폐기/취소) 가 처음 표시되었을 때
   * 한국어 onboarding 패널을 함께 출력한 적이 있는지. 이후 표시부터는 dialog
   * 본문만 보여 사용자 noise 를 최소화한다. 값이 true 가 되어도 dialog 자체는
   * 매번 표시됨 — 본 플래그는 onboarding 패널 1회 표시만 제어한다.
   */
  firstFreshnessPromptShown?: boolean;
}

/**
 * Keychain source 가 디스크에 저장될 때의 포맷.
 * account 를 함께 보관해야 복원 시 동일 account 로 항목을 재생성할 수 있다.
 */
export interface KeychainStored {
  value: string;
  account?: string;
}
