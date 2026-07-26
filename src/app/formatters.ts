/**
 * UI 표시용 텍스트 빌더 (PR-O: app.tsx 모듈 분리).
 *
 * 모든 함수는 순수 — React/dispatch/dataDir 의존 없음. message 화면이나 confirm
 * dialog 의 body 로 직접 사용된다. 한국어 문구는 app.tsx 와 일관.
 */

import type { SwitchResult } from '../core/switcher.js';
import type { CliDef } from '../core/types.js';

/** firstImport 화면의 body — 감지된 CLI 목록 + 안내. */
export function formatFirstImportBody(targets: CliDef[]): string {
  return (
    `다음 CLI 에 이미 로그인된 자격증명이 감지되었습니다:\n` +
    targets.map((c) => `  - ${c.name}`).join('\n') +
    `\n\n각 CLI 마다 'default' 프로필로 가져올까요?\n` +
    `라이브 자격증명은 그대로 유지되며 백업만 생성됩니다.\n` +
    `(이 프롬프트는 어떤 답을 선택하든 다음 실행부터 자동으로 뜨지 않습니다.)`
  );
}

/** switch confirm dialog 의 body — 활성 → to 전환 + 백업 안내. */
export function formatSwitchConfirmBody(currentActive: string | undefined, to: string): string {
  const header = `${currentActive ?? '(없음)'}  →  ${to}\n\n`;
  if (!currentActive) {
    return (
      header +
      `현재 활성 프로필이 없어 별도 백업 없이 '${to}' 프로필을 복원합니다.\n` +
      `(주의: 현재 라이브 자격증명은 덮어써집니다)`
    );
  }
  return (
    header +
    `현재 라이브 자격증명은 '${currentActive}' 프로필로 자동 백업된 뒤,\n` +
    `'${to}' 프로필의 자격증명이 복원됩니다.`
  );
}

/** switch 결과 message — 백업/복원 카운트 + 빈 파일 / 누락 파일 안내. */
export function formatSwitchResult(r: SwitchResult, to: string): string {
  const lines: string[] = [];
  if (r.fromSnapshot) {
    lines.push(`백업 → ${r.fromSnapshot.profileName} : ${r.fromSnapshot.captured.length}개 파일`);
    if (r.fromSnapshot.empty.length) {
      lines.push(`  (비어있어 캡처 안 됨: ${r.fromSnapshot.empty.join(', ')})`);
    }
  }
  lines.push(`복원 → ${to} : ${r.restore.restored.length}개 파일`);
  if (r.restore.missing.length) {
    lines.push(`  (프로필에 없어 건너뜀: ${r.restore.missing.join(', ')})`);
  }
  // 위 중립 안내와 **반드시 구별되는 별도 경고 라인**. "건너뜀" 은 그냥 없다는 뜻으로 읽히지만
  // 이쪽은 직전 계정의 자격증명이 여전히 활성이라는 뜻이라 의미가 전혀 다르다.
  if (r.restore.carriedOver.length) {
    lines.push(`  ⚠ 이전 계정 자격증명이 라이브에 그대로 남아 있습니다: ${r.restore.carriedOver.join(', ')}`);
    lines.push(`    → 이 프로필을 다시 캡처(재스냅샷)해야 해당 아티팩트가 프로필에 포함됩니다.`);
  }
  return lines.join('\n');
}

/** capture confirm body — 덮어쓰기 대상 안내 + 활성 프로필 mismatch 경고. */
export function formatCaptureWarning(name: string, active: string | undefined): string {
  if (name === active) {
    return (
      `'${name}' 프로필의 저장된 자격증명을 현재 라이브 값으로 덮어씁니다.\n` +
      `방금 새 계정으로 로그인을 마쳤다면 이 동작을 사용하세요.`
    );
  }
  return (
    `'${name}' 프로필의 저장된 자격증명을 현재 라이브 값으로 덮어씁니다.\n\n` +
    `⚠ 주의: 현재 활성 프로필은 '${active ?? '없음'}' 입니다.\n` +
    `라이브 자격증명은 활성 프로필의 것이므로, 캡처 시 '${name}' 프로필이\n` +
    `활성 프로필의 자격증명으로 덮어써집니다 (의도한 동작이 맞는지 확인하세요).`
  );
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
  if (s.failures.length === 0) return '가져오기 완료';
  if (s.successes.length === 0) return '가져오기 실패';
  return '가져오기 부분 완료';
}

export function formatFirstImportSummary(s: FirstImportSummary): string {
  const lines: string[] = [];
  for (const ok of s.successes) {
    lines.push(`✓ ${ok.cliId}: ${ok.captured.length}개 파일 캡처 (${ok.captured.join(', ')})`);
  }
  for (const fail of s.failures) {
    lines.push(`✗ ${fail.cliId}: ${fail.err}`);
  }
  return lines.join('\n');
}
