/**
 * Goose 자격증명 아티팩트의 **단일 진실 원천**.
 *
 * ## 이 파일이 존재하는 이유
 *
 * 0.8.0 까지 Goose provider OAuth 캐시 경로는 세 곳에 각각 문자열로 재기술돼 있었다 —
 * `cli-defs.ts` 의 source 정의, `sources.ts` 의 하드닝 가드, `doctor.ts` 의 진단 가드.
 * 그 문자열에는 업스트림에 **존재하지 않는** `providers/` 세그먼트가 들어가 있었고, 세 곳이
 * 똑같이 틀렸기 때문에 아무 테스트도 이를 잡지 못했다. 결과적으로 mat 은 Goose provider
 * OAuth 캐시를 **한 번도 캡처·복원한 적이 없으면서** 프로필 전환을 "성공" 으로 보고했다
 * (이전 계정의 토큰이 라이브에 그대로 남는 fail-closed 격리 위반).
 *
 * 따라서 이 모듈은 경로 집합을 한 곳에만 두고, source 생성과 하드닝 가드 판정을 **같은
 * 배열에서 파생**시킨다. 경로와 가드가 물리적으로 갈라질 수 없어야 같은 결함이 재발하지 않는다.
 *
 * ## 업스트림 근거 (aaif-goose/goose v1.43.0, commit 5a9eb7edea1e081e2d54473ae41481f0289b826a)
 *
 * Goose 는 provider 캐시를 `Paths::in_config_dir(sub)` = `config_dir().join(sub)` 로 해석하며,
 * `config_dir()` 는 etcetera `choose_app_strategy` 를 통해 `~/.config/goose` 가 된다.
 * 상대 경로 목록은 `crates/goose/src/providers/provider_secrets.rs` 의
 * `PROVIDER_CACHE_SECRET_DEFINITIONS` 와 `huggingface_auth.rs:19` 의
 * `HUGGINGFACE_OAUTH_CACHE_PATH` 에 고정돼 있다. **`providers/` 세그먼트는 v1.35.0 / 1.38.0 /
 * 1.40.0 / 1.42.0 / 1.43.0 / 1.44.0 어느 태그에도 존재하지 않는다**
 * (GitHub 코드 검색 `repo:aaif-goose/goose "providers/gemini_oauth"` → 0 건).
 * 저장소 자체 증거 문서 `docs/upstream-evidence/goose-v1.40.0-provider-cache.md` 는 처음부터
 * 상대 경로를 올바르게 기록하고 있었다 — 구현만 자기 증거와 어긋나 있었다.
 *
 * ## 경계
 *
 * 고정 경로 admission 이며 provider **discovery 가 아니다**. 새 경로는 업스트림 근거와 회귀
 * 테스트가 함께 있을 때만 추가한다. 캐시 내용은 opaque 로 취급하고 토큰/만료/계정 identity 를
 * 파싱하지 않는다 (freshness 는 `freshness-adapters/goose.ts` 가 saveAs 키로 처리).
 *
 * ## 한계 (F9/F10 후속)
 *
 * `config_dir()` 는 `GOOSE_PATH_ROOT` 와 XDG 를 존중하지만 mat 은 `~/.config/goose` 를 하드코딩한다.
 * 그 환경에서는 전 source 가 missing 이 되어 같은 클래스의 조용한 실패가 난다 — 완화책으로
 * `ambient.ts` 가 `GOOSE_PATH_ROOT`/`XDG_CONFIG_HOME` 을 경고하지만 해결은 아니다.
 *
 * 아래 판정은 **표기 문자열 멤버십**이며 파일시스템 identity 보증이 아니다. 대소문자를 구분하지
 * 않는 플랫폼(darwin/win32)에서는 `comparableGoosePath` 가 접어서 비교하므로 `~/.config/Goose/...`
 * 같은 변형도 구역 안으로 잡히지만, 대소문자를 구분하도록 포맷된 macOS 볼륨에서는 그 접기가
 * 서로 다른 실물을 같은 것으로 취급할 수 있다 — 두 방향 모두 **더 엄격해지는** 쪽이라 보호가
 * 약해지지는 않는다. hardlink / 마운트 경유 별칭은 여전히 이 판정의 범위 밖이며,
 * `sources.ts` 의 부모 identity pinning 과 no-follow 검사가 실제 경계를 담당한다.
 */

