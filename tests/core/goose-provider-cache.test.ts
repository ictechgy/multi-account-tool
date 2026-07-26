/**
 * Goose provider 캐시 경로 계약 회귀 테스트.
 *
 * 이 파일의 존재 이유: 0.8.0 은 업스트림에 없는 `providers/` 세그먼트를 세 곳(cli-defs source
 * 정의 / sources 하드닝 가드 / doctor 진단 가드)에 **똑같이** 담고 있었고, 기존 테스트는
 * 픽스처를 같은 잘못된 경로에 만들었기 때문에 전부 통과했다. 즉 개수·자기참조 단정으로는
 * 이 결함을 잡을 수 없다. 따라서 아래 단정은 모듈을 import 하지 않는 **독립 리터럴**과
 * 비교하고, builtin 전수 스윕으로 미래의 drift 까지 막는다.
 */

import { describe, expect, it } from 'vitest';
import { join, normalize } from 'node:path';
import { homedir } from 'node:os';

import {
  classifyGoosePath,
  gooseConfigSources,
  gooseProviderCacheSources,
  isAdmittedGooseProviderCacheFile,
  normalizeGoosePath
} from '../../src/core/goose-provider-cache.js';
import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import { expandTilde, isNormalizedPathSpelling } from '../../src/core/paths.js';

/**
 * 모듈을 참조하지 않는 독립 기대값 — 업스트림 v1.43.0 commit 5a9eb7e 의
 * `provider_secrets.rs` / `huggingface_auth.rs:19` 에서 직접 옮겨 적었다.
 * **순서가 계약이다**: 디렉토리가 index 3 / 5 에 교차한다.
 */
const EXPECTED_PROVIDER_SOURCES = [
  { type: 'file', path: '~/.config/goose/gemini_oauth/tokens.json', saveAs: 'goose-provider-gemini-oauth-tokens.json' },
  { type: 'file', path: '~/.config/goose/chatgpt_codex/tokens.json', saveAs: 'goose-provider-chatgpt-codex-tokens.json' },
  { type: 'file', path: '~/.config/goose/kimicode/token.json', saveAs: 'goose-provider-kimicode-token.json' },
  { type: 'directory', path: '~/.config/goose/githubcopilot', saveAs: 'goose-provider-githubcopilot.tree.json', maxEntries: 128, maxBytes: 1_048_576, maxDepth: 8 },
  { type: 'file', path: '~/.config/goose/xai_oauth/tokens.json', saveAs: 'goose-provider-xai-oauth-tokens.json' },
  { type: 'directory', path: '~/.config/goose/databricks/oauth', saveAs: 'goose-provider-databricks-oauth.tree.json', maxEntries: 128, maxBytes: 1_048_576, maxDepth: 8 },
  { type: 'file', path: '~/.config/goose/huggingface/oauth/tokens.json', saveAs: 'goose-provider-huggingface-oauth-tokens.json' }
];

const EXPECTED_CONFIG_SOURCES = [
  { type: 'file', path: '~/.config/goose/secrets.yaml', saveAs: 'goose-secrets.yaml' },
  { type: 'file', path: '~/.config/goose/config.yaml', saveAs: 'goose-config.yaml' }
];

describe('goose provider cache — 경로 계약', () => {
  it('인정 source 가 업스트림 상대 경로와 정확히 일치하고 교차 순서를 유지한다', () => {
    expect(gooseProviderCacheSources()).toEqual(EXPECTED_PROVIDER_SOURCES);
    expect(gooseConfigSources()).toEqual(EXPECTED_CONFIG_SOURCES);
  });

  it('어떤 인정 경로에도 `providers/` 세그먼트가 없다 (0.8.0 결함의 직접 회귀 단정)', () => {
    for (const src of [...gooseProviderCacheSources(), ...gooseConfigSources()]) {
      expect(src.path).not.toContain('/providers/');
    }
  });

  it('모든 인정 경로 표기가 정규형이라 판정 문자열과 I/O 문자열이 갈라지지 않는다', () => {
    for (const src of [...gooseProviderCacheSources(), ...gooseConfigSources()]) {
      expect(isNormalizedPathSpelling(src.path)).toBe(true);
      expect(normalizeGoosePath(src.path)).toBe(expandTilde(src.path));
    }
  });
});

describe('goose provider cache — 하드닝 가드 멤버십', () => {
  it('인정 provider **파일** 5개만 하드닝 경로를 탄다', () => {
    const admitted = EXPECTED_PROVIDER_SOURCES.filter(src => src.type === 'file').map(src => src.path);
    for (const path of admitted) expect(isAdmittedGooseProviderCacheFile(path)).toBe(true);
  });

  it('YAML 두 개는 하드닝 경로를 타지 않는다 — prefix 방식의 over-match 를 구조적으로 차단', () => {
    // 정정된 인정 경로가 `~/.config/goose/` 직하로 올라왔기 때문에, prefix 판정으로 되돌리면
    // 이 두 파일이 provider 하드닝 경로로 삼켜져 기존 사용자의 스냅샷이 실패로 뒤집힌다.
    for (const src of EXPECTED_CONFIG_SOURCES) expect(isAdmittedGooseProviderCacheFile(src.path)).toBe(false);
  });

  it('인정 **디렉토리** 2개는 파일 가드 대상이 아니다 (directory-source 불변식이 담당)', () => {
    for (const src of EXPECTED_PROVIDER_SOURCES.filter(s => s.type === 'directory')) {
      expect(isAdmittedGooseProviderCacheFile(src.path)).toBe(false);
    }
  });
});

