/**
 * UI 입력 검증 (PR-O: app.tsx 모듈 분리).
 *
 * 사용자가 새 프로필 이름 / 이름 변경 시 즉시 피드백을 받기 위한 헬퍼.
 * core/validators 의 `validateProfileName` 을 호출하되, 추가로 "이미 존재하는
 * 이름" / "같은 이름" 케이스를 분기해 사용자 친화 메시지를 반환한다.
 *
 * 반환: null = 유효, string = 에러 메시지 (UI 에 즉시 표시).
 */

import { validateProfileName } from '../core/profile-store.js';

/** 새 프로필 추가 시 입력 검증. existing 은 같은 CLI 의 현재 프로필 set. */
export function validateNewName(v: string, existing: Set<string>): string | null {
  if (!v) return '이름을 입력하세요.';
  try {
    const normalized = validateProfileName(v);
    if (existing.has(normalized)) return '같은 이름의 프로필이 이미 존재합니다.';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '잘못된 이름입니다.';
  }
}

/**
 * 프로필 이름 변경 시 입력 검증. existing 은 같은 CLI 의 기존 프로필 set
 * (자기 자신 포함). oldName 은 변경 전 이름.
 */
export function validateRenameTo(v: string, oldName: string, existing: Set<string>): string | null {
  if (!v) return '이름을 입력하세요.';
  try {
    const normalized = validateProfileName(v);
    if (normalized === oldName) return '같은 이름입니다.';
    if (existing.has(normalized)) return '같은 이름의 프로필이 이미 존재합니다.';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '잘못된 이름입니다.';
  }
}
