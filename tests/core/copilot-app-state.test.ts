import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import {
  parseCopilotAppState,
  selectCopilotAccount,
  type CopilotAppStateParseSuccess
} from '../../src/core/copilot-app-state.js';

const fixtureDir = new URL('../fixtures/copilot-app-state/', import.meta.url);
const sourceUrl = new URL('../../src/core/copilot-app-state.ts', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

function expectParsed(name: string): CopilotAppStateParseSuccess {
  const parsed = parseCopilotAppState(fixture(name));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(`expected ${name} to parse`);
  return parsed;
}

describe('Copilot app-state fixture parser safety gate', () => {
  it('parses two accounts and selects the explicitly bound account', () => {
    const parsed = expectParsed('selected-bound-account.json');

    expect(parsed.accounts).toEqual([
      {
        displayLogin: 'work@fixture.example',
        stableAccountId: 'acct-fixture-work',
        storeAccountKey: 'store-fixture-work',
        lastUsed: true,
        active: true
      },
      {
        displayLogin: 'personal@fixture.example',
        stableAccountId: 'acct-fixture-personal',
        storeAccountKey: 'store-fixture-personal',
        lastUsed: false,
        active: false
      }
    ]);
    expect(parsed.ignoredMetadataKeys).toEqual(['firstLaunchAt', 'installedPlugins', 'staff']);

    const selected = selectCopilotAccount(parsed, {
      displayLogin: 'work@fixture.example',
      stableAccountId: 'acct-fixture-work'
    });

    expect(selected).toEqual({
      ok: true,
      account: expect.objectContaining({ displayLogin: 'work@fixture.example', stableAccountId: 'acct-fixture-work' }),
      warnings: []
    });
  });

  it('does not infer the account from last-used or active state', () => {
    const parsed = expectParsed('last-used-mismatch.json');
    const selected = selectCopilotAccount(parsed, {
      displayLogin: 'work@fixture.example',
      stableAccountId: 'acct-fixture-work'
    });

    expect(selected).toEqual({
      ok: true,
      account: expect.objectContaining({
        displayLogin: 'work@fixture.example',
        stableAccountId: 'acct-fixture-work',
        lastUsed: false,
        active: false
      }),
      warnings: ['last-used-mismatch', 'active-mismatch']
    });
  });

  it('fails closed when the bound account is missing from app-state', () => {
    const parsed = expectParsed('bound-account-missing.json');
    const selected = selectCopilotAccount(parsed, {
      displayLogin: 'missing@fixture.example',
      stableAccountId: 'acct-fixture-missing'
    });

    expect(selected).toEqual({
      ok: false,
      code: 'account-missing',
      message: 'Bound Copilot account is not present in app-state.'
    });
  });

  it('rejects unknown account-selection shapes', () => {
    const parsed = parseCopilotAppState(fixture('unknown-shape.json'));

    expect(parsed).toEqual({
      ok: false,
      code: 'unsupported-shape',
      message: 'Unsupported Copilot app-state account-selection shape.',
      ignoredMetadataKeys: ['firstLaunchAt', 'installedPlugins', 'staff']
    });
  });

  it('rejects token-like plaintext fallback fields without echoing values', () => {
    const parsed = parseCopilotAppState(fixture('token-like-plaintext.json'));
    const serialized = JSON.stringify(parsed);

    expect(parsed).toEqual({
      ok: false,
      code: 'token-like-plaintext',
      message: 'Copilot app-state contains credential-looking plaintext fields; key paths only are reported.',
      tokenLikeKeyPaths: ['loggedInUsers[0].githubToken'],
      ignoredMetadataKeys: ['firstLaunchAt', 'installedPlugins', 'staff']
    });
    expect(serialized).toContain('loggedInUsers[0].githubToken');
    expect(serialized).not.toContain('REDACTED-FIXTURE');
  });

  it('requires disambiguation for duplicate display labels but accepts stable ids or store keys', () => {
    const parsed = expectParsed('duplicate-display-labels.json');

    const ambiguous = selectCopilotAccount(parsed, { displayLogin: 'shared@fixture.example' });
    expect(ambiguous).toEqual({
      ok: false,
      code: 'account-ambiguous',
      message: 'Bound Copilot account matched multiple app-state entries and requires disambiguation.',
      matchedAccounts: [
        expect.objectContaining({ stableAccountId: 'acct-fixture-shared-a' }),
        expect.objectContaining({ stableAccountId: 'acct-fixture-shared-b' })
      ]
    });

    expect(selectCopilotAccount(parsed, {
      displayLogin: 'shared@fixture.example',
      stableAccountId: 'acct-fixture-shared-b'
    })).toEqual({
      ok: true,
      account: expect.objectContaining({ stableAccountId: 'acct-fixture-shared-b' }),
      warnings: ['last-used-mismatch', 'active-mismatch']
    });

    expect(selectCopilotAccount(parsed, {
      displayLogin: 'shared@fixture.example',
      storeAccountKey: 'store-fixture-shared-a'
    })).toEqual({
      ok: true,
      account: expect.objectContaining({ storeAccountKey: 'store-fixture-shared-a' }),
      warnings: []
    });
  });

  it('keeps the parser pure and avoids product-support wiring', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).not.toMatch(/from ['"]node:(fs|os|child_process|process)['"]/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/from ['"]\.\/(sources|os-keyring|cli-defs|switcher|session)/);
    expect(BUILTIN_CLI_DEFS.some((def) => def.id === 'copilot')).toBe(false);
  });

  it('keeps redacted fixtures synthetic and free of token-shaped values', () => {
    for (const name of readdirSync(fixtureDir).filter((entry) => entry.endsWith('.json'))) {
      const text = fixture(name);
      const emailLike = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];

      for (const value of emailLike) {
        expect(value, `${name} uses only @fixture.example identities`).toMatch(/@fixture\.example$/);
      }
      expect(text, `${name} must not contain GitHub classic/pat token shapes`).not.toMatch(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/);
      expect(text, `${name} must not contain OpenAI-like key shapes`).not.toMatch(/\bsk-[A-Za-z0-9]{12,}/);
      expect(text, `${name} must not contain Slack token shapes`).not.toMatch(/\bxox[baprs]-/);
      expect(text, `${name} must not contain JWT-like values`).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    }
  });
});
