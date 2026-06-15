/**
 * CLI def plugin loader: 사용자가 `~/.multi-account-tool/cli-defs/*.json` 으로
 * 새 CLI 정의를 mat 코드 변경 없이 추가할 수 있게 한다.
 *
 * 안전 정책:
 * - 잘못된 JSON / 형식 위반은 warn + skip — mat 본체는 정상 동작 (fail-open 부적합:
 *   사용자가 mat 을 못 쓰게 막지 않음. 단, 실패한 plugin 은 적용 안 됨)
 * - id 충돌 (builtin vs user 또는 user 끼리): 첫 등장 우선, 후속 충돌은 warn + skip
 * - 모든 사용자 입력값 (id, saveAs) 은 paths.ts 의 validateCliId /
 *   validateProfileFileName 으로 한 번 더 검증 (defense-in-depth)
 * - `source.path` (file source) 는 사용자가 의도적으로 선택한 자기 경로이므로
 *   포맷 검증만 (빈 문자열 차단). traversal 검증 안 함 — 사용자 본인 fs 임.
 *
 * sync I/O 로 startup 시점에 1회 로드 (cli-defs 의 getAllCliDefs 가 캐시).
 * cli-defs/ 디렉토리가 없으면 조용히 빈 결과 반환 (사용자가 plugin 미사용).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hasUnsafeDisplayChar } from './display-safety.js';
import { validatePublicEnvSecretSource } from './env-secret-source.js';
import { dataDir, validateCliId, validateProfileFileName } from './paths.js';
import { redactSecretLikeText } from './redaction.js';
import type { CliDef, FileSource, KeychainSource, OsKeyringSource, Source } from './types.js';

/** plugin 파일이 모이는 디렉토리: `~/.multi-account-tool/cli-defs/`. */
const CLI_DEFS_DIR_NAME = 'cli-defs';
const MAX_PLUGIN_NAME_LENGTH = 80;
const MAX_PLUGIN_SERVICE_LENGTH = 128;

/** 사용자 plugin 디렉토리 절대 경로. */
export function cliDefsDir(): string {
  return join(dataDir(), CLI_DEFS_DIR_NAME);
}

function formatPluginWarning(text: string): string {
  return redactSecretLikeText(text, {
    secretMarker: '[redacted]',
    jwtMarker: '[redacted-jwt]',
    longSecretMin: 24,
    maxLength: 500
  });
}

