/**
 * 라이브 자격증명 감지: 각 CLI 의 source 들이 실제로 존재하는지 점검.
 * 첫 실행 시 "기존 자격증명을 default 프로필로 가져올까요?" UX 에 사용된다.
 *
 * CLI 사이와 같은 CLI 의 source 들 모두 Promise.all 로 병렬 점검한다 (read-only).
 *
 * **os-keyring source 의 "부재" 의미 (#59/#73)**: `sourceExists` → `osKeyringExists` 는
 * 항목 부재(exit 0 + 빈 출력)만 `false` 로 반환한다. secret-tool(libsecret-tools) 미설치
 * (ENOENT), 실행 불가(EACCES 등), daemon-down 은 sourceExists 에서 throw 되며 detector 는
 * 이를 `unavailable` 로 분류한다. tool/infra 결손을 missing/file-backend 신호로 오인하면
 * stale credential import/swap 위험이 있으므로 first-import 후보에서 제외한다.
 */

import { getAllCliDefs } from './cli-defs.js';
import { isEnvSecretSource } from './env-secret-source.js';
import { sourceExists } from './sources.js';
import { isWindowsCredentialRuntimeUnsupported } from './windows-credential-source.js';
import type { CliDef } from './types.js';

export interface DetectionResult {
  cli: CliDef;
  /** 정의된 모든 source 가 라이브 위치에 존재 (완전 자격증명). */
  hasLiveCredentials: boolean;
  /** 적어도 하나의 source 가 라이브 위치에 존재 (부분 자격증명 포함). */
  hasAnyLiveCredential: boolean;
  /** 존재가 확인된 source 의 saveAs 명. */
  present: string[];
  /**
   * 라이브 위치에서 발견되지 않은 source 의 saveAs 명. os-keyring source 는 항목 부재만
   * 여기로 분류되며 tool/daemon unavailable 은 `unavailable` 로 분류된다 — 모듈 상단 주석 참조 (#59/#73).
   */
  missing: string[];
  /**
   * 감지 backend 가 실패해 존재/부재를 판정하지 못한 source. ordinary missing 이 아니므로
   * first-import 후보로 쓰지 않는다.
   */
  unavailable?: Array<{ saveAs: string; message: string }>;
  /**
   * 감지는 지원하지 않지만 ordinary missing 으로 오분류하면 안 되는 source 의 saveAs 명.
   * env-secret 은 metadata-only hard-stop 상태이므로 first-import 후보에서 제외된다.
   */
  unsupported?: string[];
}

/** builtin + plugin 모든 CLI 에 대해 라이브 자격증명 존재 여부를 병렬 감지. */
export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(getAllCliDefs().map(detect));
}

async function detect(cli: CliDef): Promise<DetectionResult> {
  const unsupported = cli.sources
    .filter((src) => isEnvSecretSource(src) || isWindowsCredentialRuntimeUnsupported(src))
    .map((src) => src.saveAs);
  if (unsupported.length > 0) {
    return {
      cli,
      hasLiveCredentials: false,
      hasAnyLiveCredential: false,
      present: [],
      missing: [],
      unsupported
    };
  }
  const results = await Promise.all(
    cli.sources.map(async (src) => {
      try {
        return { saveAs: src.saveAs, exists: await sourceExists(src) };
      } catch (err) {
        return { saveAs: src.saveAs, exists: null, message: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const present: string[] = [];
  const missing: string[] = [];
  const unavailable: Array<{ saveAs: string; message: string }> = [];
  for (const { saveAs, exists, message } of results) {
    if (exists === true) present.push(saveAs);
    else if (exists === false) missing.push(saveAs);
    else unavailable.push({ saveAs, message: message ?? 'source existence check failed' });
  }
  return {
    cli,
    hasLiveCredentials: missing.length === 0 && unavailable.length === 0 && present.length > 0,
    hasAnyLiveCredential: present.length > 0,
    present,
    missing,
    ...(unavailable.length > 0 ? { unavailable } : {})
  };
}
