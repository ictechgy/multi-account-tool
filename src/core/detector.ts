/**
 * 라이브 자격증명 감지: 각 CLI 의 source 들이 실제로 존재하는지 점검.
 * 첫 실행 시 "기존 자격증명을 default 프로필로 가져올까요?" UX 에 사용된다.
 */

import { BUILTIN_CLI_DEFS } from './cli-defs.js';
import { sourceExists } from './sources.js';
import type { CliDef } from './types.js';

export interface DetectionResult {
  cli: CliDef;
  /** 정의된 모든 source 가 라이브 위치에 존재하는가 */
  hasLiveCredentials: boolean;
  /** 존재가 확인된 source 의 saveAs 명 */
  present: string[];
  /** 라이브 위치에서 발견되지 않은 source 의 saveAs 명 */
  missing: string[];
}

/** 내장된 모든 CLI 에 대해 라이브 자격증명 존재 여부를 감지. */
export async function detectAll(): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];
  for (const cli of BUILTIN_CLI_DEFS) {
    const present: string[] = [];
    const missing: string[] = [];
    for (const src of cli.sources) {
      const exists = await sourceExists(src);
      (exists ? present : missing).push(src.saveAs);
    }
    results.push({
      cli,
      hasLiveCredentials: missing.length === 0 && present.length > 0,
      present,
      missing
    });
  }
  return results;
}
