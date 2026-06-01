/**
 * 라이브 자격증명 감지: 각 CLI 의 source 들이 실제로 존재하는지 점검.
 * 첫 실행 시 "기존 자격증명을 default 프로필로 가져올까요?" UX 에 사용된다.
 *
 * CLI 사이와 같은 CLI 의 source 들 모두 Promise.all 로 병렬 점검한다 (read-only).
 *
 * **os-keyring source 의 "부재" 의미 (#59/#73)**: `sourceExists` → `osKeyringExists` 는
 * secret-tool(libsecret-tools) 이 **미설치(ENOENT)** 면 throw 하지 않고 soft-fail 로 `false`
 * 를 반환한다. 즉 detector 는 그 source 를 **"부재(missing)"로 집계**한다 — keyring 에 실제
 * 자격증명이 있어도 CLI(secret-tool)가 없으면 감지에서 빠진다. 결과적으로 첫 실행 import 는
 * 그 keyring-backed cred 를 **제외**하고(부분/무 자격증명으로 분류), wrong-account 위험은
 * `osKeyringExists` 의 강한 stderr 경고(warnSecretToolMissing)가 안내한다. ENOENT 아닌 spawn
 * 실패(EACCES 등)·daemon-down 은 osKeyringExists 가 throw 하므로 여기서 "부재"로 집계되지 않고
 * 에러로 surface 된다 (fail-closed).
 */

import { getAllCliDefs } from './cli-defs.js';
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
  /**
   * 라이브 위치에서 발견되지 않은 source 의 saveAs 명. os-keyring source 는 secret-tool
   * 미설치(ENOENT) soft-fail 시에도 여기로 분류된다 — 모듈 상단 주석 참조 (#59/#73).
   */
  missing: string[];
}

/** builtin + plugin 모든 CLI 에 대해 라이브 자격증명 존재 여부를 병렬 감지. */
export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(getAllCliDefs().map(detect));
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
