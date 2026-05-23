/**
 * 라이브 자격증명 감지: 각 CLI 의 source 들이 실제로 존재하는지 점검.
 * 첫 실행 시 "기존 자격증명을 default 프로필로 가져올까요?" UX 에 사용된다.
 *
 * CLI 사이와 같은 CLI 의 source 들 모두 Promise.all 로 병렬 점검한다 (read-only).
 */

import { BUILTIN_CLI_DEFS } from './cli-defs.js';
import { sourceExists } from './sources.js';
import type { CliDef } from './types.js';

export interface DetectionResult {
  cli: CliDef;
  /** 정의된 모든 source 가 라이브 위치에 존재 (완전 자격증명). */
  hasLiveCredentials: boolean;
  /** 적어도 하나의 source 가 라이브 위치에 존재 (부분 자격증명 포함). */
  hasAnyLiveCredential: boolean;
  /** 존재가 확인된 source 의 saveAs 명. */
  present: string[];
  /** 라이브 위치에서 발견되지 않은 source 의 saveAs 명. */
  missing: string[];
}

/** 내장된 모든 CLI 에 대해 라이브 자격증명 존재 여부를 병렬 감지. */
export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(BUILTIN_CLI_DEFS.map(detect));
}

async function detect(cli: CliDef): Promise<DetectionResult> {
  const results = await Promise.all(
    cli.sources.map(async (src) => ({ saveAs: src.saveAs, exists: await sourceExists(src) }))
  );
  const present: string[] = [];
  const missing: string[] = [];
  for (const { saveAs, exists } of results) {
    (exists ? present : missing).push(saveAs);
  }
  return {
    cli,
    hasLiveCredentials: missing.length === 0 && present.length > 0,
    hasAnyLiveCredential: present.length > 0,
    present,
    missing
  };
}
