#!/usr/bin/env node
/**
 * 통합 테스트용 가짜 CLI — runSession 이 spawn 하는 subshell 대역.
 *
 * 격리된 CODEX_HOME(또는 첫 *_HOME env)의 auth.json 을 read → 마커 append → rewrite 후
 * 종료한다. OAuth refresh rotation 으로 CLI 가 자체 토큰을 갱신하는 상황을 모사 —
 * runSession 의 종료 재캡처가 이 갱신값을 프로필로 보존하는지 검증한다.
 *
 * 자격증명은 env 에 실리지 않고 격리 디렉토리 파일로만 전달됨을 함께 확인한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CODEX_HOME;
if (!home) {
  process.stderr.write('fake-cli: CODEX_HOME 미주입\n');
  process.exit(3);
}
const authPath = join(home, 'auth.json');
const seen = readFileSync(authPath, 'utf8');
// 격리본을 rewrite — 어느 세션이 어떤 토큰을 봤는지 마커로 기록.
writeFileSync(authPath, `${seen}+ROT:${process.env.MAT_SESSION ?? '?'}`);
process.exit(0);
