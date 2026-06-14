#!/usr/bin/env node
/**
 * mat — Multi-Account Tool 의 bin 진입점.
 *
 * 두 모드:
 *  - 인자 없음 / `help` / `--help` / `-h`  → Ink TUI 렌더
 *    (도움말은 TUI 진입 전 stdout 으로 짧게 안내 후 TUI 로 진입하지 않고 종료)
 *  - `exec <cli> <profile> -- <cmd...>`     → 자식 명령에 한해 해당 profile 로 swap 실행
 *
 * 인자 검증 실패는 stderr + exit 2.
 */

import React from 'react';
import { render } from 'ink';

import App from './app.js';
import { getAllCliDefs } from './core/cli-defs.js';
import { getActiveProfile } from './core/config.js';
import { describeError, UnknownCliError } from './core/errors.js';
import { runExec } from './core/exec.js';
import { handleSession } from './core/session-cli.js';
import { formatDoctorReport, runDoctor } from './core/doctor.js';
import { buildCliSupportReport, formatSupportReport } from './core/support.js';
import { registerAllBuiltinAdapters } from './core/freshness-adapters/index.js';
import {
  inspectLiveFreshness,
  type CompareResult,
  type FreshnessReport
} from './core/freshness.js';
import { migrateLegacyDataDir } from './core/migrate.js';

const USAGE =
  `사용법:\n` +
  `  mat                                            TUI 실행\n` +
  `  mat exec <cli> <profile> -- <cmd...>          <profile> 로 swap 후 <cmd> 실행, 종료 후 원복\n` +
  `  mat session start <cli> <profile>             <profile> 로 격리된 subshell 실행 (동시 다계정)\n` +
  `  mat session run <cli> <profile> -- [args...]  builtin CLI 를 격리 env 로 직접 실행\n` +
  `  mat session list                              실행 중/orphan 세션 목록\n` +
  `  mat session stop <id>                         세션 종료 또는 orphan 정리\n` +
  `  mat freshness [<cli>] [--profile <name>] [--json] [--check-only]\n` +
  `                                                 라이브 vs 활성 프로필 자격증명 비교 (OAuth\n` +
  `                                                 refresh rotation 안전성 점검). cli 미지정 시\n` +
  `                                                 모든 builtin/plugin CLI 보고. --check-only 면\n` +
  `                                                 stale 감지해도 exit 0 (read-only 모니터링).\n` +
  `  mat doctor [--json]                           read-only 안전 진단 (자격증명 값 미열람)\n` +
  `  mat support <cli> [--json]                    CLI 지원 범위/한계/계약 설명\n` +
  `  mat explain <cli> [--json]                    support 의 alias\n` +
  `  mat --help                                     이 도움말 출력\n` +
  `  mat --version                                  버전 출력\n`;

/**
 * Exit code 규약:
 *   0  성공 (자식 0 종료 + restore 성공 / freshness 모두 fresh·rotated)
 *   1  예상치 못한 에러 또는 freshness stale 감지 (사용자 액션 필요)
 *   2  사용법/검증 실패 (UsageError, argv 파싱 실패)
 *   74 restore 실패 또는 freshness 내부 검사 실패 (자동화가 감지 가능)
 *   75 다른 mat exec 가 lock 보유 중 (LockHeldError, 재시도 가능)
 *   128+N 자식이 시그널 N 으로 종료 → 동일 시그널 self-raise
 *   <child code>  자식 non-zero exit 그대로 전파
 *
 * `mat freshness` 의 exit 1 (stale) 은 의도된 design — `mat freshness && deploy.sh`
 * 같이 chain 시 stale 감지로 자동 차단. 사용자가 mat TUI 로 swap/capture 후 재실행.
 */
const EXIT_RESTORE_FAILED = 74;
const EXIT_FRESHNESS_INSPECT_FAILED = 74;
const EXIT_STALE_DETECTED = 1;