import { normalize, sep } from 'node:path';
import { comparablePath, expandTilde } from './paths.js';
import { resolvePathIdentitySync } from './path-identity.js';
import type { DirectorySource, FileSource, Source } from './types.js';

/** Goose config 디렉토리. 위 JSDoc 의 업스트림 근거 참고. */
const GOOSE_CONFIG_ROOT = '~/.config/goose';

/** 제한 디렉토리 source 의 공통 bound — 0.8.0 값 그대로 유지한다. */
const DIRECTORY_BOUNDS = { maxEntries: 128, maxBytes: 1_048_576, maxDepth: 8 } as const;

/**
 * keyring/file backend 와 무관하게 항상 swap 되는 Goose YAML 아티팩트.
 *
 * 예약구역 whitelist(`classifyGoosePath`)가 이 두 경로를 provider 캐시와 함께 **파생**해야
 * 하므로 별도 함수로 뽑았다. 인라인 리터럴로 두면 whitelist 가 두 번째 재기술 지점이 되어
 * 이 모듈의 존재 이유가 무너진다.
 */
export function gooseConfigSources(): Source[] {
  return [
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/secrets.yaml`, saveAs: 'goose-secrets.yaml' },
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/config.yaml`, saveAs: 'goose-config.yaml' }
  ];
}

/**
 * 인정된 Goose provider 자격증명 캐시 source — **순서가 계약이다**.
 *
 * 파일과 디렉토리가 교차(index 3 = `githubcopilot`, index 5 = `databricks/oauth`)하는 0.8.0
 * 순서를 그대로 유지한다. 파일/디렉토리를 분리한 두 접근자로 나눠 이어붙이면 순서가
 * files-then-dirs 로 재정렬되어 restore 적용·롤백 순서(`switcher.ts`)와 doctor 출력 순서가
 * 바뀐다. 따라서 접근자는 이 하나만 export 한다.
 */
export function gooseProviderCacheSources(): Source[] {
  const dir = (path: string, saveAs: string): DirectorySource => ({ type: 'directory', path, saveAs, ...DIRECTORY_BOUNDS });
  return [
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/gemini_oauth/tokens.json`, saveAs: 'goose-provider-gemini-oauth-tokens.json' },
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/chatgpt_codex/tokens.json`, saveAs: 'goose-provider-chatgpt-codex-tokens.json' },
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/kimicode/token.json`, saveAs: 'goose-provider-kimicode-token.json' },
    dir(`${GOOSE_CONFIG_ROOT}/githubcopilot`, 'goose-provider-githubcopilot.tree.json'),
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/xai_oauth/tokens.json`, saveAs: 'goose-provider-xai-oauth-tokens.json' },
    dir(`${GOOSE_CONFIG_ROOT}/databricks/oauth`, 'goose-provider-databricks-oauth.tree.json'),
    { type: 'file', path: `${GOOSE_CONFIG_ROOT}/huggingface/oauth/tokens.json`, saveAs: 'goose-provider-huggingface-oauth-tokens.json' }
  ];
}

/**
 * `~/` 확장 후 어휘적 정규화. `process.cwd()` 에 의존하지 않는다.
 *
 * **왜 `resolve()` 가 아닌가**: `resolve()` 는 상대 경로를 `process.cwd()` 기준으로 풀기
 * 때문에 인정 집합이 "mat 을 어느 디렉토리에서 실행했는지" 에 따라 달라지는 비정적 속성이
 * 된다 (plugin 은 상대 경로를 선언할 수 있었다 — `cli-defs-plugin.ts` 참고). `normalize()` 는
 * 순수 어휘 연산이라 그 결합이 생기지 않는다.
 *
 * **왜 `realpath()` 가 아닌가**: 어휘적 `..` 접기가 커널의 실제 해석과 갈라지는 유일한 조건은
 * 중간 세그먼트가 symlink 인 경우인데, 그 조건은 `sources.ts` 의 provider 부모 검사
 * (symlink 거부 + HOME 부터 전 세그먼트 lstat)가 이미 fail-closed 로 거부한다. 따라서 판정
 * 단계에서 I/O 를 하지 않는다.
 */
export function normalizeGoosePath(p: string): string {
  return normalize(expandTilde(p));
}

