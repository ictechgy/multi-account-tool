/**
 * Provisional Copilot app-state fixture parser.
 *
 * This module is a safety gate for redacted fixtures only. It is not product
 * support, not a stable public API, and intentionally performs no filesystem,
 * process, shell, or credential-store access.
 */

export type CopilotAppStateErrorCode =
  | 'invalid-json'
  | 'invalid-root'
  | 'token-like-plaintext'
  | 'unsupported-shape'
  | 'account-missing'
  | 'account-ambiguous';

export interface CopilotAccountBinding {
  displayLogin: string;
  stableAccountId?: string;
  storeAccountKey?: string;
}

export interface CopilotAccountCandidate {
  displayLogin: string;
  stableAccountId?: string;
  storeAccountKey?: string;
  lastUsed?: boolean;
  active?: boolean;
}

export interface CopilotAppStateParseSuccess {
  ok: true;
  accounts: CopilotAccountCandidate[];
  tokenLikeKeyPaths: [];
  ignoredMetadataKeys: string[];
}

export interface CopilotAppStateParseFailure {
  ok: false;
  code: Exclude<CopilotAppStateErrorCode, 'account-missing' | 'account-ambiguous'>;
  message: string;
  tokenLikeKeyPaths?: string[];
  ignoredMetadataKeys?: string[];
}

export type CopilotAppStateParseResult = CopilotAppStateParseSuccess | CopilotAppStateParseFailure;

export type CopilotAccountSelectionWarningCode = 'last-used-mismatch' | 'active-mismatch';

export type CopilotAccountSelectionResult =
  | { ok: true; account: CopilotAccountCandidate; warnings: CopilotAccountSelectionWarningCode[] }
  | {
      ok: false;
      code: 'account-missing' | 'account-ambiguous';
      message: string;
      matchedAccounts?: CopilotAccountCandidate[];
    };

type JsonObject = Record<string, unknown>;

const LOGGED_IN_USERS_KEY = 'loggedInUsers';
const LOGIN_FIELDS = ['login', 'username', 'email', 'displayLogin'] as const;
const STABLE_ID_FIELDS = ['id', 'accountId', 'stableAccountId'] as const;
const STORE_KEY_FIELDS = ['storeAccountKey', 'keychainAccount', 'secretServiceAccount'] as const;
const TOKEN_KEY_TERMS = ['access', 'refresh', 'oauth', 'github', 'gh', 'copilot'] as const;

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || hasControlCharacters(trimmed)) return undefined;
  return trimmed;
}

function firstString(obj: JsonObject, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = nonEmptyString(obj[field]);
    if (value) return value;
  }
  return undefined;
}

function isTokenLikeKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/g, '').toLowerCase();
  if (normalized === 'token') return true;
  return normalized.endsWith('token') && TOKEN_KEY_TERMS.some((term) => normalized.includes(term));
}

function collectTokenLikeKeyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectTokenLikeKeyPaths(entry, `${prefix}[${index}]`));
  }
  if (!isPlainObject(value)) return [];

  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (isTokenLikeKey(key) && typeof child === 'string' && child.trim().length > 0) {
      paths.push(keyPath);
    }
    paths.push(...collectTokenLikeKeyPaths(child, keyPath));
  }
  return [...new Set(paths)];
}

function unsupportedShape(ignoredMetadataKeys: string[]): CopilotAppStateParseFailure {
  return {
    ok: false,
    code: 'unsupported-shape',
    message: 'Unsupported Copilot app-state account-selection shape.',
    ignoredMetadataKeys
  };
}

function accountFromLoggedInUser(value: unknown): CopilotAccountCandidate | null {
  if (!isPlainObject(value)) return null;

  const displayLogin = firstString(value, LOGIN_FIELDS);
  if (!displayLogin) return null;

  const stableAccountId = firstString(value, STABLE_ID_FIELDS);
  const storeAccountKey = firstString(value, STORE_KEY_FIELDS);
  const lastUsed = typeof value.lastUsed === 'boolean' ? value.lastUsed : undefined;
  const active = typeof value.active === 'boolean' ? value.active : undefined;

  return {
    displayLogin,
    ...(stableAccountId ? { stableAccountId } : {}),
    ...(storeAccountKey ? { storeAccountKey } : {}),
    ...(lastUsed !== undefined ? { lastUsed } : {}),
    ...(active !== undefined ? { active } : {})
  };
}

