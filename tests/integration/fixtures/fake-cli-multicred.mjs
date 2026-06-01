#!/usr/bin/env node
/**
 * multi-cred 통합 테스트용 가짜 CLI (Qwen 대역) — runSession 이 spawn 하는 subshell.
 *
 * 격리된 QWEN_HOME 의 두 cred(`settings.json` + `.env`)를 read → **동일 세션 ROT 마커**
 * 를 append → rewrite 후 종료한다. 동시 2세션이 같은 프로필을 재캡처할 때, 락 직렬화가
 * 두 cred 를 한 세션의 일관 세대(같은 ROT 마커)로 유지하는지(cred 별 winner 분기 split 0)
 * 검증하기 위함 — 두 cred 에 **같은 MAT_SESSION 마커**를 찍는 것이 핵심.
 *
 * 자격증명은 env 에 실리지 않고 격리 디렉토리 파일로만 전달됨을 함께 확인한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.QWEN_HOME;
if (!home) {
  process.stderr.write('fake-cli-multicred: QWEN_HOME 미주입\n');
  process.exit(3);
}
const marker = process.env.MAT_SESSION ?? '?';
// planSession 의 directChildRel 기준 격리본 위치 — base(~/.qwen) 직속 상대경로 그대로.
for (const rel of ['settings.json', '.env']) {
  const path = join(home, rel);
  const seen = readFileSync(path, 'utf8');
  // 두 cred 모두 동일 세션 마커로 rewrite — 같은 세대임을 검증 가능하게 한다.
  writeFileSync(path, `${seen}+ROT:${marker}`);
}
process.exit(0);