/**
 * 비교 전용 정규화 — 공유 헬퍼 `comparablePath` 에 위임한다.
 *
 * 0.8.1 은 이 접기를 이 파일 안에 private 으로 두었으나, 같은 판정이 plugin 소유권 가드에도
 * 필요해지면서 `paths.ts` 로 옮겼다. 여기에 사본을 남기면 두 판정이 갈라질 수 있고, 그것이
 * 바로 이 모듈이 존재하는 이유(단일 진실 원천)와 정면으로 어긋난다.
 */
function comparableGoosePath(p: string): string {
  return comparablePath(p);
}


/** 인정 **파일** 경로의 비교용 집합. 하드닝 가드 전용이라 YAML/디렉토리는 포함하지 않는다. */
function admittedProviderCacheFilePaths(): ReadonlySet<string> {
  return new Set(
    gooseProviderCacheSources()
      .filter((src): src is FileSource => src.type === 'file')
      .map((src) => comparableGoosePath(src.path))
  );
}

/** 예약구역 정경 표기 9개(provider 7 + YAML 2)의 비교용 경로 집합. */
function canonicalComparableGoosePaths(): ReadonlySet<string> {
  return new Set(
    [...gooseProviderCacheSources(), ...gooseConfigSources()]
      .map((src) => ('path' in src ? comparableGoosePath(src.path) : ''))
      .filter((p) => p.length > 0)
  );
}

/**
 * 이 경로가 provider 캐시 **파일** 하드닝 경로를 타야 하는지.
 *
 * `sources.ts` / `doctor.ts` 가 이 함수로 판정한다. 정확 집합 멤버십이므로
 * `secrets.yaml`/`config.yaml` 은 절대 포함되지 않는다 — 두 YAML 은 0.8.0 과 동일하게
 * 일반 파일 경로로 다뤄야 한다(하드닝 경로로 끌어오면 기존 사용자의 스냅샷이 실패로 뒤집힌다).
 */
export function isAdmittedGooseProviderCacheFile(path: string): boolean {
  return admittedProviderCacheFilePaths().has(comparableGoosePath(path));
}

/**
 * Goose 예약구역 관점의 경로 분류.
 *
 * - `'admitted'`: 정경 표기 9개 중 하나와 정확히 일치.
 * - `'reserved-nonadmitted'`: 정규화 결과가 Goose config 디렉토리 **내부**인데 정경 표기가 아님.
 *   plugin 이 이런 경로를 선언하면 로드 시점에 거부한다. 조용히 일반 쓰기 경로로 흘려보내면
 *   다른 CLI 의 라이브 자격증명 구역에 무검증 쓰기를 허용하게 된다.
 * - `'outside'`: Goose 구역 밖 — mat 의 다른 source 와 동일하게 취급.
 *
 * **디렉토리 prefix 의미론을 의도적으로 갖지 않는다.** `~/.config/goose/githubcopilot/sub/x.json`
 * 은 `'reserved-nonadmitted'` 로 거부되는 것이 맞다. prefix 로 인정하면 그 파일이 파일 하드닝
 * 경로를 타는 동시에 부모 디렉토리 전체가 `goose-provider-githubcopilot.tree.json` 으로도
 * 캡처되어 이중 캡처와 복원 순서 충돌이 생긴다.
 */
export function classifyGoosePath(path: string): 'admitted' | 'reserved-nonadmitted' | 'outside' {
  const normalized = comparableGoosePath(path);
  if (canonicalComparableGoosePaths().has(normalized)) return 'admitted';
  const root = comparableGoosePath(GOOSE_CONFIG_ROOT);
  // 구역 **루트 자신**도 구역 안이다. `root + sep` 하위만 보면 `~/.config/goose` 와
  // `~/.config/goose/.`(정규화 후 루트와 동일)가 'outside' 로 새어나가, 술어가 경계에서 틀린다.
  if (normalized === root) return 'reserved-nonadmitted';
  // 플랫폼 구분자를 쓴다. Windows 에서 `normalize` 는 백슬래시를 만들므로 `/` 로 고정 비교하면
  // 예약구역 안의 경로가 전부 'outside' 로 새어나가 보호가 사라진다.
  return normalized.startsWith(`${root}${sep}`) ? 'reserved-nonadmitted' : 'outside';
}