main().catch((err) => {
  process.stderr.write(`mat: ${describeError(err)}\n`);
  const exitCode = (err as { exitCode?: unknown })?.exitCode;
  process.exit(typeof exitCode === 'number' ? exitCode : 1);
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [first, ...rest] = args;

  // `mat doctor` 는 read-only 안전 진단이어야 하므로, startup mutation 인 legacy
  // data-dir migration 보다 먼저 dispatch 한다. 일반 명령은 기존처럼 migration 수행.
  if (first === 'doctor') {
    await handleDoctor(rest);
    return;
  }

  // v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) 일회성 데이터 마이그레이션.
  migrateLegacyDataDir();
  // OAuth refresh rotation 인지용 freshness adapter (Codex/Gemini/OpenCode) 등록.
  registerAllBuiltinAdapters();

  if (first == null) {
    runTui();
    return;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (first === '--version' || first === '-v') {
    await printVersion();
    return;
  }
  if (first === 'exec') {
    await handleExec(rest);
    return;
  }
  if (first === 'freshness') {
    await handleFreshness(rest);
    return;
  }
  if (first === 'support' || first === 'explain') {
    await handleSupport(first, rest);
    return;
  }
  if (first === 'session') {
    const r = await handleSession(rest);
    // signal 종료 시 self-raise (exitCode 무시) — 자식 종료 상태를 부모에 정확히 전파.
    if (r.raiseSignal) {
      process.kill(process.pid, r.raiseSignal);
      return;
    }
    process.exit(r.exitCode);
  }

  process.stderr.write(`mat: 알 수 없는 명령: ${first}\n${USAGE}`);
  process.exit(2);
}

async function handleDoctor(rest: string[]): Promise<void> {
  const parsed = parseDoctorArgs(rest);
  if (parsed.help) {
    process.stdout.write(
      `사용법:\n` +
      `  mat doctor [--json]\n` +
      `\n` +
      `read-only 안전 진단을 실행합니다. 자격증명 값/Keychain secret 값은 읽지 않고,\n` +
      `active profile, source 존재 여부, ambient env/project config 우회 가능성,\n` +
      `session 지원 상태를 보고합니다. OAuth deep 비교는 명시적으로 mat freshness 를 사용하세요.\n`
    );
    return;
  }
  const report = await runDoctor();
  if (parsed.asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(report));
  }
}

interface DoctorArgs {
  asJson: boolean;
  help: boolean;
}

function parseDoctorArgs(rest: string[]): DoctorArgs {
  const out: DoctorArgs = { asJson: false, help: false };
  for (const a of rest) {
    if (a === '--json') {
      out.asJson = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    process.stderr.write(`mat doctor: 알 수 없는 옵션: ${a}\n`);
    process.exit(2);
  }
  return out;
}

async function handleSupport(command: 'support' | 'explain', rest: string[]): Promise<void> {
  const parsed = parseSupportArgs(command, rest);
  if (parsed.help) {
    process.stdout.write(
      `사용법:\n` +
      `  mat support <cli> [--json]\n` +
      `  mat explain <cli> [--json]\n` +
      `\n` +
      `CLI 별 mat 지원 범위와 한계를 설명합니다. swap, freshness, session start/run,\n` +
      `ambient/project override 위험, 마지막으로 확인한 upstream 계약을 보여줍니다.\n`
    );
    return;
  }
  const report = buildCliSupportReport(parsed.cliId);
  if (parsed.asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatSupportReport(report));
  }
}

interface SupportArgs {
  cliId: string;
  asJson: boolean;
  help: boolean;
}

function parseSupportArgs(command: 'support' | 'explain', rest: string[]): SupportArgs {
  let cliId: string | undefined;
  let asJson = false;
  let help = false;
  for (const a of rest) {
    if (a === '--json') {
      asJson = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      help = true;
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`mat ${command}: 알 수 없는 옵션: ${a}\n`);
      process.exit(2);
    }
    if (cliId != null) {
      process.stderr.write(`mat ${command}: <cli> 는 하나만 지정할 수 있습니다.\n`);
      process.exit(2);
    }
    cliId = a;
  }
  if (help) return { cliId: cliId ?? '', asJson, help };
  if (cliId == null) {
    process.stderr.write(`mat ${command}: <cli> 인자가 필요합니다.\n`);
    process.exit(2);
  }
  return { cliId, asJson, help };
}

function runTui(): void {
  const { waitUntilExit } = render(<App />);
  waitUntilExit().catch(() => {
    process.exit(1);
  });
}

