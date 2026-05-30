/**
 * os-keyring 통합 round-trip 검증 (plan §197 account-recovery gap hard gate).
 *
 * 단위 테스트(tests/core/os-keyring.test.ts)는 spawn 을 mock 하므로, 이 스크립트는
 * mat 의 readSource/writeSource/sourceExists 가 **실제 secret-tool** 과 올바르게
 * 동작하는지 docker(keyring 활성) 안에서 검증한다 — green-test/red-prod 최종 차단.
 *
 * 실행: docker/run.sh bash -c "npm run build && node scripts/os-keyring-roundtrip.mjs"
 *
 * 검증:
 *  1. write → read round-trip (값/account 복구)
 *  2. 동일 service 에 다른 account 2개 → service-only read 는 N>1 →
 *     OsKeyringAccountMissingError (blind-delete 차단)
 *  3. account 지정 read 는 각자 정확히 복구되고 sibling 이 생존
 *  4. sourceExists / 부재(null)
 */

import { readSource, writeSource, sourceExists } from '../dist/core/sources.js';
import { OsKeyringAccountMissingError } from '../dist/core/errors.js';

const SVC = `mat-rt-${process.pid}`;
let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

const srcOf = (account) => ({ type: 'os-keyring', service: SVC, account, saveAs: 'c.json' });
const serviceOnly = { type: 'os-keyring', service: SVC, saveAs: 'c.json' };

async function main() {
  console.log(`os-keyring round-trip (service=${SVC})`);

  // 1) write → read round-trip
  await writeSource(srcOf('alice'), JSON.stringify({ value: 'tok-alice', account: 'alice' }));
  const r1 = await readSource(srcOf('alice'));
  const p1 = JSON.parse(r1);
  p1.value === 'tok-alice' && p1.account === 'alice'
    ? ok('write→read round-trip (값/account 복구)')
    : bad(`round-trip 불일치: ${r1}`);

  // 2) upsert (동일 account 재write)
  await writeSource(srcOf('alice'), JSON.stringify({ value: 'tok-alice-v2', account: 'alice' }));
  const r2 = JSON.parse(await readSource(srcOf('alice')));
  r2.value === 'tok-alice-v2' ? ok('upsert (재write 시 덮어쓰기)') : bad(`upsert 실패: ${r2.value}`);

  // 3) 동일 service 다른 account 추가
  await writeSource(srcOf('bob'), JSON.stringify({ value: 'tok-bob', account: 'bob' }));

  // 4) service-only read → N>1 → OsKeyringAccountMissingError
  try {
    await readSource(serviceOnly);
    bad('service-only read 가 N>1 인데 throw 하지 않음');
  } catch (e) {
    e instanceof OsKeyringAccountMissingError
      ? ok('service-only(N=2) read → OsKeyringAccountMissingError (blind-delete 차단)')
      : bad(`예상과 다른 에러: ${e?.constructor?.name}: ${e?.message}`);
  }

  // 5) account 지정 read 는 각자 정확 복구 + sibling 생존
  const a = JSON.parse(await readSource(srcOf('alice')));
  const b = JSON.parse(await readSource(srcOf('bob')));
  a.value === 'tok-alice-v2' && b.value === 'tok-bob'
    ? ok('account 지정 read 는 각자 정확 복구 (sibling 생존)')
    : bad(`sibling 복구 실패: alice=${a.value} bob=${b.value}`);

  // 6) sourceExists
  (await sourceExists(srcOf('alice'))) ? ok('sourceExists(alice)=true') : bad('exists(alice) false');
  (await sourceExists(srcOf('ghost'))) ? bad('exists(ghost) true (부재인데)') : ok('sourceExists(ghost)=false (부재)');

  // 7) 부재 read → null
  const none = await readSource(srcOf('ghost'));
  none === null ? ok('부재 read → null') : bad(`부재인데 null 아님: ${none}`);
}

main()
  .catch((e) => { console.error('스크립트 오류:', e); fail++; })
  .finally(async () => {
    // cleanup: 생성한 항목 제거 (secret-tool clear 직접 — sources 우회).
    const { spawn } = await import('node:child_process');
    const clr = (args) => new Promise((res) => spawn('/usr/bin/secret-tool', args).on('close', res).on('error', () => res(0)));
    for (const acct of ['alice', 'bob']) {
      await clr(['clear', 'service', SVC, 'account', acct]);
    }
    console.log(`\n결과: PASS=${pass} FAIL=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