export interface LoadUserCliDefsResult {
  /** 검증 통과한 CLI 정의 (등장 순서, id 충돌 시 첫 등장 우선). */
  defs: CliDef[];
  /** 사용자에게 표시할 경고 — 파싱 실패 / 형식 위반 / 충돌 등. */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface SourceParseResult {
  source?: Source;
  error?: string;
}

/** 단일 source 객체 검증 + 정규화. 실패 시 error 메시지 반환. */
function parseSource(raw: unknown, idx: number): SourceParseResult {
  if (!isPlainObject(raw)) return { error: `sources[${idx}] 는 객체여야 합니다.` };
  if (raw.type !== 'file' && raw.type !== 'keychain' && raw.type !== 'os-keyring' && raw.type !== 'env-secret') {
    return { error: `sources[${idx}].type 는 'file', 'keychain', 'os-keyring' 또는 'env-secret' 이어야 합니다.` };
  }
  if (typeof raw.saveAs !== 'string') return { error: `sources[${idx}].saveAs 는 문자열이어야 합니다.` };
  let safeSaveAs: string;
  try {
    safeSaveAs = validateProfileFileName(raw.saveAs);
  } catch (err) {
    return { error: `sources[${idx}].saveAs: ${(err as Error).message}` };
  }
  if (raw.type === 'env-secret') {
    try {
      return { source: validatePublicEnvSecretSource({ ...raw, saveAs: safeSaveAs }) };
    } catch (err) {
      return { error: `sources[${idx}].type 'env-secret' schema is invalid or runtime-blocked: ${(err as Error).message}` };
    }
  }
  if (raw.type === 'file') {
    if (typeof raw.path !== 'string' || raw.path.length === 0) {
      return { error: `sources[${idx}].path 는 비어있지 않은 문자열이어야 합니다.` };
    }
    if (hasUnsafeDisplayChar(raw.path)) {
      return { error: `sources[${idx}].path 에 제어/서식 문자가 포함될 수 없습니다.` };
    }
    const src: FileSource = { type: 'file', path: raw.path, saveAs: safeSaveAs };
    return { source: src };
  }
  if (typeof raw.service !== 'string' || raw.service.length === 0) {
    return { error: `sources[${idx}].service 는 비어있지 않은 문자열이어야 합니다.` };
  }
  if (raw.service.trim() !== raw.service) {
    return { error: `sources[${idx}].service 는 앞뒤 공백 없이 입력해야 합니다.` };
  }
  if (raw.service.length > MAX_PLUGIN_SERVICE_LENGTH) {
    return { error: `sources[${idx}].service 는 ${MAX_PLUGIN_SERVICE_LENGTH}자 이하여야 합니다.` };
  }
  if (hasUnsafeDisplayChar(raw.service)) {
    return { error: `sources[${idx}].service 에 제어/서식 문자가 포함될 수 없습니다.` };
  }
  // account 는 선택. 명시되면 typeof string + non-empty + NUL 차단 (방어선).
  // 화이트리스트는 두지 않음 — 사용자가 email/UUID/임의 식별자를 자유롭게 사용 가능.
  let account: string | undefined;
  if (raw.account !== undefined) {
    if (typeof raw.account !== 'string' || raw.account.length === 0) {
      return { error: `sources[${idx}].account 는 비어있지 않은 문자열이어야 합니다.` };
    }
    if (hasUnsafeDisplayChar(raw.account)) {
      return { error: `sources[${idx}].account 에 제어/서식 문자가 포함될 수 없습니다.` };
    }
    account = raw.account;
  }
  if (raw.type === 'keychain') {
    const src: KeychainSource = account !== undefined
      ? { type: 'keychain', service: raw.service, account, saveAs: safeSaveAs }
      : { type: 'keychain', service: raw.service, saveAs: safeSaveAs };
    return { source: src };
  }
  // os-keyring 분기: keychain 과 동형이나 backend 필드 추가.
  // backend 가 명시된 경우 'auto'/'secret-service' 만 허용 — 아직 미지원인 백엔드
  // 식별자 (예: 'kwallet') 가 silent 통과하지 않도록 명시적 거부.
  let backend: 'auto' | 'secret-service' | undefined;
  if (raw.backend !== undefined) {
    if (raw.backend !== 'auto' && raw.backend !== 'secret-service') {
      return { error: `sources[${idx}].backend 는 'auto' 또는 'secret-service' 여야 합니다.` };
    }
    backend = raw.backend;
  }
  // 선택 필드는 명시됐을 때만 부여 — undefined 키를 객체에 넣지 않는다.
  const src: OsKeyringSource = { type: 'os-keyring', service: raw.service, saveAs: safeSaveAs };
  if (account !== undefined) src.account = account;
  if (backend !== undefined) src.backend = backend;
  return { source: src };
}

export interface ValidateCliDefResult {
  def?: CliDef;
  error?: string;
}

/**
 * raw JSON 객체를 CliDef 로 검증/정규화. 실패 사유는 error 메시지.
 * 외부 호출자도 사용할 수 있도록 export (예: 향후 `mat add-cli` 같은 명령).
 */
export function validateCliDefRaw(raw: unknown): ValidateCliDefResult {
  if (!isPlainObject(raw)) return { error: '최상위는 JSON 객체여야 합니다.' };
  if (typeof raw.id !== 'string') return { error: 'id 는 문자열이어야 합니다.' };
  let safeId: string;
  try {
    safeId = validateCliId(raw.id);
  } catch (err) {
    return { error: `id: ${(err as Error).message}` };
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    return { error: 'name 은 비어있지 않은 문자열이어야 합니다.' };
  }
  if (raw.name.trim() !== raw.name) {
    return { error: 'name 은 앞뒤 공백 없이 입력해야 합니다.' };
  }
  if (raw.name.length > MAX_PLUGIN_NAME_LENGTH) {
    return { error: `name 은 ${MAX_PLUGIN_NAME_LENGTH}자 이하여야 합니다.` };
  }
  if (hasUnsafeDisplayChar(raw.name)) {
    return { error: 'name 에 제어/서식 문자가 포함될 수 없습니다.' };
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    return { error: 'sources 는 비어있지 않은 배열이어야 합니다.' };
  }
  const sources: Source[] = [];
  for (let i = 0; i < raw.sources.length; i++) {
    const r = parseSource(raw.sources[i], i);
    if (r.error) return { error: r.error };
    sources.push(r.source!);
  }
  return { def: { id: safeId, name: raw.name, sources } };
}

export type PluginDiagnosticSeverity = 'error' | 'warning';

export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  pluginId?: string;
  sourceIndex?: number;
}

