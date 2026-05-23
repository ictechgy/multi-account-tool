/**
 * tsc 빌드 후 dist/cli.js 의 shebang 보장 및 실행 권한 부여.
 * tsc 는 첫 줄 shebang 을 보존하지만, 안전망으로 빠진 경우 자동 보충한다.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const cliPath = 'dist/cli.js';

if (!existsSync(cliPath)) {
  console.error(`postbuild: ${cliPath} 가 존재하지 않습니다. tsc 빌드를 먼저 확인하세요.`);
  process.exit(1);
}

const SHEBANG = '#!/usr/bin/env node\n';
const content = readFileSync(cliPath, 'utf8');

if (!content.startsWith('#!')) {
  writeFileSync(cliPath, SHEBANG + content);
}

chmodSync(cliPath, 0o755);
console.log(`postbuild: ${cliPath} 에 shebang/실행권한 적용 완료`);
