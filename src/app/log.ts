/**
 * TUI 의 best-effort 경고 / 로그 한 줄을 app.log 에 append (PR-R + PR-O 분리).
 *
 * 호출자: persistFirstFreshnessPromptIfNeeded 등 user-flow 차단 금지인 정보성
 * 경고. stderr 대신 본 파일에 ISO 시각 + 메시지 한 줄 → Ink alternate-buffer
 * 와 충돌 회피 (PR-G Claude-1 LOW finding). 디버그 audit trail.
 *
 * 본 함수 자체가 실패하면 stderr 로 최후 surface (이중 실패는 영구 디스크 문제
 * 추정, 단 한 줄로 짧게 — Ink 충돌 가능성 대비).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { errorMessage } from '../core/errors.js';
import { appLogPath } from '../core/paths.js';

export async function appendAppLogBestEffort(message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    await fs.appendFile(appLogPath(), line, { mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // dataDir 미생성 케이스 — mkdir 후 1회 재시도. node:path 의 dirname 으로
      // cross-platform 디렉토리 추출.
      try {
        const path = appLogPath();
        await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await fs.appendFile(path, line, { mode: 0o600 });
        return;
      } catch (retryErr) {
        process.stderr.write(
          `[mat] appLog 쓰기 실패 (mkdir retry): ${errorMessage(retryErr)}\n`
        );
        return;
      }
    }
    process.stderr.write(`[mat] appLog 쓰기 실패: ${errorMessage(err)}\n`);
  }
}