export interface PluginSummary {
  id: string;
  name: string;
  sourceCount: number;
}

export interface PluginValidationResult {
  def?: CliDef;
  diagnostics: PluginDiagnostic[];
}

export interface PluginValidationContext {
  file?: string;
  builtinIds?: Iterable<string>;
}

export interface PluginValidationFileReport {
  file: string;
  valid: boolean;
  plugin?: PluginSummary;
  diagnostics: PluginDiagnostic[];
}

export interface PluginValidationSummary {
  files: number;
  plugins: number;
  errors: number;
  warnings: number;
}

export interface PluginValidationReport {
  schemaVersion: 1;
  target: {
    kind: 'file' | 'directory';
    path: string;
  };
  valid: boolean;
  summary: PluginValidationSummary;
  diagnostics: PluginDiagnostic[];
  files: PluginValidationFileReport[];
}

export interface PluginValidationBatchOptions {
  builtinIds?: Iterable<string>;
}

function diagnostic(input: {
  severity: PluginDiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  pluginId?: string;
  sourceIndex?: number;
}): PluginDiagnostic {
  const out: PluginDiagnostic = {
    severity: input.severity,
    code: input.code,
    message: formatPluginWarning(input.message)
  };
  if (input.file !== undefined) out.file = formatPluginWarning(input.file);
  if (input.pluginId !== undefined) out.pluginId = formatPluginWarning(input.pluginId);
  if (input.sourceIndex !== undefined) out.sourceIndex = input.sourceIndex;
  return out;
}

function pluginSummary(def: CliDef): PluginSummary {
  return { id: def.id, name: def.name, sourceCount: def.sources.length };
}

const GENERIC_CREDENTIAL_SERVICES = new Set([
  'account',
  'accounts',
  'api-key',
  'apikey',
  'auth',
  'credential',
  'credentials',
  'default',
  'goose',
  'keychain',
  'login',
  'oauth',
  'secret',
  'secrets',
  'token',
  'tokens'
]);

const TRUST_BOUNDARY_FIELDS = ['session', 'sessionRun', 'env', 'ambient'] as const;

function lintPluginDefinition(raw: unknown, def: CliDef, context: PluginValidationContext): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const builtinIds = new Set(context.builtinIds ?? []);
  if (builtinIds.has(def.id)) {
    diagnostics.push(diagnostic({
      severity: 'error',
      code: 'builtin_id_collision',
      message: `plugin id '${def.id}' 는 builtin CLI 와 충돌하여 로드 시 무시됩니다.`,
      file: context.file,
      pluginId: def.id
    }));
  }

  if (isPlainObject(raw)) {
    for (const field of TRUST_BOUNDARY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, field)) {
        diagnostics.push(diagnostic({
          severity: 'warning',
          code: 'ignored_trust_boundary_field',
          message: `plugin 필드 '${field}' 는 무시됩니다. plugins cannot define session isolation, env policy, or ambient override controls.`,
          file: context.file,
          pluginId: def.id
        }));
      }
    }
  }

  for (let i = 0; i < def.sources.length; i++) {
    const source = def.sources[i];
    if (source.type === 'file') {
      const warning = filePathWarning(source.path);
      if (warning != null) {
        diagnostics.push(diagnostic({
          severity: 'warning',
          code: warning.code,
          message: warning.message,
          file: context.file,
          pluginId: def.id,
          sourceIndex: i
        }));
      }
      continue;
    }
    if (source.type === 'env-secret') {
      continue;
    }
    if (source.account == null && isGenericCredentialService(source.service)) {
      diagnostics.push(diagnostic({
        severity: 'warning',
        code: 'generic_service_without_account',
        message: `sources[${i}].service '${source.service}' 는 generic/multi-account credential service 처럼 보입니다. wrong-account swap 방지를 위해 account 를 명시하세요.`,
        file: context.file,
        pluginId: def.id,
        sourceIndex: i
      }));
    }
  }

  return diagnostics;
}

