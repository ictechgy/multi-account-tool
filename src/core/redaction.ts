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
const AUTH_KEY = '["\\\']?\\bauthorization\\b["\\\']?';
const QUOTED_AUTH_VALUE_RE = new RegExp(`(${AUTH_KEY}\\s*[:=]\\s*)(["'])Bearer\\s+[\\s\\S]*?\\2`, 'gi');
const QUOTED_BEARER_TOKEN_RE = new RegExp(`(${AUTH_KEY}\\s*[:=]\\s*Bearer\\s+)(["'])[\\s\\S]*?\\2`, 'gi');
const UNQUOTED_BEARER_RE = new RegExp(`(${AUTH_KEY}\\s*[:=]\\s*Bearer\\s+)([^\\s"',}\\[\\]<]+)`, 'gi');
const QUOTED_SECRET_FIELD_RE = new RegExp(`(["']?)\\b(${SECRET_FIELD})\\b\\1(\\s*[:=]\\s*)(["'])([\\s\\S]*?)\\4`, 'gi');
const UNQUOTED_SECRET_FIELD_RE = new RegExp(`(["']?)\\b(${SECRET_FIELD})\\b\\1(\\s*[:=]\\s*)([^\\s"',}\\[\\]<]+)`, 'gi');

export interface RedactSecretLikeOptions {
  secretMarker: string;
  jwtMarker: string;
  longSecretMin: number;
  maxLength: number;
}

function alreadyRedacted(value: string, opts: RedactSecretLikeOptions): boolean {
  return value === opts.secretMarker || value === opts.jwtMarker;
}

function redactBearerValues(s: string, opts: RedactSecretLikeOptions): string {
  return s
    .replace(QUOTED_AUTH_VALUE_RE, `$1$2Bearer ${opts.secretMarker}$2`)
    .replace(QUOTED_BEARER_TOKEN_RE, `$1$2${opts.secretMarker}$2`)
    .replace(UNQUOTED_BEARER_RE, `$1${opts.secretMarker}`);
}

function redactQuotedSecretField(s: string, opts: RedactSecretLikeOptions): string {
  return s.replace(QUOTED_SECRET_FIELD_RE, (m, kq, key, sep, vq, value) => {
    if (alreadyRedacted(value, opts)) return m;
    return `${kq}${key}${kq}${sep}${vq}${opts.secretMarker}${vq}`;
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
  const fieldRedacted = redactUnquotedSecretField(redactQuotedSecretField(redactBearerValues(markerRedacted, opts), opts), opts);
  return sanitizeDisplayText(fieldRedacted.replace(longSecretRe, opts.secretMarker)).slice(0, opts.maxLength);
}
