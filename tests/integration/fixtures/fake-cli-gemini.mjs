#!/usr/bin/env node
/**
 * gemini 세션 격리 통합 테스트용 가짜 CLI — runSession 이 spawn 하는 subshell.
 *
 * gemini 는 redirect env(`GEMINI_CLI_HOME`)가 자격증명 루트(`.gemini`)의 **부모**를 가리킨다
 * (envSubdir='.gemini', 소스 실측). 따라서 격리본은 `$GEMINI_CLI_HOME/.gemini/<rel>` 에 있다.
 *
 * 두 cred(`oauth_creds.json` + `google_accounts.json`)를 read → 세션 ROT 마커 append → rewrite
 * 후 종료한다. 종료 재캡처가 두 cred 를 프로필에 반영하는지(2-cred 원자 그룹) 검증하기 위함.
 * 자격증명은 env 가 아니라 격리 디렉토리 파일로만 전달됨을 함께 확인한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.GEMINI_CLI_HOME;
if (!home) {
  process.stderr.write('fake-cli-gemini: GEMINI_CLI_HOME 미주입\n');
  process.exit(3);
}
const marker = process.env.MAT_SESSION ?? '?';
// envSubdir='.gemini' — 격리본은 주입 dir 의 .gemini 하위 (gemini getGlobalGeminiDir 와 정렬).
const credRoot = join(home, '.gemini');
for (const rel of ['oauth_creds.json', 'google_accounts.json']) {
  const path = join(credRoot, rel);
  const seen = readFileSync(path, 'utf8');
  writeFileSync(path, `${seen}+ROT:${marker}`);
}
process.exit(0);
