/**
 * npm publish 직전 placeholder 검출 가드.
 *
 * package.json / README / Formula 등에 `YOUR-USERNAME`, `YOUR-NAME`,
 * `REPLACE_WITH_REAL_SHA256` 등이 남아있으면 publish 를 차단한다.
 *
 * prepublishOnly 에서 자동 실행되므로 실수로 placeholder 가 포함된
 * 패키지가 배포되는 것을 방지한다.
 */

import { existsSync, readFileSync } from 'node:fs';

// PUBLISHING.md 는 fork 가이드용 placeholder 예시 유지, Formula/mat.rb 는
// 별도 tap 저장소에서 npm publish 직후 sha256 을 채워 관리한다.
// 둘 다 npm publish 패키지(package.json files)에 포함되지 않으므로 의도적으로 제외.
const TARGET_FILES = [
  'package.json',
  'README.md',
  'LICENSE'
];

const FORBIDDEN_TOKENS = [
  'YOUR-USERNAME',
  'YOUR-NAME',
  'REPLACE_WITH_REAL_SHA256'
];

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

let failed = false;

for (const file of TARGET_FILES) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) {
      console.error(`${RED}✗${RESET} ${file}: placeholder ${GRAY}'${token}'${RESET} 가 남아있습니다.`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('');
  console.error('npm publish 전에 위 placeholder 들을 실제 값으로 치환하세요.');
  console.error('자세한 절차는 PUBLISHING.md 의 "사전 준비" 섹션 참고.');
  process.exit(1);
}

console.log(`${GREEN}✓${RESET} publish 준비 완료 (모든 placeholder 치환됨).`);
