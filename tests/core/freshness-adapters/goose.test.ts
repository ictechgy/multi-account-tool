/**
 * Goose adapter 단위 테스트 — `goose-keyring.json` (macOS keychain wrapper) +
 * `goose-secrets.yaml` + `goose-config.yaml` 3-source 분기.
 *
 * 핵심 invariant (iter 1 quad-review fix 반영):
 *  - byte-identical → fresh (high)
 *  - YAML provider 키 set 변경 → stale (medium)
 *  - 키 set 동일 + 값 변경 → rotated value-only (medium)
 *  - 키 set+값 동일 + 외 필드 변경 → rotated meta-only (medium)
 *  - 매트릭스 추출 0/0 (empty whitelist) → low-conf rotated both (H1)
 *  - block scalar 감지 → confidence 강등 (H2)
 *  - config.yaml routing 키 (GOOSE_PROVIDER__TYPE/MODEL) 변경 → value-only/stale (M1)
 *  - _TOKEN$ generic 제거 — DEBUG_TOKEN 등 misclassify 안 됨 (M2)
 *  - parseFlatYaml `__proto__`/`constructor`/`prototype` 키 skip (M3)
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

  it('GOOSE_PROVIDER__TYPE 변경 (anthropic → openai) → rotated value-only (provider 자체 swap)', () => {
    // M1 fix 의 핵심 회귀 가드: routing 키 set 동일 + provider type 값 변경.
    const stored = makeYaml({ GOOSE_PROVIDER__TYPE: 'anthropic', GOOSE_MODEL: 'm' });
    const live = makeYaml({ GOOSE_PROVIDER__TYPE: 'openai', GOOSE_MODEL: 'm' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.detail).toMatch(/routing/);
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

describe('gooseAdapter — H1 empty-matrix + H2 block scalar', () => {
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

  it('H2: block scalar `|` 감지 → confidence low 강등 + detail hint', () => {
    // ANTHROPIC_API_KEY: | 다음 indent 라인의 secret 본문이 silent 손실 가능.
    const stored = ['ANTHROPIC_API_KEY: |', '  sk-ant-OLD', ''].join('\n');
    const live = ['ANTHROPIC_API_KEY: |', '  sk-ant-NEW', ''].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/block scalar/);
  });

  it('H2: block scalar `>` 도 동일 감지', () => {
    const stored = ['OPENAI_API_KEY: >', '  sk-O-OLD'].join('\n');
    const live = ['OPENAI_API_KEY: >', '  sk-O-NEW'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/block scalar/);
  });

  it('H1 + H2 결합: 매트릭스 빈 + block scalar 감지 → detail 에 두 hint 모두 포함', () => {
    const stored = ['random_key: |', '  some content'].join('\n');
    const live = ['random_key2: |', '  other content'].join('\n');
    const r = gooseAdapter.compare(YAML_SECRETS, stored, live);
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/provider 키 미감지/);
    expect(r.detail).toMatch(/block scalar 감지/);
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

describe('gooseAdapter — 미지원 saveAs', () => {
  it('미지원 saveAs → low confidence fallback', () => {
    const r = gooseAdapter.compare('unknown.txt', 'x', 'y');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });
});
