/**
 * 자격증명 source 의 종류.
 * - file: 파일시스템 경로
 * - keychain: macOS Keychain의 generic password 항목
 * - os-keyring: Linux Secret Service (secret-tool) 기반 자격증명 항목
 */
export type SourceType = 'file' | 'keychain' | 'os-keyring';

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

/**
 * Linux Secret Service (secret-tool) 기반 자격증명 source.
 *
 * `secret-tool lookup <attribute> <value>` 를 사용해 자격증명을 조회·저장한다.
 * PR-1 시점에는 타입 정의만 존재하며 실제 backend 구현은 PR-3 에서 추가될 예정이다.
 *
 * `account` 가 정의되면 KeychainSource 와 동일한 multi-account scope 시맨틱을
 * 적용한다 — 동일 service 의 타 account 항목에 영향을 주지 않는다.
 * `account` 가 없으면 service 만으로 조회하는 단일-account 동작.
 *
 * `backend` 는 Linux 에서 사용할 keyring 구현을 선택한다.
 * - `'auto'` (기본): 시스템 기본 구현 (GNOME Keyring 등) 사용.
 * - `'secret-service'`: D-Bus Secret Service API 를 명시적으로 사용.
 * kwallet 등 추가 backend 는 향후 지원 예정.
 */
export interface OsKeyringSource {
  type: 'os-keyring';
  /** Secret Service 의 service 속성 값 (예: "mat-credentials"). */
  service: string;
  /**
   * 선택. Secret Service 항목의 account 속성 값. 지정하면 mat 가 정확히 이
   * account 의 항목만 읽고 쓴다. 미지정 시 단일 account 사용자 전제.
   *
   * KeychainSource.account 와 동일한 multi-account scope 시맨틱을 따른다.
   */
  account?: string;
  /**
   * 선택. Linux keyring backend 선택.
   * - `'auto'`: 시스템 기본 구현 사용 (기본값).
   * - `'secret-service'`: D-Bus Secret Service API 명시적 사용.
   */
  backend?: 'auto' | 'secret-service';
  /** 프로필 디렉토리 내 저장될 파일명. */
  saveAs: string;
}

export type Source = FileSource | KeychainSource | OsKeyringSource;

/**
 * 세션 시작 시 base 하위 디렉토리를 세션 root 로 재귀 복사할 allow-list 항목.
 *
 * `share` 는 단일 UTF-8 설정 파일 전용으로 유지한다. `shareDirs` 는 Codex `skills/` 처럼
 * nested 파일/asset 트리가 필요한 경우에만 별도 opt-in 하는 copy-isolate 경계다. 복사본은
 * 세션 종료 시 폐기되며 재캡처/write-back 대상이 아니다.
 */
export interface SessionShareDir {
  /**
   * base 기준 상대 디렉토리. 현재 보안 모델은 source root 를 단일 세그먼트로 제한한다
   * (예: `skills`). 내부 자식 경로는 materialize 단계에서 개별 검증하며, symlink 는 항상 거부된다.
   */
  rel: string;
  /** 선택. 복사할 전체 regular-file byte 상한. */
  maxBytes?: number;
  /** 선택. 복사할 regular-file 개수 상한. */
  maxFiles?: number;
  /** 선택. 복사할 전체 항목(file + directory) 개수 상한. 빈 디렉토리 폭탄 방지용. */
  maxEntries?: number;
  /** 선택. root 하위 재귀 깊이 상한(root 직속 파일/디렉토리 depth=1). */
  maxDepth?: number;
}

/**
 * 세션 격리(`mat session`)용 env-redirect 매핑.
 *
 * CLI 가 자신의 config/credential 디렉토리 위치를 env var 로 override 할 수 있을 때,
 * mat 이 세션마다 격리 디렉토리를 만들어 그 env 를 주입하면 동시에 다른 계정을 쓸 수 있다.
 */
