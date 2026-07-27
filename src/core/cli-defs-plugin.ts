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
import { basename, isAbsolute, join } from 'node:path';
import { hasUnsafeDisplayChar } from './display-safety.js';
import { validatePublicEnvSecretSource } from './env-secret-source.js';
import { buildLiveResourceIndex, findLiveResourceCollision } from './builtin-live-resources.js';
import type { LiveResourceKey, LiveResourceOwner } from './builtin-live-resources.js';
import { classifyGoosePathByIdentity } from './goose-provider-cache.js';
import { dataDir, isNormalizedPathSpelling, validateCliId, validateProfileFileName } from './paths.js';
import { redactSecretLikeText } from './redaction.js';
import { validateWindowsCredentialBinding } from './windows-credential-manager.js';
import { assertValidSourceList } from './validators.js';
import type { CliDef, FileSource, KeychainSource, OsKeyringSource, Source, WindowsCredentialSource } from './types.js';

/** plugin 파일이 모이는 디렉토리: `~/.multi-account-tool/cli-defs/`. */
const CLI_DEFS_DIR_NAME = 'cli-defs';
const MAX_PLUGIN_NAME_LENGTH = 80;
const MAX_PLUGIN_SERVICE_LENGTH = 128;
const WINDOWS_CREDENTIAL_SOURCE_KEYS = new Set([
  'type',
  'targetName',
  'credentialType',
  'account',
  'persist',
  'saveAs'
]);

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
  /**
   * def id → 그 def 가 온 plugin 파일의 표시용 이름.
   *
   * 병합 지점(`getAllCliDefs`)에서 def 를 거부할 때 **어느 파일을 고쳐야 하는지** 알려주려면
   * provenance 가 필요하다. `defs` 배열 형태를 바꾸지 않으려고 별도 맵으로 둔다.
   */
  provenance: Map<string, string>;
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
  if (
    raw.type !== 'file' &&
    raw.type !== 'keychain' &&
    raw.type !== 'os-keyring' &&
    raw.type !== 'env-secret' &&
    raw.type !== 'win-credential'
  ) {
    return { error: `sources[${idx}].type 는 'file', 'keychain', 'os-keyring', 'env-secret' 또는 'win-credential' 이어야 합니다. directory 는 builtin 전용입니다.` };
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
  if (raw.type === 'win-credential') {
    return parseWindowsCredentialSource(raw, idx, safeSaveAs);
  }
  if (raw.type === 'file') {
    if (typeof raw.path !== 'string' || raw.path.length === 0) {
      return { error: `sources[${idx}].path 는 비어있지 않은 문자열이어야 합니다.` };
    }
    if (hasUnsafeDisplayChar(raw.path)) {
      return { error: `sources[${idx}].path 에 제어/서식 문자가 포함될 수 없습니다.` };
    }
    // 상대경로는 mat 을 **어느 디렉토리에서 실행했는지**에 따라 다른 파일을 가리키므로
    // 안정적인 자격증명 위치가 될 수 없다. 0.8.0 까지는 통과했으나 의미 있게 동작한 적이 없다.
    // `~` 단독은 expandTilde 가 home 으로 확장하는 정당한 표기다 — 지나치게 넓은 경로라는
    // 문제는 기존 `broad_file_path` **경고**가 담당하므로 여기서 에러로 승격시키지 않는다.
    if (raw.path !== '~' && !raw.path.startsWith('~/') && !isAbsolute(raw.path)) {
      return { error: `sources[${idx}].path 는 '~/' 로 시작하거나 절대경로여야 합니다. 상대경로는 실행 디렉토리에 따라 다른 파일을 가리킵니다.` };
    }
    // 비정규 표기(`..`/`.`/중복 슬래시)는 안전성 판정과 실제 I/O 대상을 어긋나게 만든다 —
    // 자세한 근거는 isNormalizedPathSpelling 의 JSDoc 참고.
    if (!isNormalizedPathSpelling(raw.path)) {
      return { error: `sources[${idx}].path 는 정규화된 경로여야 합니다 ('.', '..', 중복 슬래시 없이). 예: '~/.config/app/auth.json'` };
    }
    // builtin 이 소유한 Goose 자격증명 구역에는 라이브 provider OAuth 토큰이 있다. 인정된 고정
    // 경로가 아닌 구역 내부 경로를 조용히 일반 쓰기 경로로 흘려보내면, 하드닝(부모 identity
    // pinning·nlink·no-follow)을 우회한 무검증 쓰기를 허용하게 되므로 로드 시점에 거부한다.
    // identity 판정을 쓴다 — 어휘 판정은 별칭 표기와 해석된 정경 표기 양쪽으로 뚫린다
    // (`classifyGoosePathByIdentity` JSDoc 의 실측 두 경로 참고).
    if (classifyGoosePathByIdentity(raw.path) === 'reserved-nonadmitted') {
      return { error: `sources[${idx}].path 가 mat builtin 이 관리하는 Goose 자격증명 구역(~/.config/goose) 안에 있지만 인정된 고정 경로가 아닙니다. builtin goose 지원을 쓰거나 구역 밖 경로를 지정하세요.` };
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

function parseWindowsCredentialSource(
  raw: Record<string, unknown>,
  idx: number,
  safeSaveAs: string
): SourceParseResult {
  for (const key of Object.keys(raw)) {
    if (!WINDOWS_CREDENTIAL_SOURCE_KEYS.has(key)) {
      return { error: `sources[${idx}].type 'win-credential' schema forbids unknown fields.` };
    }
  }
  if (typeof raw.targetName !== 'string' || raw.targetName.length === 0) {
    return { error: `sources[${idx}].targetName 는 비어있지 않은 문자열이어야 합니다.` };
  }
  if (raw.credentialType !== 'generic') {
    return { error: `sources[${idx}].credentialType 은 'generic' 이어야 합니다.` };
  }
  if (typeof raw.account !== 'string' || raw.account.length === 0) {
    return { error: `sources[${idx}].account 는 비어있지 않은 문자열이어야 합니다.` };
  }
  if (raw.persist !== 'session' && raw.persist !== 'local-machine' && raw.persist !== 'enterprise') {
    return { error: `sources[${idx}].persist 는 'session', 'local-machine' 또는 'enterprise' 이어야 합니다.` };
  }
  const src: WindowsCredentialSource = {
    type: 'win-credential',
    targetName: raw.targetName,
    credentialType: 'generic',
    account: raw.account,
    persist: raw.persist,
    saveAs: safeSaveAs
  };
  try {
    validateWindowsCredentialBinding(src);
  } catch (err) {
    return { error: `sources[${idx}].type 'win-credential' schema is invalid: ${(err as Error).message}` };
  }
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
  try { assertValidSourceList(sources); } catch (err) { return { error: (err as Error).message }; }
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
  /**
   * 파싱된 def — 디렉토리 post-pass 의 소유권 충돌 판정에만 쓴다.
   * `--json` 출력에는 싣지 않는다(그 계약은 `plugin` 요약이 담당).
   */
  parsed?: CliDef;
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
  /**
   * builtin def 목록. 주면 소유권 충돌(builtin 라이브 자격증명 스쿼팅)을 로드 전에 진단한다.
   * 기존 `builtinIds` 와 같은 선례를 따르는 옵셔널 컨텍스트 — 미제공 시 기존 동작 유지.
   */
  builtinDefs?: readonly CliDef[];
  /** 플랫폼/env 분기로 builtinDefs 에 나타나지 않는 예약 리소스 (cli-defs.reservedLiveResources). */
  reservedLiveResources?: readonly (LiveResourceOwner & LiveResourceKey)[];
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
    if (source.type === 'win-credential') {
      continue;
    }
    // DirectorySource is internal-only and cannot be produced by parseSource;
    // retain an exhaustive guard if a future internal caller passes one here.
    if (source.type === 'directory') continue;
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
  if (result.def != null) { report.plugin = pluginSummary(result.def); report.parsed = result.def; }
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
    // `parsed` 는 post-pass 전용 내부 필드다 — `--json` 스키마(schemaVersion 1)에 새지 않게 제거한다.
    files: files.map(({ parsed: _parsed, ...rest }) => rest)
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
  // 소유권 충돌은 **id 중복 post-pass 와 같은 자리**에서 판정한다. load-time 은 dup-id def 를
  // 먼저 버리므로(loadUserCliDefs), 여기서도 이미 invalid 로 표시된 파일은 건너뛰어야
  // validate 의 거부 집합과 load 의 skip 집합이 일치한다. 갈라지면 validate 가 실제로는
  // 존재하지 않는 충돌을 보고하게 된다.
  if (options?.builtinDefs) {
    const index = buildLiveResourceIndex(options.builtinDefs, options.reservedLiveResources ?? []);
    for (const file of files) {
      if (!file.valid || !file.parsed) continue;
      const collision = findLiveResourceCollision(file.parsed, index);
      if (collision) {
        file.diagnostics.push(diagnostic({
          severity: 'error',
          code: 'builtin_live_resource_collision',
          message: `sources[${collision.sourceIndex}] 가 builtin '${collision.ownerCliId}' 소유의 라이브 자격증명(${collision.kind}: ${collision.declared})을 주장합니다 — 로드 시 이 plugin 전체가 무시됩니다. 저장된 프로필은 삭제되지 않습니다.`,
          file: file.file,
          pluginId: file.parsed.id
        }));
        file.valid = false;
        continue;
      }
      index.add(file.parsed);
    }
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { defs: [], warnings: [], provenance: new Map() };
    return { defs: [], warnings: [formatPluginWarning(`cli-defs 디렉토리 읽기 실패: ${(err as Error).message}`)], provenance: new Map() };
  }
  const defs: CliDef[] = [];
  const provenance = new Map<string, string>();
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
    provenance.set(def.id, displayName);
  }
  return { defs, warnings, provenance };
}
