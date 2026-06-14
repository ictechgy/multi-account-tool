/**
 * `mat` CLI entry 통합 테스트 (subprocess 기반).
 *
 * cli.tsx 의 handler / argv parser 는 process.exit() 를 직접 호출하므로 in-process
 * unit test 가 어렵다 → `node dist/cli.js` 를 spawn 해 exit code / stdout / stderr 검증.
 *
 * 의존:
 *  - dist/cli.js 가 빌드되어 있어야 한다 (npm run build).
 *  - $HOME 격리: `setupTmpHome` 으로 매 테스트마다 임시 home + 의도된 profile 디렉토리.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupTmpHome, type TmpHome } from './helpers/tmp-home.js';

const MAT_BIN = join(process.cwd(), 'dist/cli.js');

function runMat(args: string[], home: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('node', [MAT_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 15_000
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? ''
  };
}

describe('mat freshness — exit code 정책', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('PR-Q: --check-only 면 stale 감지해도 exit 0 (read-only 모니터링 케이스)', async () => {
    // 프로필 저장본만 존재하고 라이브 부재 → freshness.ts:355 의 `live==null` 단축
    // 분기로 stale 분류 (adapter.compare 미경유). 향후 setup 변경 시 adapter 의
    // identity-diff stale 로 의도 바꾸려면 라이브에 다른 account_id 의 auth.json 도 작성 필요.
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"v":1}');
    // ~/.codex/auth.json 는 생성하지 않음 → 라이브 부재 → stale.

    const baseline = runMat(['freshness', 'codex', '--profile', 'p'], tmp.home);
    expect(baseline.code).toBe(1);
    expect(baseline.stdout).toMatch(/stale/);

    const checkOnly = runMat(['freshness', 'codex', '--profile', 'p', '--check-only'], tmp.home);
    expect(checkOnly.code).toBe(0);
    // stale 표시는 그대로 stdout 에 출력 — 정보 제공은 유지, exit 만 우회.
    expect(checkOnly.stdout).toMatch(/stale/);
  });

  it('PR-Q: --check-only 가 fresh 케이스에서도 exit 0 유지 (정상 case 회귀 가드)', async () => {
    // codex active 프로필 생성 + 라이브와 동일 내용 저장 → fresh 분류.
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"v":1}');
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex/auth.json'), '{"v":1}');

    const result = runMat(['freshness', 'codex', '--profile', 'p', '--check-only'], tmp.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/fresh/);
  });

  it('PR-Q: --check-only 가 알 수 없는 cli (UnknownCliError) 는 우회하지 않음 → exit 2', async () => {
    // --check-only 는 unsafe 분류만 우회 — 사용자 입력 에러 (exit 2) 는 그대로 유지.
    const result = runMat(['freshness', 'unknown-cli', '--check-only'], tmp.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/mat freshness unknown-cli/);
  });

  it('PR-Q: --check-only 가 잘못된 인자 옵션은 우회하지 않음 → exit 2', async () => {
    const result = runMat(['freshness', '--unknown-flag', '--check-only'], tmp.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/알 수 없는 옵션/);
  });

  it('PR-S: multi-source rotated+stale race → inflight → hasUnsafe → exit 1', async () => {
    // gemini: oauth_creds rotated + google_accounts stale → PR-S 가 둘 다 inflight 로
    // reclassify. hasUnsafe 가 inflight 도 unsafe 분류 → exit 1.
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/gemini/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      join(profileDir, 'oauth_creds.json'),
      '{"access_token":"old","refresh_token":"old"}'
    );
    await fs.writeFile(
      join(profileDir, 'google_accounts.json'),
      '{"active":"alice@fixture.example"}'
    );
    const liveDir = join(tmp.home, '.gemini');
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(
      join(liveDir, 'oauth_creds.json'),
      '{"access_token":"new","refresh_token":"new"}'
    );
    await fs.writeFile(
      join(liveDir, 'google_accounts.json'),
      '{"active":"bob@fixture.example"}'
    );

    const result = runMat(['freshness', 'gemini', '--profile', 'p'], tmp.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/inflight/);
  });

  it('PR-Q: --check-only 가 --json 과 조합 가능 — exit 0 + JSON 출력', async () => {
    // stale 케이스 setup (저장본만, 라이브 부재).
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"v":1}');

    const result = runMat(
      ['freshness', 'codex', '--profile', 'p', '--check-only', '--json'],
      tmp.home
    );
    expect(result.code).toBe(0);
    // JSON parse 가능 + 길이 보장 후 stale 보고 포함 (인덱싱 TypeError 방어).
    const reports = JSON.parse(result.stdout) as Array<{ sources: Array<{ result: { kind: string } }> }>;
    expect(reports).toHaveLength(1);
    expect(reports[0].sources).toHaveLength(1);
    expect(reports[0].sources[0].result.kind).toBe('stale');
  });
});

describe('mat doctor — read-only diagnostics', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('prints parseable JSON and exits 0', () => {
    const result = runMat(['doctor', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { schemaVersion?: number; clis?: unknown[] };
    expect(report.schemaVersion).toBe(1);
    expect(Array.isArray(report.clis)).toBe(true);
  });

  it('does not run legacy data-dir migration before doctor', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');

    const result = runMat(['doctor', '--json'], tmp.home);

    expect(result.code).toBe(0);
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('mat support/explain — support boundary diagnostics', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('prints parseable support JSON for a builtin CLI', () => {
    const result = runMat(['support', 'codex', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schemaVersion?: number;
      cli?: { id?: string };
      capabilities?: { sessionStart?: { status?: string } };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.cli?.id).toBe('codex');
    expect(report.capabilities?.sessionStart?.status).toBe('supported');
  });

  it('supports explain alias with human output for partial session run', () => {
    const result = runMat(['explain', 'aider'], tmp.home);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/mat support — aider/);
    expect(result.stdout).toMatch(/session run: partial/);
    expect(result.stdout).toMatch(/session start: unsupported/);
  });

  it('explains known blocked CLIs', () => {
    const result = runMat(['support', 'agy', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { cli?: { kind?: string }; capabilities?: { swap?: { status?: string } } };
    expect(report.cli?.kind).toBe('known-blocked');
    expect(report.capabilities?.swap?.status).toBe('blocked');
  });

  it('invalid support args exit 2', () => {
    expect(runMat(['support'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'codex', 'extra'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'codex', '--bogus'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'unknown-cli'], tmp.home).code).toBe(2);
  });
});