export interface SessionRoot {
  /** 주입할 env var 이름 (예: 'CODEX_HOME'). 이 값을 격리 디렉토리로 set 한다. */
  env: string;
  /** 이 env 가 재배치하는 CLI 의 기본 base 디렉토리 (예: '~/.codex'). 선행 `~/` 는 확장된다. */
  base: string;
  /**
   * 선택. env 가 가리키는 디렉토리와 실제 자격증명/`base` 내용 루트 사이의 상대 하위경로.
   *
   * 일부 CLI 는 redirect env 가 base 의 **부모**를 가리킨다. 예: Gemini CLI 의 `GEMINI_CLI_HOME`
   * 은 그 값 아래 `.gemini/` 를 자격증명 루트로 쓴다 (소스 실측: `homedir()` = `GEMINI_CLI_HOME`,
   * `getGlobalGeminiDir()` = `join(homedir(), '.gemini')`). 이때 `env` 주입값은 부모(세션
   * 디렉토리)이고, 자격증명/`share` 의 격리 복사·base 봉쇄 검증은 `<주입dir>/<envSubdir>` 기준이
   * 어야 한다 → `envSubdir = '.gemini'`.
   *
   * 미지정이면 env 가 곧 base 자체다 (예: `CODEX_HOME` = `~/.codex`). 기존 빌트인
   * (codex/kimi/qwen/crush)은 모두 base 직속이라 미지정. 지정 시 traversal-safe 검증(절대/`..`/
   * 구분자/빈값 거부) + **단일 세그먼트** 강제(중간 디렉토리 symlink TOCTOU 회피)를 거치고, 적용 후
   * 주입 dir 안에 lexical 봉쇄된다.
   */
  envSubdir?: string;
  /**
   * 선택. `mat session start` 직후 stderr 로 출력할 빌트인 전용 경고문.
   *
   * `XDG_DATA_HOME` 처럼 CLI 전용이 아닌 broad env 를 써야 하는 경우, 세션 안의 다른 도구까지
   * 영향받는다는 사실을 사용자가 즉시 볼 수 있게 한다. 사용자 plugin 은 `session` 전체를
   * 수용하지 않으므로 이 필드도 주입할 수 없다(`cli-defs-plugin.validateCliDefRaw` 가
   * `{id,name,sources}` 만 반환).
   */
  warning?: string;
  /**
   * 선택. base 상대경로의 read-mostly 비-secret config allow-list — 세션 시작 시 base 에서
   * **0600 복사**(copy-isolate, issue #72)할 항목. 자격증명처럼 격리본에만 존재하므로 세션 내
   * 수정이 base 로 write-back 되지 않는다(재캡처 대상 아님). **자격증명 파일은 절대 포함하지
   * 않는다**(항상 별도 격리 복사). 최초 설계는 symlink 공유였으나, codex 가 `codex mcp add`/
   * `plugin add` 로 config.toml 에 실제로 쓴다는 실측에 따라 복사로 전환했다.
   *
   * 미지정/미포함 항목은 복사하지 않는다(fail-closed, 세션 내 ephemeral). 빌트인 메타에선
   * Codex `config.toml`(OAuth 토큰은 auth.json 에 분리 — secret-free 검증 완료)만 share 한다.
   *
   * 각 항목은 **단일 세그먼트**여야 한다(`'config.toml'` O, `'a/b.json'` X). nested 경로는 세션측
   * 중간 디렉토리 생성이 path-based TOCTOU race 표면을 만들어 미지원(planSession 거부) — 단일
   * 세그먼트면 복사 대상 부모가 항상 credRoot(이미 생성·검증)라 중간 컴포넌트가 없다.
   */
  share?: string[];
  /**
   * 선택. base 상대 디렉토리 allow-list — 세션 시작 시 base 에서 세션 root 로 재귀 복사한다.
   *
   * `share` 와 달리 디렉토리/asset 트리를 다루므로 별도 필드로 둔다. top-level rel 은 단일
   * 세그먼트만 허용하고, 복사 중 모든 하위 항목은 regular file/directory 만 허용한다. symlink,
   * 특수파일, traversal, 용량/파일수/항목수/깊이 초과는 fail-closed. 복사본은 재캡처/write-back 되지 않는다.
   */
  shareDirs?: SessionShareDir[];
}

/** 세션 격리 명세. roots 가 1개 이상일 때 그 CLI 는 세션 격리를 지원한다. */
export interface SessionSpec {
  roots: SessionRoot[];
}

/**
 * Command-scoped session execution (`mat session run`) metadata.
 *
 * This is intentionally narrower than `mat exec`: the user supplies argv for a
 * mat-owned builtin executable, not an arbitrary shell command. User plugin
 * definitions cannot inject this field because `cli-defs-plugin` only returns
 * `{ id, name, sources }` after validation.
 */
export interface SessionRunSpec {
  /** Builtin executable name to spawn without a shell, e.g. `codex` or `gemini`. */
  executable: string;
}

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
  /**
   * 선택. 세션 격리(`mat session`) 지원 명세. 미지정이면 그 CLI 는 세션 격리 미지원
   * (`mat session start` 시 명시 에러). plugin 정의 CLI 는 1차에선 미수용(빌트인 전용).
   */
  session?: SessionSpec;
  /**
   * 선택. command-scoped session run 지원 명세. `--` 뒤 인자는 이 builtin executable 의 argv 로만
   * 전달된다. env root 가 없는 CLI(Aider 등)는 별도 hard-stop/forced-argv 정책으로만 partial support 를
   * 열 수 있으며, `session start` 지원과 독립이다.
   */
  sessionRun?: SessionRunSpec;
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
  /** 선택. capture/recapture 시점에 저장한 non-secret identity 힌트. */
  identity?: ProfileIdentitySummary;
}

export type ProfileIdentityStatus = 'available' | 'unavailable' | 'unsupported';
export type ProfileIdentityCompleteness = 'complete' | 'partial' | 'unknown';
export type ProfileIdentityConfidence = 'high' | 'medium' | 'low';
export type ProfileIdentitySignalKind =
  | 'account'
  | 'email'
  | 'subscription-tier'
  | 'auth-mode'
  | 'provider'
  | 'routing'
  | 'api-key-mode';
export type ProfileIdentityWarningCode =
  | 'missing-source'
  | 'carried-forward'
  | 'parse-error'
  | 'no-identity'
  | 'unsupported'
  | 'lock-free-recapture';

export interface ProfileIdentitySignal {
  kind: ProfileIdentitySignalKind;
  source: string;
  confidence: ProfileIdentityConfidence;
  fingerprint?: string;
  value?: string;
}

export interface ProfileIdentityWarning {
  code: ProfileIdentityWarningCode;
  source?: string;
}

export interface ProfileIdentitySummary {
  schemaVersion: 1;
  status: ProfileIdentityStatus;
  capturedAt: string;
  completeness: ProfileIdentityCompleteness;
  signals: ProfileIdentitySignal[];
  warnings?: ProfileIdentityWarning[];
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
