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
import { runExec } from './core/exec.js';
import { errorMessage } from './core/errors.js';
import { migrateLegacyDataDir } from './core/migrate.js';

const USAGE =
  `사용법:\n` +
  `  mat                                       TUI 실행\n` +
  `  mat exec <cli> <profile> -- <cmd...>     <profile> 로 swap 후 <cmd> 실행, 종료 후 원복\n` +
  `  mat --help                                이 도움말 출력\n` +
  `  mat --version                             버전 출력\n`;

main().catch((err) => {
  process.stderr.write(`mat: ${errorMessage(err)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  // v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) 일회성 데이터 마이그레이션.
  migrateLegacyDataDir();

  const args = process.argv.slice(2);
  const [first, ...rest] = args;

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

  process.stderr.write(`mat: 알 수 없는 명령: ${first}\n${USAGE}`);
  process.exit(2);
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

  const { code, signal } = await runExec({
    cliId,
    profileName,
    command,
    args: cmdArgs
  });

  if (signal) {
    // 자식이 시그널로 종료된 경우 동일 시그널로 자신을 종료해 부모에 정확히 전달.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
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