describe('goose provider cache — 근접 실패 (각 케이스 독립)', () => {
  it('구(舊) 오경로 `providers/gemini_oauth/tokens.json` 는 인정되지 않는다', () => {
    const stale = '~/.config/goose/providers/gemini_oauth/tokens.json';
    expect(isAdmittedGooseProviderCacheFile(stale)).toBe(false);
    expect(classifyGoosePath(stale)).toBe('reserved-nonadmitted');
  });

  it('`~/` 별칭에 `..` 가 있어도 expandTilde 가 정규화하므로 인정된다', () => {
    // expandTilde 는 `join(homedir(), …)` 이고 join 은 normalize 를 포함한다 → `~/` 리터럴은
    // 구조적으로 항상 정규형. 따라서 판정과 실제 I/O 대상이 같은 문자열이다.
    const alias = '~/.config/goose/x/../gemini_oauth/tokens.json';
    expect(isNormalizedPathSpelling(alias)).toBe(true);
    expect(isAdmittedGooseProviderCacheFile(alias)).toBe(true);
  });

  it('정경 절대 경로 등가물은 인정된다', () => {
    const absolute = join(homedir(), '.config/goose/gemini_oauth/tokens.json');
    expect(isAdmittedGooseProviderCacheFile(absolute)).toBe(true);
  });

  it('`..` 를 포함한 비-틸데 절대 경로는 **정규형이 아니므로** plugin 로드에서 거부되어야 한다', () => {
    // 이 경로는 정규화하면 인정 대상이 되지만, expandTilde 가 원형을 그대로 반환하므로
    // 실제 I/O 는 `..` 형태로 이뤄진다. 그 상태로 인정하면 sources.ts 의 부모 identity
    // 비교가 어긋나 정상 경로인데도 TOCTOU 를 암시하는 오류로 실패한다.
    // `join()` 은 정규화하므로 비정규 표기는 문자열 결합으로 만들어야 재현된다 —
    // plugin JSON 이 주는 raw 문자열이 바로 이 형태다.
    const denormalized = `${homedir()}/.config/goose/x/../gemini_oauth/tokens.json`;
    expect(isNormalizedPathSpelling(denormalized)).toBe(false);
    expect(normalize(denormalized)).toBe(join(homedir(), '.config/goose/gemini_oauth/tokens.json'));
  });

  it('대소문자 변형은 인정되지 않는다 (0.8.0 과 동일한 잔여 상태이며 신규 회귀가 아니다)', () => {
    // 판정은 파일시스템 identity 가 아니라 정규 표기 문자열 멤버십이다. 대소문자 무시
    // 파일시스템에서는 같은 실물을 가리키면서 'outside' 로 분류된다 — 구 prefix 판정도
    // 동일하게 이 표기를 하드닝하지 않았으므로 이번 변경이 만든 구멍이 아니다.
    expect(isAdmittedGooseProviderCacheFile('~/.config/Goose/gemini_oauth/tokens.json')).toBe(false);
  });

  it('goose 구역 밖 경로는 그대로 일반 source 로 취급된다', () => {
    expect(classifyGoosePath('~/.config/other/tokens.json')).toBe('outside');
    expect(isAdmittedGooseProviderCacheFile('~/.config/other/tokens.json')).toBe(false);
  });

  it('예약구역은 디렉토리 prefix 의미론을 갖지 않는다', () => {
    // prefix 로 인정하면 이 파일이 파일 하드닝 경로를 타는 동시에 부모 디렉토리 전체가
    // githubcopilot 트리로도 캡처되어 이중 캡처·복원 순서 충돌이 생긴다.
    expect(classifyGoosePath('~/.config/goose/githubcopilot/sub/x.json')).toBe('reserved-nonadmitted');
    expect(isAdmittedGooseProviderCacheFile('~/.config/goose/githubcopilot/sub/x.json')).toBe(false);
  });

  it('판정이 process.cwd() 에 의존하지 않는다', () => {
    const path = '~/.config/goose/xai_oauth/tokens.json';
    const original = process.cwd();
    const first = isAdmittedGooseProviderCacheFile(path);
    try {
      process.chdir('/');
      expect(isAdmittedGooseProviderCacheFile(path)).toBe(first);
      expect(first).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});

describe('goose provider cache — builtin drift 스윕', () => {
  it('goose 구역 안의 모든 builtin file source 는 인정 정경 표기여야 한다', () => {
    // 미래에 누군가 gooseSources() 에 provider 경로를 인라인으로 추가하면 인정 집합에 없으므로
    // 하드닝 가드가 false 를 반환해 조용히 일반 쓰기 경로로 라우팅된다 — 이번 결함과 **같은
    // 방향(조용한 성공)** 이다. 그 회귀를 여기서 차단한다.
    for (const def of BUILTIN_CLI_DEFS) {
      for (const src of def.sources) {
        if (src.type !== 'file' && src.type !== 'directory') continue;
        if (classifyGoosePath(src.path) === 'outside') continue;
        expect(classifyGoosePath(src.path), `${def.id}: ${src.path}`).toBe('admitted');
        expect(isNormalizedPathSpelling(src.path), `${def.id}: ${src.path}`).toBe(true);
      }
    }
  });

  it('goose def 가 실제로 인정 배열을 그대로 spread 한다 (재기술 지점 1곳 확인)', () => {
    const goose = BUILTIN_CLI_DEFS.find(def => def.id === 'goose');
    expect(goose).toBeDefined();
    const providerPaths = goose!.sources
      .filter(src => src.saveAs.startsWith('goose-provider-'))
      .map(src => ('path' in src ? src.path : ''));
    expect(providerPaths).toEqual(EXPECTED_PROVIDER_SOURCES.map(src => src.path));
  });
});
