/**
 * Goose adapter 단위 테스트 — `goose-keyring.json` (macOS keychain wrapper) +
 * `goose-secrets.yaml` + `goose-config.yaml` 3-source 분기.
 *
 * 핵심 invariant (PR-H iter 1 quad-review + PR-M yaml lib 도입 fix 반영):
 *  - byte-identical → fresh (high)
 *  - YAML provider 키 set 변경 → stale (medium)
 *  - 키 set 동일 + 값 변경 → rotated value-only (medium)
 *  - 키 set+값 동일 + 외 필드 변경 → rotated meta-only (medium)
 *  - 매트릭스 추출 0/0 (empty whitelist) → low-conf rotated both (H1)
 *  - block scalar (`|`/`>`) 정식 parse — yaml lib v2 가 resolved string 으로 추출.
 *    옛 flat parser 시절의 'block scalar 감지 → 강등' 동작은 PR-M 에서 제거됨 (H2 fix 의 후속).
 *  - YAML parse 실패 (spec 위반) → low-conf 강등 (PR-M).
 *  - block scalar chomping 차이 (`|` clip vs `|-` strip) 정규화 — trailing newline strip
 *    으로 false-positive value-only 방지 (PR-M HIGH fix).
 *  - numeric / boolean primitive 도 `String()` coerce 후 매트릭스 진입 (PR-M MED fix).
 *  - config.yaml routing 키 (GOOSE_PROVIDER__TYPE/MODEL) 변경 → value-only/stale (M1)
 *  - _TOKEN$ generic 제거 — DEBUG_TOKEN 등 misclassify 안 됨 (M2)
 *  - parseGooseYaml `__proto__`/`constructor`/`prototype` 키 skip (M3)
 *  - keyring wrapper account XOR → stale low (H4)
 *  - keyring wrapper parse 실패/value 부재 → rotated both low
 *  - 미지원 saveAs → low confidence fallback
 */

import { describe, expect, it } from 'vitest';

import { gooseAdapter } from '../../../src/core/freshness-adapters/goose.js';

const YAML_SECRETS = 'goose-secrets.yaml';
const YAML_CONFIG = 'goose-config.yaml';
const KEYRING = 'goose-keyring.json';

/** flat YAML payload helper. */
function makeYaml(pairs: Record<string, string>): string {
  return Object.entries(pairs).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
}

/** macOS keychain wrapper helper. inner 는 YAML 본문. */
function makeKeyring(inner: string, account?: string): string {
  return JSON.stringify(account !== undefined ? { value: inner, account } : { value: inner });
}

