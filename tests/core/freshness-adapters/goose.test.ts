/**
 * Goose adapter 단위 테스트 — `goose-keyring.json` (macOS keychain wrapper) +
 * `goose-secrets.yaml` + `goose-config.yaml` 3-source 분기.
 *
 * 핵심 invariant:
 *  - byte-identical → fresh (high)
 *  - YAML provider 키 set 변경 → stale (medium) — 다른 provider/계정 추정
 *  - 키 set 동일 + 값 변경 → rotated value-only (medium) — API key rotation
 *  - 키 set+값 동일 + 외 필드 변경 → rotated meta-only (medium)
 *  - keyring wrapper account 변경 → stale (high)
 *  - keyring wrapper parse 실패 → rotated both (low)
 *  - 미지원 saveAs → low confidence fallback
 *  - 주석/빈 라인/들여쓰기 무시 (flat YAML parser 동작)
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

describe('gooseAdapter — YAML provider key 매트릭스', () => {
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
    expect(r.detail).toMatch(/API key 값 변경/);
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

  it('config.yaml — provider 키 동일 + routing 변경 → rotated meta-only (medium)', () => {
    // GOOSE_MODEL 은 PROVIDER_KEY_PATTERNS 와 매칭 안 됨 (provider key 가 아님) →
    // extractProviderSecrets 결과는 양쪽 모두 빈 {}. 키 set 동일 + 값 차이도 없으므로
    // meta-only 분류 (provider key 동일 + 외 필드 변경).
    const stored = makeYaml({ GOOSE_MODEL: 'claude-sonnet-4', GOOSE_PROVIDER__TYPE: 'anthropic' });
    const live = makeYaml({ GOOSE_MODEL: 'claude-opus-4', GOOSE_PROVIDER__TYPE: 'anthropic' });
    const r = gooseAdapter.compare(YAML_CONFIG, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('주석 + 빈 라인 + 들여쓰기 (nested) 무시 → flat YAML parser invariant', () => {
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
    // top-level 키 동일 (ANTHROPIC_API_KEY 만 추출), 값 동일 → fresh 아님 (다른 라인 존재).
    // provider 키 set 동일 + 값 동일 → meta-only.
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