async function handleExec(rest: string[]): Promise<void> {
  const sepIdx = rest.indexOf('--');
  if (sepIdx < 0) {
    process.stderr.write(
      `mat exec: 명령 구분자 \`--\` 가 필요합니다.\n` +
      `  예: mat exec claude work -- claude --help\n`
    );
    process.exit(2);
  }
  const before = rest.slice(0, sepIdx);
  const after = rest.slice(sepIdx + 1);
  if (before.length !== 2) {
    process.stderr.write(
      `mat exec: <cli> 와 <profile> 두 인자가 필요합니다 (받음: ${before.length}개).\n` +
      `  예: mat exec claude work -- claude --help\n`
    );
    process.exit(2);
  }
  const [cliId, profileName] = before;
  if (after.length === 0) {
    process.stderr.write(
      `mat exec: 실행할 명령이 비어 있습니다. \`--\` 뒤에 명령을 지정하세요.\n`
    );
    process.exit(2);
  }
  const [command, ...cmdArgs] = after;

  const { code, signal, restoreError } = await runExec({
    cliId,
    profileName,
    command,
    args: cmdArgs
  });

  // restore 실패 시: 자식이 0 으로 끝나도 자동화가 cleanup 실패를 감지하도록 별도 exit code.
  // 자식이 시그널/non-zero 로 끝났다면 그 결과를 더 중요하게 다루고 restoreError 는 stderr 안내만.
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code != null && code !== 0) {
    process.exit(code);
  }
  process.exit(restoreError ? EXIT_RESTORE_FAILED : (code ?? 1));
}

/**
 * `mat freshness [<cli>] [--profile <name>] [--json] [--check-only]` 핸들러.
 *
 * cli 미지정 시 모든 builtin + plugin CLI 의 active 프로필을 보고 (active 없는 cli skip).
 * cli 지정 시 active 부재면 사용자 에러 (exit 2).
 * --profile 로 active 와 다른 프로필 강제 가능.
 * --json 으로 stdout JSON 출력 (기본은 사람-친화 표).
 * --check-only 면 unsafe (stale / low-conf rotated / inflight) 감지해도 exit 0 —
 *   read-only 모니터링 케이스 (status line widget / dashboard 등) 가 CI chain 의
 *   exit 1 차단을 받지 않도록.
 */
async function handleFreshness(rest: string[]): Promise<void> {
  const parsed = parseFreshnessArgs(rest);
  const targets = await resolveFreshnessTargets(parsed);
  const reports: FreshnessReport[] = [];
  for (const { cliId, profileName } of targets) {
    try {
      reports.push(await inspectLiveFreshness(cliId, profileName));
    } catch (err) {
      process.stderr.write(`mat freshness ${cliId}: ${describeError(err)}\n`);
      // UnknownCliError 는 사용자 입력 에러 → exit 2 (UsageError 상속, exitCode 2).
      // 그 외 (fs 에러 등) → 내부 검사 실패 (74). instanceof 분기로 message 정규식
      // brittleness 제거 (quad-review MED fix).
      // --check-only 는 inspect 실패 (74) 까지는 우회 안 함 — fs error 는 진짜 문제.
      process.exit(err instanceof UnknownCliError ? 2 : EXIT_FRESHNESS_INSPECT_FAILED);
    }
  }
  if (parsed.asJson) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    process.stdout.write(formatFreshnessTable(reports));
  }
  if (parsed.checkOnly) {
    process.exit(0);
  }
  process.exit(hasUnsafe(reports) ? EXIT_STALE_DETECTED : 0);
}

interface FreshnessArgs {
  cliId?: string;
  profileOverride?: string;
  asJson: boolean;
  checkOnly: boolean;
}

