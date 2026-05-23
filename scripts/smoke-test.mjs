/**
 * UI 를 띄우지 않고 코어 모듈만 import 해서 동작을 확인하는 스모크 테스트.
 * 사용자 자격증명은 절대 수정하지 않는다 (read-only).
 */

import { detectAll } from '../dist/core/detector.js';
import { loadConfig } from '../dist/core/config.js';
import { BUILTIN_CLI_DEFS } from '../dist/core/cli-defs.js';
import { dataDir, configPath } from '../dist/core/paths.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

let failures = 0;

function check(label, ok, detail = '') {
  const tag = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`${tag} ${label}${detail ? ` ${GRAY}${detail}${RESET}` : ''}`);
  if (!ok) failures++;
}

console.log(`${CYAN}== mat smoke test ==${RESET}`);
console.log(`${GRAY}data dir: ${dataDir()}${RESET}`);
console.log(`${GRAY}config:   ${configPath()}${RESET}`);
console.log('');

// 1) CLI 정의가 모두 잘 로드되는가
check('CLI 정의 로드', BUILTIN_CLI_DEFS.length === 3, `(${BUILTIN_CLI_DEFS.length}개)`);
for (const def of BUILTIN_CLI_DEFS) {
  check(
    `  ${def.id} (${def.name}) sources 정의`,
    def.sources.length > 0,
    `(${def.sources.map((s) => s.type + ':' + s.saveAs).join(', ')})`
  );
}

// 2) config 로드 (없으면 기본값 반환)
const cfg = await loadConfig();
check('config 로드', cfg.version === 1, `active=${JSON.stringify(cfg.active)}`);

// 3) detector — 라이브 자격증명 감지 (read-only)
const results = await detectAll();
check('detector 실행', results.length === 3);
console.log('');
console.log(`${CYAN}-- 라이브 자격증명 감지 결과 --${RESET}`);
for (const r of results) {
  const liveMark = r.hasLiveCredentials ? `${GREEN}live${RESET}` : `${GRAY}no live${RESET}`;
  console.log(`  ${r.cli.id.padEnd(8)} ${liveMark}  present: [${r.present.join(', ')}]  missing: [${r.missing.join(', ')}]`);
}

console.log('');
if (failures === 0) {
  console.log(`${GREEN}ALL PASS${RESET} — 코어 모듈 정상 동작.`);
  process.exit(0);
} else {
  console.log(`${RED}${failures}건 실패${RESET}`);
  process.exit(1);
}