function isGenericCredentialService(service: string): boolean {
  const normalized = service.trim().toLowerCase();
  return GENERIC_CREDENTIAL_SERVICES.has(normalized);
}

function filePathWarning(path: string): { code: string; message: string } | undefined {
  const trimmed = path.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/u, '');
  const lower = withoutTrailingSlash.toLowerCase();
  if (
    trimmed === '~' ||
    trimmed === '~/' ||
    lower === '$home' ||
    lower === '${home}' ||
    withoutTrailingSlash === '/' ||
    lower === '/tmp' ||
    lower === '/var/tmp'
  ) {
    return {
      code: 'broad_file_path',
      message: `sources[].path '${path}' 는 credential file 로 보기에는 너무 넓은 경로입니다. 구체적인 파일 경로를 지정하세요.`
    };
  }
  const base = basename(withoutTrailingSlash);
  if (base.length === 0 || base === '.' || base === '..' || !base.includes('.')) {
    return {
      code: 'suspicious_file_path',
      message: `sources[].path '${path}' 는 파일명/확장자가 없는 디렉토리형 경로처럼 보입니다. credential 파일을 가리키는지 확인하세요.`
    };
  }
  return undefined;
}

/**
 * Static plugin validator/linter used by `mat plugin validate`.
 *
 * This does not read credential files or keyring entries. It only validates the
 * plugin JSON shape and emits compatibility-preserving lint warnings for risky
 * patterns.
 */
export function validatePluginDefinition(
  raw: unknown,
  context: PluginValidationContext = {}
): PluginValidationResult {
  const { def, error } = validateCliDefRaw(raw);
  if (error || !def) {
    return {
      diagnostics: [diagnostic({
        severity: 'error',
        code: 'schema_invalid',
        message: error ?? 'unknown validation error',
        file: context.file
      })]
    };
  }
  return {
    def,
    diagnostics: lintPluginDefinition(raw, def, context)
  };
}

function validatePluginFile(path: string, options: PluginValidationBatchOptions): PluginValidationFileReport {
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    const diagnostics = [diagnostic({
      severity: 'error',
      code: 'file_read_error',
      message: `plugin 파일 읽기 실패 — ${(err as Error).message}`,
      file: path
    })];
    return { file: formatPluginWarning(path), valid: false, diagnostics };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    const diagnostics = [diagnostic({
      severity: 'error',
      code: 'json_parse_error',
      message: `JSON 파싱 실패 — ${(err as Error).message}`,
      file: path
    })];
    return { file: formatPluginWarning(path), valid: false, diagnostics };
  }

  const result = validatePluginDefinition(raw, { file: path, builtinIds: options.builtinIds });
  const hasError = result.diagnostics.some((d) => d.severity === 'error');
  const report: PluginValidationFileReport = {
    file: formatPluginWarning(path),
    valid: !hasError,
    diagnostics: result.diagnostics
  };
  if (result.def != null) report.plugin = pluginSummary(result.def);
  return report;
}

