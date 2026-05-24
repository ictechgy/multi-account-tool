/**
 * v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) 데이터 디렉토리 마이그레이션.
 *
 * 패키지 rename (multi-subscription-terminal → multi-account-tool) 으로 인한 일회성 처리.
 * cli.tsx 의 render() 호출 전에 한 번 실행되며, stderr 로 결과를 안내한다.
 */

import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * 옛 (v0.1) 데이터 디렉토리 경로. 함수로 둠으로써 호출 시점의 HOME 을 반영 —
 * 테스트가 `process.env.HOME` 을 임시 디렉토리로 override 한 후 정확히 그 경로를 검증 가능.
 */
function legacyDataDir(): string {
  return join(homedir(), '.multi-sub-terminal');
}

/**
 * 옛 데이터 디렉토리가 있고 새 디렉토리가 없으면 rename.
 * 둘 다 있으면 (충돌) stderr 경고 후 no-op — 사용자가 수동으로 정리해야 한다.
 * 옛 디렉토리 자체가 없으면 (신규 사용자) no-op.
 */
export function migrateLegacyDataDir(): void {
  const legacy = legacyDataDir();
  if (!existsSync(legacy)) return;
  const current = dataDir();
  if (existsSync(current)) {
    console.error(
      `경고: 옛 데이터 디렉토리 (${legacy}) 와 새 디렉토리 (${current}) 가 둘 다 존재합니다.\n` +
      `수동으로 한쪽을 정리하거나 병합한 뒤 다시 실행하세요.`
    );
    return;
  }
  try {
    renameSync(legacy, current);
    console.error(`✓ 데이터 디렉토리 마이그레이션 완료: ${legacy} → ${current}`);
  } catch (err) {
    // console.error 를 단일 문자열로 호출 (format string injection 차단).
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`경고: 데이터 디렉토리 마이그레이션 실패 — 수동 확인 필요 (${legacy}): ${detail}`);
  }
}
