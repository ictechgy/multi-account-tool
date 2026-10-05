/**
 * UI 표시용 텍스트 빌더 (PR-O: app.tsx 모듈 분리).
 *
 * 모든 함수는 순수 — React/dispatch/dataDir 의존 없음. message 화면이나 confirm
 * dialog 의 body 로 직접 사용된다. 문구는 i18n 카탈로그 (`msg().formatters`) 에서 가져온다.
 */

import type { SwitchResult } from '../core/switcher.js';
import type { CliDef } from '../core/types.js';
import { msg } from '../i18n/index.js';

/** firstImport 화면의 body — 감지된 CLI 목록 + 안내. */
export function formatFirstImportBody(targets: CliDef[]): string {
  const m = msg().formatters.firstImport;
  return m.intro + targets.map((c) => `  - ${c.name}`).join('\n') + m.outro;
}

/** switch confirm dialog 의 body — 활성 → to 전환 + 백업 안내. */
export function formatSwitchConfirmBody(currentActive: string | undefined, to: string): string {
  const m = msg().formatters.switchConfirm;
  const header = `${currentActive ?? m.none}  →  ${to}\n\n`;
  if (!currentActive) {
    return header + m.noActive(to);
  }
  return header + m.withBackup(currentActive, to);
}

/** switch 결과 message — 백업/복원 카운트 + 빈 파일 / 누락 파일 안내. */
export function formatSwitchResult(r: SwitchResult, to: string): string {
  const m = msg().formatters.switchResult;
  const lines: string[] = [];
  if (r.fromSnapshot) {
    lines.push(m.backup(r.fromSnapshot.profileName, r.fromSnapshot.captured.length));
    if (r.fromSnapshot.empty.length) {
      lines.push(m.emptyNotCaptured(r.fromSnapshot.empty.join(', ')));
    }
  }
  if (!r.restore.carryOverEvaluated) {
    // 이 경로는 restore 를 실행하지 않았다. `복원 → X : 0개 파일` 은 "복원을 시도했는데 0개" 로
    // 읽혀 오도적이므로 **대체**한다. 그리고 carriedOver 가 비어 있는 것이 "이월 없음" 을
    // 뜻하지 않는다는 사실을 사용자에게 명시한다.
    lines.push(m.notEvaluatedAlreadyActive(to));
    lines.push(m.notEvaluatedCarryOver);
    return lines.join('\n');
  }
  if (r.restore.cleared.length) {
    // 로그아웃 상태로 시작하는 프로필. "건너뜀" 안내는 오도적이므로 대체한다.
    lines.push(m.clearedSwitched(to, r.restore.cleared.join(', ')));
    lines.push(m.clearedLogin);
    lines.push(m.clearedAutoSave(to));
    return lines.join('\n');
  }
  lines.push(m.restore(to, r.restore.restored.length));
  if (r.restore.missing.length) {
    lines.push(m.missingSkipped(r.restore.missing.join(', ')));
  }
  // 위 중립 안내와 **반드시 구별되는 별도 경고 라인**. "건너뜀" 은 그냥 없다는 뜻으로 읽히지만
  // 이쪽은 직전 계정의 자격증명이 여전히 활성이라는 뜻이라 의미가 전혀 다르다.
  if (r.restore.carriedOver.length) {
    lines.push(m.carryOverWarning(r.restore.carriedOver.join(', ')));
    // 여기서 "이 프로필을 재캡처하라" 고 안내하면 **안 된다** — 라이브 아티팩트는 직전 계정 것이라
    // 지금 ${to} 를 재캡처하면 다른 계정의 자격증명을 ${to} 프로필에 저장하게 된다.
    lines.push(m.carryOverDoNotRecapture(to));
    // "라이브가 다른 프로필 것이면 그 프로필을 재캡처하라" 는 안내는 하지 않는다 — 부분 전환
    // 이후 라이브가 섞여 있을 수 있고, 사용자는 라이브 값이 어느 계정 것인지 알 수 없다.
    // 그 상태로 다른 프로필을 재캡처하면 계정 교차 저장이 된다. 먼저 확인하도록 유도한다.
    lines.push(m.carryOverAfterRelogin(to));
    lines.push(m.carryOverCheckFirst);
  }
  return lines.join('\n');
}

/** capture confirm body — 덮어쓰기 대상 안내 + 활성 프로필 mismatch 경고. */
export function formatCaptureWarning(name: string, active: string | undefined): string {
  const m = msg().formatters.captureWarning;
  if (name === active) {
    return `${m.overwrite(name)}\n${m.sameActiveHint}`;
  }
  return `${m.overwrite(name)}\n\n${m.mismatch(name, active)}`;
}

/** firstImport 완료 후 사용자에게 보여줄 요약 (성공/실패 행). */
export interface FirstImportSummary {
  successes: { cliId: string; captured: string[] }[];
  failures: { cliId: string; err: string }[];
}

/** firstImport 결과 tone — 모두 성공/일부/전체 실패 분기. */
export type FirstImportTone = 'success' | 'warning' | 'error';

export function importTone(s: FirstImportSummary): FirstImportTone {
  if (s.failures.length === 0) return 'success';
  if (s.successes.length === 0) return 'error';
  return 'warning';
}

export function importTitle(s: FirstImportSummary): string {
  const m = msg().formatters.firstImport;
  if (s.failures.length === 0) return m.titleSuccess;
  if (s.successes.length === 0) return m.titleError;
  return m.titlePartial;
}

export function formatFirstImportSummary(s: FirstImportSummary): string {
  const lines: string[] = [];
  for (const ok of s.successes) {
    lines.push(msg().formatters.firstImport.successLine(ok.cliId, ok.captured));
  }
  for (const fail of s.failures) {
    lines.push(`✗ ${fail.cliId}: ${fail.err}`);
  }
  return lines.join('\n');
}