function summarizePluginValidation(
  target: PluginValidationReport['target'],
  files: PluginValidationFileReport[],
  diagnostics: PluginDiagnostic[] = []
): PluginValidationReport {
  const allDiagnostics = [...diagnostics, ...files.flatMap((file) => file.diagnostics)];
  const errors = allDiagnostics.filter((d) => d.severity === 'error').length;
  const warnings = allDiagnostics.filter((d) => d.severity === 'warning').length;
  return {
    schemaVersion: 1,
    target,
    valid: errors === 0,
    summary: {
      files: files.length,
      plugins: files.filter((file) => file.plugin != null).length,
      errors,
      warnings
    },
    diagnostics: allDiagnostics,
    files
  };
}

export function validatePluginFilePath(
  path: string,
  options: PluginValidationBatchOptions = {}
): PluginValidationReport {
  const file = validatePluginFile(path, options);
  return summarizePluginValidation({ kind: 'file', path: formatPluginWarning(path) }, [file]);
}

export function validatePluginDirectory(
  dir: string = cliDefsDir(),
  options: PluginValidationBatchOptions = {}
): PluginValidationReport {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return summarizePluginValidation({ kind: 'directory', path: formatPluginWarning(dir) }, []);
    }
    const diagnostics = [diagnostic({
      severity: 'error',
      code: 'directory_read_error',
      message: `cli-defs 디렉토리 읽기 실패 — ${(err as Error).message}`,
      file: dir
    })];
    return summarizePluginValidation({ kind: 'directory', path: formatPluginWarning(dir) }, [], diagnostics);
  }

  const files = entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => validatePluginFile(join(dir, name), options));
  const seen = new Set<string>();
  for (const file of files) {
    const pluginId = file.plugin?.id;
    if (pluginId == null) continue;
    if (seen.has(pluginId)) {
      file.diagnostics.push(diagnostic({
        severity: 'error',
        code: 'duplicate_plugin_id',
        message: `plugin id '${pluginId}' 가 다른 plugin 과 충돌하여 후속 항목은 로드 시 무시됩니다.`,
        file: file.file,
        pluginId
      }));
      file.valid = false;
      continue;
    }
    seen.add(pluginId);
  }
  return summarizePluginValidation({ kind: 'directory', path: formatPluginWarning(dir) }, files);
}

export interface PluginScaffold {
  id: string;
  name: string;
  sources: Array<{ type: 'file'; path: string; saveAs: string }>;
}

export function createPluginScaffold(id: string): PluginScaffold {
  const safeId = validateCliId(id);
  return {
    id: safeId,
    name: defaultPluginName(safeId),
    sources: [
      { type: 'file', path: `~/.config/${safeId}/credentials.json`, saveAs: 'credentials.json' }
    ]
  };
}

function defaultPluginName(id: string): string {
  return id
    .split(/[-_]+/u)
    .filter((part) => part.length > 0)
    .map((part) => (part.toLowerCase() === 'cli' ? 'CLI' : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join(' ');
}

/**
 * `~/.multi-account-tool/cli-defs/*.json` 을 읽어 검증 통과한 CLI 정의 목록 반환.
 * 디렉토리 없으면 빈 결과 (조용히 — 사용자가 plugin 미사용).
 * 각 파일의 파싱/검증 실패는 warning 으로 누적, 나머지 파일은 계속 처리.
 */
export function loadUserCliDefs(): LoadUserCliDefsResult {
  const dir = cliDefsDir();
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { defs: [], warnings: [] };
    return { defs: [], warnings: [formatPluginWarning(`cli-defs 디렉토리 읽기 실패: ${(err as Error).message}`)] };
  }
  const defs: CliDef[] = [];
  const seenIds = new Set<string>();
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const displayName = formatPluginWarning(name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      warnings.push(formatPluginWarning(`${displayName}: JSON 파싱 실패 — ${(err as Error).message}`));
      continue;
    }
    const { def, error } = validateCliDefRaw(raw);
    if (error || !def) {
      warnings.push(formatPluginWarning(`${displayName}: ${error ?? 'unknown validation error'}`));
      continue;
    }
    if (seenIds.has(def.id)) {
      warnings.push(formatPluginWarning(`${displayName}: id '${def.id}' 가 다른 plugin 과 충돌 — skip`));
      continue;
    }
    seenIds.add(def.id);
    defs.push(def);
  }
  return { defs, warnings };
}