describe('gooseAdapter — secrets.yaml provider 매트릭스', () => {
  it('byte-identical → fresh (high)', () => {
    const raw = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A' });
    expect(gooseAdapter.compare(YAML_SECRETS, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('provider 키 set 동일 + API key 값 변경 → rotated value-only (medium)', () => {
    const stored = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-OLD' });
    const live = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-NEW' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/값 변경/);
  });

  it('provider 키 set 변경 (provider 추가) → stale (medium) — 다른 계정 추정', () => {
    const stored = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A' });
    const live = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A', OPENAI_API_KEY: 'sk-O' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/provider 키 set 변경/);
  });

  it('multi-provider — 양쪽 모두 ANTHROPIC + OPENAI, 한 키만 rotation → rotated value-only', () => {
    const stored = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A', OPENAI_API_KEY: 'sk-O-old' });
    const live = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A', OPENAI_API_KEY: 'sk-O-new' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('주석 + 빈 라인 + 들여쓰기 (nested) 무시 → flat YAML parser invariant', () => {
    // top-level ANTHROPIC_API_KEY 만 추출 — 양쪽 키 set 동일 + 값 동일 (nested 라인 차이는 무시) → meta-only.
    const stored = [
      '# top comment',
      '',
      'ANTHROPIC_API_KEY: sk-ant-A',
      'nested:',
      '  ignored_key: v',
      '# tail'
    ].join('\n');
    const live = [
      '',
      '# header',
      'ANTHROPIC_API_KEY: sk-ant-A',
      'other_nested:',
      '  v2: v'
    ].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('quoted YAML 값 (single/double quote) → quote strip 후 비교', () => {
    const stored = `ANTHROPIC_API_KEY: "sk-ant-A"\n`;
    const live = `ANTHROPIC_API_KEY: 'sk-ant-A'\n`;
    // byte 다르지만 quote strip 후 값 동일 → meta-only (key set 동일, 외 차이 없음).
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });
});

describe('gooseAdapter — config.yaml routing 매트릭스 (M1 fix)', () => {
  it('routing 키 변경 (GOOSE_MODEL) → rotated value-only (medium)', () => {
    // GOOSE_MODEL 은 routing identity — provider 자체 변경 외에도 model 변경은 의미 있음.
    const stored = makeYaml({ GOOSE_MODEL: 'claude-sonnet-4', GOOSE_PROVIDER__TYPE: 'anthropic' });
    const live = makeYaml({ GOOSE_MODEL: 'claude-opus-4', GOOSE_PROVIDER__TYPE: 'anthropic' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('iter 2 Codex-3 #2 fix: GOOSE_PROVIDER__TYPE 변경 (anthropic → openai) → stale (다른 provider/계정 swap)', () => {
    // iter 1 의 잘못된 expectation (value-only) 정정. CONFIG_STALE_ON_VALUE_CHANGE_RE
    // 에 매칭되는 키 (GOOSE_PROVIDER__TYPE / GOOSE_PROVIDER) 의 값 변경은 단순
    // rotation 이 아닌 identity 변경 (다른 provider 의 다른 계정 swap 의미).
    const stored = makeYaml({ GOOSE_PROVIDER__TYPE: 'anthropic', GOOSE_MODEL: 'm' });
    const live = makeYaml({ GOOSE_PROVIDER__TYPE: 'openai', GOOSE_MODEL: 'm' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/identity 키 'GOOSE_PROVIDER__TYPE' 값 변경/);
  });

  it('iter 2 Codex-3 #2 fix: GOOSE_PROVIDER 도 stale-on-change 매트릭스', () => {
    const stored = makeYaml({ GOOSE_PROVIDER: 'a', GOOSE_MODEL: 'm' });
    const live = makeYaml({ GOOSE_PROVIDER: 'b', GOOSE_MODEL: 'm' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.detail).toMatch(/identity 키 'GOOSE_PROVIDER' 값 변경/);
  });


  it('config.yaml 의 non-routing 키만 변경 (CUSTOM_VAR) → meta-only', () => {
    // routing 매트릭스 미매칭 키 변경은 meta-only.
    const stored = makeYaml({ GOOSE_PROVIDER__TYPE: 'anthropic', CUSTOM_VAR: 'a' });
    const live = makeYaml({ GOOSE_PROVIDER__TYPE: 'anthropic', CUSTOM_VAR: 'b' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });
});

describe('gooseAdapter — H1 empty-matrix + PR-M block scalar 정식 parse', () => {
  it('H1: 매트릭스 추출 0/0 + byte-diff → low-conf rotated both', () => {
    // PROVIDER_KEY_PATTERNS / CONFIG_ROUTING_KEY_PATTERNS 모두 미매칭 키.
    // 양쪽 모두 매트릭스 빈 → low-conf rotated both 분류 (freshness.ts:266-277 와 대칭).
    const stored = makeYaml({ random_var_a: 'x' });
    const live = makeYaml({ random_var_b: 'y' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/provider 키 미감지/);
  });

  it('PR-M: block scalar `|` 가 정식 parse → resolved 값 비교 → rotated value-only (medium)', () => {
    // 옛 flat parser 는 indent 라인을 skip 해 secret 본문 손실 → low-conf 강등.
    // yaml lib (v2, YAML 1.2 spec) 도입 후엔 block scalar 가 resolved string 으로
    // entries 에 들어감 → 매트릭스가 정확히 매칭 → 값 변경 시 rotated value-only.
    const stored = ['ANTHROPIC_API_KEY: |', '  sk-ant-OLD', ''].join('\n');
    const live = ['ANTHROPIC_API_KEY: |', '  sk-ant-NEW', ''].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('medium');
    // 더 이상 block scalar hint 미포함 (정식 parse 라 confidence 강등 불필요).
    expect(r.detail).not.toMatch(/block scalar/);
  });

  it('PR-M: block scalar `>` (folded) 도 정식 parse + 비교', () => {
    // `>` 는 newline 을 space 로 folding 하지만 값은 string 으로 추출됨.
    const stored = ['OPENAI_API_KEY: >', '  sk-O-OLD'].join('\n');
    const live = ['OPENAI_API_KEY: >', '  sk-O-NEW'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('medium');
  });

  it('PR-M: block scalar 의 chomping/indentation indicator (`|2`, `|-`, `>+`) 도 정식 parse', () => {
    // YAML spec 의 valid block scalar header 전체 — yaml lib 가 해석.
    const cases = [
      ['ANTHROPIC_API_KEY: |2', '  sk-A'],
      ['ANTHROPIC_API_KEY: |-', '  sk-A'],
      ['ANTHROPIC_API_KEY: >+', '  sk-A']
    ];
    for (const lines of cases) {
      const r = gooseAdapter.compare(
        YAML_SECRETS,
        lines.join('\n'),
        'ANTHROPIC_API_KEY: sk-DIFFERENT\n'
      );
      expect(r.kind).toBe('rotated');
      expect(r.subtype).toBe('value-only');
      // medium 이어야 함 — 옛 flat parser 시절의 low 강등이 사라졌는지 회귀 가드.
      expect(r.confidence).toBe('medium');
    }
  });

  it('PR-M: block scalar header + trailing comment (`| # comment`) 도 정식 parse', () => {
    const stored = ['ANTHROPIC_API_KEY: | # inline comment', '  sk-OLD'].join('\n');
    const live = ['ANTHROPIC_API_KEY: |', '  sk-NEW'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('medium');
  });

  it('PR-M: invalid YAML → parse 실패 → empty matrix verdict 의 YAML parse 실패 hint', () => {
    // yaml lib 의 throw 케이스 (닫히지 않은 quote 등). 양쪽 모두 throw → empty
    // matrix verdict 가 parse 실패 hint 포함.
    const stored = 'ANTHROPIC_API_KEY: "unclosed quote\n';
    const live = 'OPENAI_API_KEY: "another unclosed\n';
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/YAML parse 실패/);
  });

  it('PR-M: 한쪽만 invalid YAML + 매트릭스 매칭 → downgrade 로 confidence low', () => {
    // 한쪽 정상 (매트릭스 매칭) + 한쪽 throw → matrix verdict 에 parse 실패 hint
    // 부착 + confidence low 로 강등 (downgradeForParseError).
    const stored = 'ANTHROPIC_API_KEY: "unclosed\n';
    const live = 'ANTHROPIC_API_KEY: sk-VALID\n';
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/YAML parse 실패/);
  });

  it('PR-M quad-review HIGH fix: 동일 본문 + chomping 차이 (`|` clip vs `|-` strip) → false-positive value-only 회귀 차단', () => {
    // yaml lib: `K: |\n  v` → `"v\n"` (clip, trailing \n 유지)
    //          `K: |-\n  v` → `"v"` (strip, trailing \n 제거)
    // 사용자가 stored 는 `|`, live 는 `|-` 로 (또는 Goose 재직렬화로) 작성 시
    // 동일 secret 인데 trailing \n 차이로 value-only rotation 으로 잘못 분류되던 회귀.
    // parseGooseYaml 의 trailing newline strip 정규화로 fix 됨 → meta-only 분류.
    const stored = ['ANTHROPIC_API_KEY: |', '  sk-SAME', ''].join('\n');
    const live = ['ANTHROPIC_API_KEY: |-', '  sk-SAME', ''].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only'); // 값 동일, 외 필드만 변경 (chomping 마커)
  });

  it('PR-M quad-review MED fix: GOOSE_MODEL 의 numeric value (`3.5`) 도 매트릭스 진입 — silent skip 회귀 차단', () => {
    // YAML 1.2 spec 의 scalar tag resolution 으로 `3.5` 는 number 로 parse 됨.
    // 옛 string-only filter (`typeof !== 'string' continue`) 는 silent skip →
    // sameKeySet 비대칭 → false-positive stale 분류 위험.
    // coerceToIdentityString 으로 String(number) 강제 → 매트릭스 진입.
    const stored = ['GOOSE_PROVIDER__TYPE: anthropic', 'GOOSE_MODEL: 3.5', ''].join('\n');
    const live = ['GOOSE_PROVIDER__TYPE: anthropic', 'GOOSE_MODEL: 4.0', ''].join('\n');
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    // GOOSE_MODEL 만 값 변경, GOOSE_PROVIDER__TYPE 동일 → 단순 rotation (model 변경).
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('PR-M quad-review MED fix: boolean / null literal value 도 정합 처리', () => {
    // YAML 1.2 의 `true`/`false`/`yes`/`null`/`~` 등이 scalar tag resolution 됨.
    // boolean 은 coerce, null 은 skip — 양쪽 동일하게 처리되는지 검증.
    // 양쪽 모두 boolean true → 매트릭스 매칭 동일 → meta-only.
    const stored = makeYaml({ ANTHROPIC_API_KEY: 'sk-X', GOOSE_DEBUG: 'true' });
    const live = makeYaml({ ANTHROPIC_API_KEY: 'sk-X', GOOSE_DEBUG: 'false' });
    // GOOSE_DEBUG 는 provider/routing 매트릭스 미매칭 → meta-only.
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('PR-M Codex iter 2 LOW fix: matrix-key boolean value (true ↔ false) — coerce 후 매트릭스 진입', () => {
    // 옛 string-only filter 라면 boolean value 인 ANTHROPIC_API_KEY (악성 / 오타) 는
    // silent skip 되어 매트릭스 비대칭 → false-positive stale 위험.
    // coerceToIdentityString 으로 boolean 도 String() coerce → 매트릭스 진입 →
    // 동일 키 + 값 변경 → value-only.
    const stored = 'ANTHROPIC_API_KEY: true\n';
    const live = 'ANTHROPIC_API_KEY: false\n';
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('PR-M Codex iter 2 LOW fix: matrix-key null literal — skip 후 사용자 알림', () => {
    // ANTHROPIC_API_KEY: null (yaml lib → JS null) → coerceToIdentityString skip.
    // 양쪽 모두 null → 양쪽 매트릭스 0건 → empty matrix verdict (low-conf rotated both).
    const stored = 'ANTHROPIC_API_KEY: null\n';
    const live = 'ANTHROPIC_API_KEY: ~\n'; // YAML 1.2 의 null 별명
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/provider 키 미감지/);
  });

  it('PR-M Codex iter 2 LOW fix: multi-document YAML (---) → throw → parse 실패 hint', () => {
    // yaml.parse 는 multi-doc 입력에 throw. 본 코드는 hasParseError 로 surface.
    // Goose 의 secrets.yaml/config.yaml 은 단일 문서 가정이므로 multi-doc 은 손상 추정.
    const stored = 'ANTHROPIC_API_KEY: sk-A\n---\nOPENAI_API_KEY: sk-B\n';
    const live = 'ANTHROPIC_API_KEY: sk-A\n';
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/YAML parse 실패/);
  });
});

describe('gooseAdapter — M2 _TOKEN$ regex 제거 (non-provider 흡수 차단)', () => {
  it('DEBUG_TOKEN 같은 non-provider TOKEN 키 변경 → provider 매트릭스 미매칭 → empty-matrix 분기', () => {
    // 이전엔 _TOKEN$ generic 으로 DEBUG_TOKEN 이 provider 로 분류 → stale 오분류.
    // M2 fix 후: PROVIDER_KEY_PATTERNS 에 없으므로 미매칭 → low-conf both.
    const stored = makeYaml({ DEBUG_TOKEN: 'old', CSRF_TOKEN: 'x' });
    const live = makeYaml({ DEBUG_TOKEN: 'new', CSRF_TOKEN: 'y' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/provider 키 미감지/);
  });

  it('DATABRICKS_TOKEN 은 명시 매트릭스 유지 — 값 변경 시 rotated value-only', () => {
    // _TOKEN$ generic 제거됐어도 DATABRICKS_TOKEN specific 은 유지.
    const stored = makeYaml({ DATABRICKS_TOKEN: 'dapi-OLD' });
    const live = makeYaml({ DATABRICKS_TOKEN: 'dapi-NEW' });
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });
});

describe('gooseAdapter — M3 prototype pollution 가드', () => {
  it('__proto__: poison 라인은 무시 (DANGEROUS_KEYS 가드 + Object.create(null))', () => {
    // 양쪽에 __proto__ 라인이 있어도 entries 에 추가되지 않으므로 동일하게 처리.
    // ANTHROPIC_API_KEY 만 추출되어 비교 → 값 동일 → meta-only (다른 라인 byte 차이).
    const stored = ['__proto__: malicious', 'ANTHROPIC_API_KEY: sk-A'].join('\n');
    const live = ['__proto__: other', 'ANTHROPIC_API_KEY: sk-A'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
    // prototype 자체가 오염되지 않았는지 sanity check.
    const probe: Record<string, unknown> = {};
    expect((probe as Record<string, unknown>).malicious).toBeUndefined();
  });

  it('constructor / prototype 키도 무시', () => {
    const stored = ['constructor: x', 'prototype: y', 'OPENAI_API_KEY: sk-A'].join('\n');
    const live = ['constructor: a', 'prototype: b', 'OPENAI_API_KEY: sk-A'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    // OPENAI_API_KEY 만 추출 → 값 동일 → meta-only.
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });
});

describe('gooseAdapter — keyring wrapper', () => {
  it('keyring wrapper account 변경 → stale (high)', () => {
    const yaml = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A' });
    const stored = makeKeyring(yaml, 'secrets');
    const live = makeKeyring(yaml, 'other');
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('high');
    expect(r.detail).toMatch(/Keychain account 변경/);
  });

  it('H4: keyring wrapper account XOR (한쪽만 string) → stale low — identity 우회 차단', () => {
    // PR-A 의 multi-account 보호 의도 — 한쪽만 account 있고 다른쪽 부재면 손상 추정.
    const yaml = makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-A' });
    const stored = makeKeyring(yaml, 'secrets');
    const live = makeKeyring(yaml);  // account 누락
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/account 비대칭/);
  });

  it('iter 2 Codex-3 #3 fix: empty-string account `""` 는 유효 string 으로 취급 (typeof 정밀화)', () => {
    // 이전 truthiness ('' && ...) 는 empty string 을 absent 로 잘못 분류해 XOR 분기
    // 우회 가능. typeof === 'string' 정밀화 후 양쪽 모두 empty string 동일 → null
    // (다음 단계 위임) → inner YAML 동일 → fresh.
    const yaml = makeYaml({ ANTHROPIC_API_KEY: 'sk-A' });
    const stored = makeKeyring(yaml, '');
    const live = makeKeyring(yaml, '');
    expect(gooseAdapter.compare(KEYRING, stored, live)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('iter 2 Codex-3 #3 fix: empty-string vs missing account → XOR stale (truthiness 우회 차단)', () => {
    // 한쪽 ''(string), 다른쪽 undefined — XOR stale 로 분류돼야.
    const yaml = makeYaml({ ANTHROPIC_API_KEY: 'sk-A' });
    const stored = makeKeyring(yaml, '');
    const live = makeKeyring(yaml);  // account 키 자체 없음
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/account 비대칭/);
  });

  it('iter 2 Codex-3 #3 fix: 양쪽 모두 비-string (number) → keyring 손상 surface', () => {
    // 이전엔 silent skip (null 반환). fix 후 wrapper damage 명시.
    const yaml = makeYaml({ ANTHROPIC_API_KEY: 'sk-A' });
    const stored = JSON.stringify({ value: yaml, account: 42 });
    const live = JSON.stringify({ value: yaml, account: true });
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/양쪽 모두 비-string/);
  });

  it('keyring wrapper 동일 account + inner YAML rotation → rotated value-only', () => {
    const stored = makeKeyring(makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-OLD' }), 'secrets');
    const live = makeKeyring(makeYaml({ ANTHROPIC_API_KEY: 'sk-ant-NEW' }), 'secrets');
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('keyring wrapper parse 실패 → rotated both (low)', () => {
    const r = gooseAdapter.compare(KEYRING, '{not json', 'also broken');
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });

  it('keyring wrapper value 부재 → rotated both (low)', () => {
    const stored = JSON.stringify({ account: 'secrets' });
    const live = JSON.stringify({ account: 'secrets', value: 42 });
    const r = gooseAdapter.compare(KEYRING, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/inner value 부재 또는 비-문자열/);
  });

  it('byte-identical keyring → fresh (high)', () => {
    const wrap = makeKeyring(makeYaml({ ANTHROPIC_API_KEY: 'sk-A' }), 'secrets');
    expect(gooseAdapter.compare(KEYRING, wrap, wrap)).toEqual({ kind: 'fresh', confidence: 'high' });
  });
});

describe('gooseAdapter — v1.40 provider cache admission', () => {
  it.each([
    'goose-provider-gemini-oauth-tokens.json',
    'goose-provider-chatgpt-codex-tokens.json',
    'goose-provider-kimicode-token.json',
    'goose-provider-githubcopilot.tree.json',
    'goose-provider-xai-oauth-tokens.json',
    'goose-provider-databricks-oauth.tree.json'
  ])('%s remains opaque: equal is fresh and a diff is low-confidence rotated', (saveAs) => {
    expect(gooseAdapter.compare(saveAs, 'opaque-fixture-a', 'opaque-fixture-a')).toEqual({ kind: 'fresh', confidence: 'high' });
    expect(gooseAdapter.compare(saveAs, 'opaque-fixture-a', 'opaque-fixture-b')).toMatchObject({ kind: 'rotated', subtype: 'both', confidence: 'low' });
  });
});

describe('gooseAdapter — 미지원 saveAs', () => {
  it('미지원 saveAs → low confidence fallback', () => {
    const r = gooseAdapter.compare('unknown.txt', 'x', 'y');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });
});
