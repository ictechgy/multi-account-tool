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
import { join } from 'node:path';
import { dataDir, validateCliId, validateProfileFileName } from './paths.js';
import type { CliDef, FileSource, KeychainSource, OsKeyringSource, Source } from './types.js';

/** plugin 파일이 모이는 디렉토리: `~/.multi-account-tool/cli-defs/`. */
const CLI_DEFS_DIR_NAME = 'cli-defs';

/** 사용자 plugin 디렉토리 절대 경로. */
function cliDefsDir(): string {
  return join(dataDir(), CLI_DEFS_DIR_NAME);
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

function hasControlChar(v: string): boolean {
  return /[\x00-\x1f\x7f]/.test(v);
}

interface SourceParseResult {
  source?: Source;
  error?: string;
}

/** 단일 source 객체 검증 + 정규화. 실패 시 error 메시지 반환. */
function parseSource(raw: unknown, idx: number): SourceParseResult {
  if (!isPlainObject(raw)) return { error: `sources[${idx}] 는 객체여야 합니다.` };
  if (raw.type !== 'file' && raw.type !== 'keychain' && raw.type !== 'os-keyring') {
    return { error: `sources[${idx}].type 는 'file', 'keychain' 또는 'os-keyring' 이어야 합니다.` };
  }
  if (typeof raw.saveAs !== 'string') return { error: `sources[${idx}].saveAs 는 문자열이어야 합니다.` };
  let safeSaveAs: string;
  try {
    safeSaveAs = validateProfileFileName(raw.saveAs);
  } catch (err) {
    return { error: `sources[${idx}].saveAs: ${(err as Error).message}` };
  }
  if (raw.type === 'file') {
    if (typeof raw.path !== 'string' || raw.path.length === 0) {
      return { error: `sources[${idx}].path 는 비어있지 않은 문자열이어야 합니다.` };
    }
    const src: FileSource = { type: 'file', path: raw.path, saveAs: safeSaveAs };
    return { source: src };
  }
  if (typeof raw.service !== 'string' || raw.service.length === 0) {
    return { error: `sources[${idx}].service 는 비어있지 않은 문자열이어야 합니다.` };
  }
  if (hasControlChar(raw.service)) {
    return { error: `sources[${idx}].service 에 제어 문자가 포함될 수 없습니다.` };
  }
  // account 는 선택. 명시되면 typeof string + non-empty + NUL 차단 (방어선).
  // 화이트리스트는 두지 않음 — 사용자가 email/UUID/임의 식별자를 자유롭게 사용 가능.
  let account: string | undefined;
  if (raw.account !== undefined) {
    if (typeof raw.account !== 'string' || raw.account.length === 0) {
      return { error: `sources[${idx}].account 는 비어있지 않은 문자열이어야 합니다.` };
    }
    if (raw.account.includes('\x00')) {
      return { error: `sources[${idx}].account 에 NUL 문자가 포함될 수 없습니다.` };
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
    return { defs: [], warnings: [`cli-defs 디렉토리 읽기 실패: ${(err as Error).message}`] };
  }
  const defs: CliDef[] = [];
  const seenIds = new Set<string>();
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      warnings.push(`${name}: JSON 파싱 실패 — ${(err as Error).message}`);
      continue;
    }
    const { def, error } = validateCliDefRaw(raw);
    if (error || !def) {
      warnings.push(`${name}: ${error}`);
      continue;
    }
    if (seenIds.has(def.id)) {
      warnings.push(`${name}: id '${def.id}' 가 다른 plugin 과 충돌 — skip`);
      continue;
    }
    seenIds.add(def.id);
    defs.push(def);
  }
  return { defs, warnings };
}