/** 해석된 비교 키. 해석 불가면 `null`. */
function resolvedComparable(p: string): string | null {
  const id = resolvePathIdentitySync(p);
  return id.kind === 'unresolvable' ? null : id.comparable;
}

/**
 * `classifyGoosePath` 의 **identity 판정** 변형. plugin 선언 심사(`cli-defs-plugin.ts`)가 쓴다.
 *
 * ## 어휘 판정만으로 예약구역이 뚫리는 두 가지 실측 경로
 *
 * 1. **별칭 표기** — `~/gsalias` → `~/.config/goose/newprovider` 를 만들고 plugin 이
 *    `~/gsalias/tokens.json` 을 선언하면 어휘 분류가 `'outside'` 라 예약구역 검사가 걸리지
 *    않는다. 소유권 검사도 그 경로가 builtin source 가 **아니라서** 통과시킨다(예약구역은
 *    "builtin 이 지금 쓰는 경로" 보다 넓다 — 그게 예약구역을 따로 두는 이유다).
 * 2. **해석된 정경 표기** — `~/.config` 를 `~/dotfiles/config` 로 관리하는 사용자에게는 진짜
 *    구역이 `~/dotfiles/config/goose/` 다. plugin 이 그 경로를 **직접** 선언하면 어휘 분류는
 *    `'outside'` 이지만 실제로는 구역 한복판이다.
 *
 * 두 경로 모두 대상만 해석해서는 못 막는다 — (2)는 대상이 이미 해석형이다. **구역 루트도 함께
 * 해석해서** 비교해야 닫힌다.
 *
 * 해석 실패(`unresolvable`)는 여기서 판정을 바꾸지 않고 어휘 결과를 그대로 돌려준다. 그 입력은
 * 소유권 게이트가 별도 축에서 이미 거부하므로, 여기서 중복 거부하면 원인 메시지만 엉뚱해진다.
 */
export function classifyGoosePathByIdentity(path: string): 'admitted' | 'reserved-nonadmitted' | 'outside' {
  const lexical = classifyGoosePath(path);
  if (lexical !== 'outside') return lexical;
  const target = resolvedComparable(path);
  const root = resolvedComparable(GOOSE_CONFIG_ROOT);
  // 대상 해석 실패는 여기서 판정을 바꾸지 않는다 — 소유권 게이트가 `unresolvable` 을 **별도
  // 축에서** 이미 거부하므로, 여기서 중복 거부하면 원인 메시지만 엉뚱해진다.
  if (target === null) return lexical;
  // **구역 루트**를 해석할 수 없으면 어휘 결과를 그대로 쓴다. 거부하지 않는 이유:
  //
  // 여기까지 왔다는 것은 `target` 이 성공적으로 해석됐다는 뜻이다. 그런데 구역 루트가 해석되지
  // 않는다면, 구역 **안**의 어떤 경로도 해석될 수 없다 — 같은 깨진 구성요소를 지나야 하기
  // 때문이다. 즉 "target 은 해석됐는데 root 는 안 됐다" 는 조합 자체가 target 이 구역 밖임을
  // 증명한다. 어휘적으로 구역 안인 경로는 이 분기에 도달하기 전에 이미 걸러졌다.
  //
  // 한때 여기서 `'reserved-nonadmitted'` 를 반환했는데, 그 함수가 Gate 2 의 **모든 일반 파일
  // I/O** 경로에도 쓰이는 탓에 실측으로 이런 일이 났다: `~/.config` 가 ELOOP 이면 goose 와
  // 아무 상관 없는 `~/myapp/creds.json` 읽기까지 거부됐다. 닫으려던 fail-open 은 (위 논증대로)
  // 애초에 도달 불가능했고, 대가로 실재하는 가용성 회귀만 얻었다.
  if (root === null) return lexical;
  if (target === root) return 'reserved-nonadmitted';
  if (!target.startsWith(`${root}${sep}`)) return 'outside';
  const canonical = [...gooseProviderCacheSources(), ...gooseConfigSources()]
    .filter((src): src is FileSource | DirectorySource => 'path' in src);
  return canonical.some((src) => resolvedComparable(src.path) === target) ? 'admitted' : 'reserved-nonadmitted';
}