export function parseCopilotAppState(raw: string | unknown): CopilotAppStateParseResult {
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, code: 'invalid-json', message: 'Copilot app-state is not valid JSON.' };
    }
  } else {
    parsed = raw;
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'invalid-root', message: 'Copilot app-state root must be a JSON object.' };
  }

  const ignoredMetadataKeys = Object.keys(parsed)
    .filter((key) => key !== LOGGED_IN_USERS_KEY)
    .sort();
  const tokenLikeKeyPaths = collectTokenLikeKeyPaths(parsed);
  if (tokenLikeKeyPaths.length > 0) {
    return {
      ok: false,
      code: 'token-like-plaintext',
      message: 'Copilot app-state contains credential-looking plaintext fields; key paths only are reported.',
      tokenLikeKeyPaths,
      ignoredMetadataKeys
    };
  }

  const loggedInUsers = parsed[LOGGED_IN_USERS_KEY];
  if (!Array.isArray(loggedInUsers) || loggedInUsers.length === 0) {
    return unsupportedShape(ignoredMetadataKeys);
  }

  const accounts: CopilotAccountCandidate[] = [];
  for (const entry of loggedInUsers) {
    const account = accountFromLoggedInUser(entry);
    if (!account) return unsupportedShape(ignoredMetadataKeys);
    accounts.push(account);
  }

  return { ok: true, accounts, tokenLikeKeyPaths: [], ignoredMetadataKeys };
}

function accountsFrom(
  stateOrAccounts: CopilotAppStateParseSuccess | readonly CopilotAccountCandidate[]
): readonly CopilotAccountCandidate[] {
  return 'accounts' in stateOrAccounts ? stateOrAccounts.accounts : stateOrAccounts;
}

function selectionWarnings(
  selected: CopilotAccountCandidate,
  accounts: readonly CopilotAccountCandidate[]
): CopilotAccountSelectionWarningCode[] {
  const warnings: CopilotAccountSelectionWarningCode[] = [];
  if (selected.lastUsed !== true && accounts.some((account) => account !== selected && account.lastUsed === true)) {
    warnings.push('last-used-mismatch');
  }
  if (selected.active !== true && accounts.some((account) => account !== selected && account.active === true)) {
    warnings.push('active-mismatch');
  }
  return warnings;
}

export function selectCopilotAccount(
  stateOrAccounts: CopilotAppStateParseSuccess | readonly CopilotAccountCandidate[],
  binding: CopilotAccountBinding
): CopilotAccountSelectionResult {
  const accounts = accountsFrom(stateOrAccounts);
  const stableAccountId = nonEmptyString(binding.stableAccountId);
  const storeAccountKey = nonEmptyString(binding.storeAccountKey);
  const displayLogin = nonEmptyString(binding.displayLogin);

  let matches: CopilotAccountCandidate[];
  if (stableAccountId) {
    matches = accounts.filter((account) => account.stableAccountId === stableAccountId);
  } else if (storeAccountKey) {
    matches = accounts.filter((account) => account.storeAccountKey === storeAccountKey);
  } else if (displayLogin) {
    matches = accounts.filter((account) => account.displayLogin === displayLogin);
  } else {
    matches = [];
  }

  if (matches.length === 0) {
    return { ok: false, code: 'account-missing', message: 'Bound Copilot account is not present in app-state.' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'account-ambiguous',
      message: 'Bound Copilot account matched multiple app-state entries and requires disambiguation.',
      matchedAccounts: matches
    };
  }

  const account = matches[0];
  return { ok: true, account, warnings: selectionWarnings(account, accounts) };
}
