import { describe, expect, it } from 'vitest';

import {
  buildProfileIdentity,
  formatProfileIdentity,
  identityCapabilitiesForCli,
  normalizeProfileIdentity
} from '../../src/core/profile-identity.js';

const HASH_RE = /<hash:[0-9a-f]{12}>/;

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('profile identity metadata', () => {
  it('extracts Codex account_id as a masked fingerprint and never hashes API keys', () => {
    const rawAccount = 'acct-user-123@example.test';
    const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const identity = buildProfileIdentity({
      cliId: 'codex',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      sources: [
        {
          saveAs: 'auth.json',
          state: 'captured',
          value: JSON.stringify({ tokens: { account_id: rawAccount }, OPENAI_API_KEY: apiKey, auth_mode: 'ChatGPT' })
        }
      ]
    });

    expect(identity.completeness).toBe('complete');
    expect(serialized(identity)).toMatch(HASH_RE);
    expect(serialized(identity)).toContain('api-key-mode');
    expect(serialized(identity)).not.toContain(rawAccount);
    expect(serialized(identity)).not.toContain(apiKey);
  });

  it('extracts Gemini active email as a fingerprint only', () => {
    const email = 'person@example.test';
    const identity = buildProfileIdentity({
      cliId: 'gemini',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      sources: [
        { saveAs: 'oauth_creds.json', state: 'captured', value: '{}' },
        { saveAs: 'google_accounts.json', state: 'captured', value: JSON.stringify({ active: email }) }
      ]
    });

    expect(identity.signals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'email' })]));
    expect(serialized(identity)).toMatch(HASH_RE);
    expect(serialized(identity)).not.toContain(email);
  });

  it('marks carried-forward and missing multi-source states as partial', () => {
    const identity = buildProfileIdentity({
      cliId: 'gemini',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      sources: [
        { saveAs: 'oauth_creds.json', state: 'carried-forward', value: '{}' },
        { saveAs: 'google_accounts.json', state: 'missing', value: null }
      ]
    });

    expect(identity.completeness).toBe('partial');
    expect(identity.warnings).toEqual(expect.arrayContaining([
      { code: 'carried-forward', source: 'oauth_creds.json' },
      { code: 'missing-source', source: 'google_accounts.json' }
    ]));
  });

  it('masks user-controlled OpenCode provider names instead of echoing raw freeform values', () => {
    const provider = 'alice@example.test-sk-abcdefghijklmnopqrstuvwxyz';
    const identity = buildProfileIdentity({
      cliId: 'opencode',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      sources: [
        { saveAs: 'opencode-auth.json', state: 'captured', value: JSON.stringify({ [provider]: { type: 'api', key: 'SECRET' } }) }
      ]
    });

    expect(serialized(identity)).toMatch(HASH_RE);
    expect(serialized(identity)).not.toContain(provider);
  });

  it('degrades malformed OpenCode provider entries instead of throwing capture', () => {
    const identity = buildProfileIdentity({
      cliId: 'opencode',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      sources: [
        { saveAs: 'opencode-auth.json', state: 'captured', value: JSON.stringify({ openai: null }) }
      ]
    });

    expect(identity.status).toBe('available');
    expect(identity.signals).toEqual([expect.objectContaining({ kind: 'provider', value: 'openai' })]);
    expect(identity.warnings).toEqual([expect.objectContaining({ code: 'parse-error', source: 'opencode-auth.json' })]);
  });

  it('normalizes tampered meta identity before display', () => {
    const tampered = {
      schemaVersion: 1,
      status: 'available',
      capturedAt: '2026-06-14T00:00:00.000Z',
      completeness: 'complete',
      signals: [
        { kind: 'email', source: 'auth.json', confidence: 'high', value: 'raw@example.test' },
        { kind: 'account', source: '../../../secret', confidence: 'high', fingerprint: '<hash:123456789abc>' },
        { kind: 'provider', source: 'x', confidence: 'medium', value: 'openai' }
      ],
      warnings: [{ code: 'missing-source', source: '../../../secret' }]
    };

    const normalized = normalizeProfileIdentity(tampered);
    const text = formatProfileIdentity(normalized);

    expect(serialized(normalized)).not.toContain('raw@example.test');
    expect(serialized(normalized)).not.toContain('../../../secret');
    expect(text).not.toContain('raw@example.test');
    expect(text).toContain('provider:openai');
  });

  it('rejects parseable but non-UTC-ISO timestamps from tampered metadata', () => {
    expect(normalizeProfileIdentity({
      schemaVersion: 1,
      status: 'available',
      capturedAt: 'June 14, 2026 00:00:00',
      completeness: 'complete',
      signals: [{ kind: 'provider', source: 'auth.json', confidence: 'medium', value: 'openai' }]
    })).toBeUndefined();
  });

  it('keeps api-key-mode normalized metadata mode-only even if tampered with a fingerprint', () => {
    const normalized = normalizeProfileIdentity({
      schemaVersion: 1,
      status: 'available',
      capturedAt: '2026-06-14T00:00:00.000Z',
      completeness: 'complete',
      signals: [{ kind: 'api-key-mode', source: 'auth.json', confidence: 'medium', fingerprint: '<hash:123456789abc>' }]
    });

    expect(normalized?.signals).toEqual([{ kind: 'api-key-mode', source: 'auth.json', confidence: 'medium' }]);
    expect(formatProfileIdentity(normalized)).toContain('api-key-mode:api-key-mode');
    expect(formatProfileIdentity(normalized)).not.toContain('<hash:123456789abc>');
  });

  it('marks lock-free recapture identity summaries when lock was degraded', () => {
    const identity = buildProfileIdentity({
      cliId: 'codex',
      capturedAt: new Date('2026-06-14T00:00:00Z'),
      lockHeld: false,
      sources: [{ saveAs: 'auth.json', state: 'captured', value: JSON.stringify({ auth_mode: 'ChatGPT' }) }]
    });

    expect(identity.warnings).toEqual([expect.objectContaining({ code: 'lock-free-recapture' })]);
  });

  it('reports static support capabilities without profile data', () => {
    expect(identityCapabilitiesForCli('codex').status).toBe('available');
    expect(identityCapabilitiesForCli('plugin').status).toBe('unsupported');
  });

  it('keeps Goose provider-cache identity opaque and never surfaces dynamic descendant names or token bytes', () => {
    const secret = 'goose-provider-secret-abcdefghijklmnopqrstuvwxyz0123456789';
    const dynamicName = 'customer@example.test/private-token.json';
    const identity = buildProfileIdentity({
      cliId: 'goose',
      capturedAt: new Date('2026-07-14T00:00:00Z'),
      sources: [{
        saveAs: 'goose-provider-githubcopilot.tree.json',
        state: 'captured',
        value: JSON.stringify({ version: 1, entries: [{ kind: 'file', path: dynamicName, contentBase64: Buffer.from(secret).toString('base64') }] })
      }]
    });
    const text = serialized(identity);
    expect(identity.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'identity-unavailable', source: 'goose-provider-githubcopilot.tree.json' })]));
    expect(identity.signals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'provider', value: 'githubcopilot', confidence: 'low' })]));
    expect(text).not.toContain(dynamicName);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('customer@example.test');
  });

  it('keeps the Goose Hugging Face OAuth cache opaque and exposes only its fixed provider label', () => {
    const secret = 'hf-oauth-secret-abcdefghijklmnopqrstuvwxyz0123456789';
    const identity = buildProfileIdentity({
      cliId: 'goose',
      capturedAt: new Date('2026-07-15T00:00:00Z'),
      sources: [{
        saveAs: 'goose-provider-huggingface-oauth-tokens.json',
        state: 'captured',
        value: JSON.stringify({ access_token: secret, refresh_token: `${secret}-refresh` })
      }]
    });
    const text = serialized(identity);

    expect(identity.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'identity-unavailable', source: 'goose-provider-huggingface-oauth-tokens.json' })
    ]));
    expect(identity.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'provider', value: 'huggingface', confidence: 'low' })
    ]));
    expect(text).not.toContain(secret);
    expect(text).not.toContain('access_token');
  });
});