function parseFreshnessArgs(rest: string[]): FreshnessArgs {
  const out: FreshnessArgs = { asJson: false, checkOnly: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') {
      out.asJson = true;
      continue;
    }
    if (a === '--check-only') {
      out.checkOnly = true;
      continue;
    }
    if (a === '--profile') {
      const value = rest[++i];
      if (value == null) {
        process.stderr.write(`mat freshness: --profile 에 값이 필요합니다.\n`);
        process.exit(2);
      }
      out.profileOverride = value;
      continue;
    }
    if (a.startsWith('--')) {
      process.stderr.write(`mat freshness: 알 수 없는 옵션: ${a}\n`);
      process.exit(2);
    }
    if (out.cliId == null) {
      out.cliId = a;
      continue;
    }
    process.stderr.write(`mat freshness: 인자 과다 (예상 1 cli, 실제 2+): ${a}\n`);
    process.exit(2);
  }
  return out;
}

async function resolveFreshnessTargets(
  args: FreshnessArgs
): Promise<{ cliId: string; profileName: string }[]> {
  const cliIds = args.cliId != null ? [args.cliId] : getAllCliDefs().map((c) => c.id);
  const targets: { cliId: string; profileName: string }[] = [];
  for (const cliId of cliIds) {
    const profileName = args.profileOverride ?? (await getActiveProfile(cliId));
    if (profileName == null) {
      if (args.cliId != null) {
        process.stderr.write(
          `mat freshness ${cliId}: active profile 미설정. --profile <name> 으로 지정하세요.\n`
        );
        process.exit(2);
      }
      continue;
    }
    targets.push({ cliId, profileName });
  }
  return targets;
}

/**
 * exit 1 트리거 — 사용자 액션이 필요한 unsafe 상태.
 *
 * `stale` (identity 변경) 외에 **low-confidence rotated** (parse 실패 / fallback 의
 * 화이트리스트 회전 필드 부재 등 정확 분류 불가 상태) 도 unsafe 로 분류.
 * adapter parse 실패로 손상된 auth.json 이 `rotated/low` 로 분류되어 안전한 듯
 * exit 0 통과하던 사고를 차단 (quad-review HIGH fix — Codex-2 #1).
 *
 * adapter 가 명시 분류한 `rotated` high/medium confidence (정상 rotation 흐름) 는
 * unsafe 아님 — 사용자가 swap 진행해도 안전.
 */
function hasUnsafe(reports: FreshnessReport[]): boolean {
  return reports.some((r) =>
    r.sources.some((s) => {
      if (s.result.kind === 'stale') return true;
      if (s.result.kind === 'rotated' && s.result.confidence === 'low') return true;
      // PR-S: inflight (cross-source race) 도 unsafe — 사용자가 retry 또는 source
      // 간 정합성 점검해야 함. exit 1 으로 CI chain 차단해 swap 사고 방지.
      if (s.result.kind === 'inflight') return true;
      return false;
    })
  );
}

/** 4 컬럼 표 (사람-친화). 빈 reports / 빈 sources 모두 안내 한 줄. */
function formatFreshnessTable(reports: FreshnessReport[]): string {
  if (reports.length === 0) {
    return '(보고할 CLI 없음 — active profile 미설정. mat TUI 로 capture 후 재실행하세요.)\n';
  }
  const rows: string[][] = [['CLI', 'Profile', 'Source', 'Status', 'Detail']];
  for (const report of reports) {
    for (const src of report.sources) {
      rows.push([
        report.cliId,
        report.profileName,
        src.saveAs,
        formatStatus(src.result),
        src.result.detail ?? ''
      ]);
    }
  }
  // 모든 report 의 sources 가 비어있어도 (이론상 — 모든 builtin 은 sources 1+) header
  // 만 출력되지 않도록 가드. 한 줄 안내 출력.
  if (rows.length === 1) {
    return '(모든 CLI 의 source 정의가 비어있음 — cli-defs 점검 필요)\n';
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return `${rows.map((row) => row.map((cell, idx) => cell.padEnd(widths[idx])).join('  ')).join('\n')}\n`;
}

function formatStatus(result: CompareResult): string {
  const base = result.kind === 'rotated' && result.subtype
    ? `${result.kind}(${result.subtype})`
    : result.kind;
  return result.confidence === 'low' ? `${base} [low conf]` : base;
}

async function printVersion(): Promise<void> {
  // package.json 은 dist 와 같은 패키지 루트에 있다.
  // import.meta.url 기준으로 한 단계 위로 올라가 읽는다.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    process.stdout.write(`${pkg.version ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
}
