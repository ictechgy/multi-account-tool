/**
 * 사용자 노출 메시지의 자격증명/토큰 후보를 가리는 공통 redaction helper.
 *
 * 에러(stderr/TUI)와 freshness detail 이 같은 패턴을 공유하되, marker/threshold/cap 만
 * 호출자별로 다르게 줄 수 있게 한다.
 */

import { sanitizeDisplayText } from './display-safety.js';

const JWT_RE = /eyJ[A-Za-z0-9+/=._-]{20,}/g;
const PROVIDER_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9._-]{8,}|ya29\.[A-Za-z0-9._-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
const SECRET_FIELD =
  '(?:[A-Za-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token|session[_-]?token|password|token|accessToken|refreshToken|idToken|apiKey|secretKey|clientSecret|authToken|bearerToken|sessionToken)';
const AUTH_KEY = String.raw`["']?\bauthorization\b["']?`;
const RAW_BREAK = String.raw`[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`;
const ESCAPED_BREAK = String.raw`\\(?:[nrtbfv0]|x[0-9a-f]{2}|u[0-9a-f]{4}|u\{[0-9a-f]{1,6}\})`;
const SEP = String.raw`(?:${RAW_BREAK}|${ESCAPED_BREAK})*`;
const TOKEN_BREAK = String.raw`(?:${RAW_BREAK}|${ESCAPED_BREAK})+`;
const SPLIT_JWT_RE = new RegExp(
  String.raw`\beyJ(?:[A-Za-z0-9+/=._-]*${TOKEN_BREAK})+(?:[A-Za-z0-9+/=._-]+${TOKEN_BREAK})*[A-Za-z0-9+/=._-]{6,}`,
  'giu'
);
const SPLIT_PROVIDER_TOKEN_RE = new RegExp(
  String.raw`\b(?:sk-|ya29\.|gh[pousr]_|xox[baprs]-)(?:[A-Za-z0-9._-]*${TOKEN_BREAK})+(?:[A-Za-z0-9._-]+${TOKEN_BREAK})*[A-Za-z0-9._-]{4,}`,
  'giu'
);
const DQ_VALUE = String.raw`((?:\\.|[^"\\])*)`;
const SQ_VALUE = String.raw`((?:\\.|[^'\\])*)`;
const UNQUOTED_VALUE = String.raw`([^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}"',}\[\]<][^"',}\[\]<]*)`;
const AUTH_UNQUOTED_VALUE = String.raw`([^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}"',}\[\]<][^"',\[\]<]*)`;
const AUTH_SCHEME = String.raw`([A-Za-z][A-Za-z0-9+.-]*)`;
const AUTH_SCHEME_NC = String.raw`(?:[A-Za-z][A-Za-z0-9+.-]*)`;
const QUOTED_AUTH_VALUE_RE =
  new RegExp(String.raw`(${AUTH_KEY}${SEP}[:=]${SEP})(?:"${AUTH_SCHEME}${TOKEN_BREAK}${DQ_VALUE}"|'${AUTH_SCHEME}${TOKEN_BREAK}${SQ_VALUE}')`, 'giu');
const QUOTED_AUTH_TOKEN_RE =
  new RegExp(String.raw`(${AUTH_KEY}${SEP}[:=]${SEP}${AUTH_SCHEME_NC}${TOKEN_BREAK})(?:"${DQ_VALUE}"|'${SQ_VALUE}')`, 'giu');
const UNQUOTED_AUTH_RE = new RegExp(String.raw`(${AUTH_KEY}${SEP}[:=]${SEP}${AUTH_SCHEME_NC}${TOKEN_BREAK})${AUTH_UNQUOTED_VALUE}`, 'giu');
const QUOTED_SECRET_FIELD_RE =
  new RegExp(String.raw`(["']?)\b(${SECRET_FIELD})\b\1(${SEP}[:=]${SEP})(?:"${DQ_VALUE}"|'${SQ_VALUE}')`, 'giu');
const UNQUOTED_SECRET_FIELD_RE =
  new RegExp(String.raw`(["']?)\b(${SECRET_FIELD})\b\1(${SEP}[:=]${SEP})${UNQUOTED_VALUE}`, 'giu');

export interface RedactSecretLikeOptions {
  secretMarker: string;
  jwtMarker: string;
  longSecretMin: number;
  maxLength: number;
}

function alreadyRedacted(value: string, opts: RedactSecretLikeOptions): boolean {
  return value === opts.secretMarker || value === opts.jwtMarker;
}

function redactAuthorizationValues(s: string, opts: RedactSecretLikeOptions): string {
  return s
    .replace(QUOTED_AUTH_VALUE_RE, (m, prefix, doubleScheme, doubleValue, singleScheme, singleValue) => {
      const quote = doubleScheme !== undefined ? '"' : "'";
      const scheme = doubleScheme ?? singleScheme;
      const value = doubleValue ?? singleValue;
      return alreadyRedacted(value, opts) ? m : `${prefix}${quote}${scheme} ${opts.secretMarker}${quote}`;
    })
    .replace(QUOTED_AUTH_TOKEN_RE, (m, prefix, doubleValue, singleValue) => {
      const quote = doubleValue !== undefined ? '"' : "'";
      return alreadyRedacted(doubleValue ?? singleValue, opts) ? m : `${prefix}${quote}${opts.secretMarker}${quote}`;
    })
    .replace(UNQUOTED_AUTH_RE, `$1${opts.secretMarker}`);
}

function redactQuotedSecretField(s: string, opts: RedactSecretLikeOptions): string {
  return s.replace(QUOTED_SECRET_FIELD_RE, (m, kq, key, sep, doubleValue, singleValue) => {
    const quote = doubleValue !== undefined ? '"' : "'";
    const value = doubleValue ?? singleValue;
    if (alreadyRedacted(value, opts)) return m;
    return `${kq}${key}${kq}${sep}${quote}${opts.secretMarker}${quote}`;
  });
}

function redactUnquotedSecretField(s: string, opts: RedactSecretLikeOptions): string {
  return s.replace(UNQUOTED_SECRET_FIELD_RE, (m, kq, key, sep, value) => {
    if (alreadyRedacted(value, opts)) return m;
    return `${kq}${key}${kq}${sep}${opts.secretMarker}`;
  });
}

export function redactSecretLikeText(s: string, opts: RedactSecretLikeOptions): string {
  const longSecretRe = new RegExp(`[A-Za-z0-9+/=_-]{${opts.longSecretMin},}`, 'g');
  const markerRedacted = s.replace(JWT_RE, opts.jwtMarker).replace(PROVIDER_TOKEN_RE, opts.secretMarker);
  const fieldRedacted = redactUnquotedSecretField(redactQuotedSecretField(redactAuthorizationValues(markerRedacted, opts), opts), opts);
  const splitRedacted = fieldRedacted
    .replace(SPLIT_JWT_RE, opts.jwtMarker)
    .replace(SPLIT_PROVIDER_TOKEN_RE, opts.secretMarker);
  return sanitizeDisplayText(splitRedacted.replace(longSecretRe, opts.secretMarker)).slice(0, opts.maxLength);
}
