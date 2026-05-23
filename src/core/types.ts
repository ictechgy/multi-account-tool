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
 */
export interface KeychainSource {
  type: 'keychain';
  /** Keychain 의 service 이름 (예: "Claude Code-credentials") */
  service: string;
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

/** CLI 별 활성 프로필 매핑 */
export type ActiveMap = Record<string, string>;

/** 전역 설정 파일 (config.json) 스키마 */
export interface Config {
  version: 1;
  active: ActiveMap;
  /**
   * 첫 실행 시 자동 가져오기 프롬프트를 이미 표시했는지.
   * true 가 되면 다음 실행부터 자동 프롬프트를 띄우지 않는다 (수동 캡처는 항상 가능).
   */
  firstImportPromptShown?: boolean;
}

/**
 * Keychain source 가 디스크에 저장될 때의 포맷.
 * account 를 함께 보관해야 복원 시 동일 account 로 항목을 재생성할 수 있다.
 */
export interface KeychainStored {
  value: string;
  account?: string;
}
