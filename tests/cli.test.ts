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

  it('G003: crush Hyper token-only diff → low-confidence rotated unsafe exit 1', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/crush/p');
    await fs.mkdir(profileDir, { recursive: true });
    const stored = JSON.stringify({
      providers: {
        hyper: {
          oauth: {
            access_token: 'crushfake-access-0001',
            refresh_token: 'crushfake-refresh-0001',
            expires_in: 3600,
            expires_at: 1900000000
          },
          api_key: 'sk-fake-crush-0001'
        }
      }
    });
    const live = JSON.stringify({
      providers: {
        hyper: {
          oauth: {
            access_token: 'crushfake-access-0002',
            refresh_token: 'crushfake-refresh-0001',
            expires_in: 3600,
            expires_at: 1900000000
          },
          api_key: 'sk-fake-crush-0001'
        }
      }
    });
    await fs.writeFile(join(profileDir, 'crush-config.json'), stored);
    await fs.writeFile(join(profileDir, 'crush-data.json'), stored);
    await fs.mkdir(join(tmp.home, '.config/crush'), { recursive: true });
    await fs.mkdir(join(tmp.home, '.local/share/crush'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.config/crush/crush.json'), live);
    await fs.writeFile(join(tmp.home, '.local/share/crush/crush.json'), live);

    const result = runMat(['freshness', 'crush', '--profile', 'p', '--json'], tmp.home);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('crushfake-access-0001');
    expect(result.stdout).not.toContain('crushfake-access-0002');
    expect(result.stdout).not.toContain('sk-fake-crush-0001');
    expect(result.stdout).not.toMatch(/\bsame account\b/i);
    expect(result.stdout).toMatch(/identity unknown|no confirmed rotation/i);

    const reports = JSON.parse(result.stdout) as Array<{
      sources: Array<{ result: { kind: string; subtype?: string; confidence?: string; detail?: string } }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0].sources.length).toBeGreaterThanOrEqual(1);
    for (const source of reports[0].sources) {
      expect(source.result.kind).toBe('rotated');
      expect(source.result.subtype).toBe('both');
      expect(source.result.confidence).toBe('low');
      expect(source.result.detail ?? '').toMatch(/identity unknown|conservative byte-diff/i);
    }
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
    const report = JSON.parse(result.stdout) as {
      cli?: { kind?: string };
      capabilities?: { swap?: { status?: string }; sessionRun?: { status?: string } };
      sources?: unknown[];
      driftContracts?: Array<{ id?: string; evidence?: string[] }>;
    };
    expect(report.cli?.kind).toBe('known-blocked');
    expect(report.sources).toEqual([]);
    expect(report.capabilities?.swap?.status).toBe('blocked');
    expect(report.capabilities?.sessionRun?.status).toBe('blocked');
    expect(report.driftContracts).toEqual([
      expect.objectContaining({
        id: 'agy-blocked-no-contract',
        evidence: expect.arrayContaining([
          expect.stringMatching(/system keyring auth \+ Google Sign-In fallback/),
          expect.stringMatching(/local agy --version: 1\.1\.2/)
        ])
      })
    ]);
  });

  it('keeps known-blocked ids blocked even if a user plugin uses the same id', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'agy.json'),
      JSON.stringify({
        id: 'agy',
        name: 'User Claimed Agy',
        sources: [{ type: 'file', path: '~/.agy/token', saveAs: 'token.json' }]
      })
    );

    const result = runMat(['support', 'agy', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { cli?: { kind?: string }; capabilities?: { swap?: { status?: string } }; sources?: unknown[] };
    expect(report.cli?.kind).toBe('known-blocked');
    expect(report.sources).toEqual([]);
    expect(report.capabilities?.swap?.status).toBe('blocked');
  });

  it('does not run legacy data-dir migration before support or explain help', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');

    const supportResult = runMat(['support', 'codex', '--json'], tmp.home);
    const helpResult = runMat(['explain', '--help'], tmp.home);

    expect(supportResult.code).toBe(0);
    expect(helpResult.code).toBe(0);
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalid support args exit 2', () => {
    expect(runMat(['support'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'codex', 'extra'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'codex', '--bogus'], tmp.home).code).toBe(2);
    expect(runMat(['support', 'unknown-cli'], tmp.home).code).toBe(2);
  });
});

describe('mat plugin — validate/scaffold', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('scaffold prints strict JSON and writes no plugin files', async () => {
    const result = runMat(['plugin', 'scaffold', 'my-cli', '--json'], tmp.home);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const scaffold = JSON.parse(result.stdout) as {
      id?: string;
      name?: string;
      sources?: Array<{ type?: string; path?: string; saveAs?: string }>;
    };
    expect(scaffold).toMatchObject({
      id: 'my-cli',
      name: 'My CLI',
      sources: [{ type: 'file', path: '~/.config/my-cli/credentials.json', saveAs: 'credentials.json' }]
    });
    await expect(fs.stat(join(tmp.home, '.multi-account-tool'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validate external path is static and does not run legacy data-dir migration', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    const pluginPath = join(tmp.home, 'external-plugin.json');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');
    await fs.writeFile(pluginPath, JSON.stringify({
      id: 'external',
      name: 'External',
      sources: [{ type: 'file', path: '~/.config/external/credentials.json', saveAs: 'credentials.json' }]
    }));

    const result = runMat(['plugin', 'validate', pluginPath, '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schemaVersion?: number;
      valid?: boolean;
      summary?: { files?: number; errors?: number };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.valid).toBe(true);
    expect(report.summary).toMatchObject({ files: 1, errors: 0 });
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validate installed plugins reports parse errors as exit 1 JSON diagnostics', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'broken.json'), '{not json');

    const result = runMat(['plugin', 'validate', '--json'], tmp.home);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      valid?: boolean;
      diagnostics?: Array<{ severity?: string; code?: string }>;
      summary?: { errors?: number };
    };
    expect(report.valid).toBe(false);
    expect(report.summary?.errors).toBe(1);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'json_parse_error' })
    ]);
  });

  it('validate human output keeps risky compatible patterns as warnings', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'risky.json'), JSON.stringify({
      id: 'risky',
      name: 'Risky',
      sources: [{ type: 'file', path: '~', saveAs: 'credentials.json' }]
    }));

    const result = runMat(['plugin', 'validate'], tmp.home);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/static validation passed/);
    expect(result.stdout).toMatch(/WARNING broad_file_path/);
    expect(result.stdout).toMatch(/정적 검증/);
  });

  it('invalid plugin usage exits 2', () => {
    expect(runMat(['plugin', 'validate', 'a.json', 'b.json'], tmp.home).code).toBe(2);
    expect(runMat(['plugin', 'scaffold'], tmp.home).code).toBe(2);
    expect(runMat(['plugin', 'scaffold', 'codex'], tmp.home).code).toBe(2);
    expect(runMat(['plugin', 'unknown'], tmp.home).code).toBe(2);
  });
});

describe('mat session run --check — dry-run preflight', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('prints JSON report and does not create session state or spawn the builtin CLI', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"v":1}');

    const result = runMat(['session', 'run', 'codex', 'p', '--check', '--json', '--', '--help'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok?: boolean;
      cliId?: string;
      profileName?: string;
      executable?: string;
      args?: string[];
      blockers?: unknown[];
    };
    expect(report.ok).toBe(true);
    expect(report.cliId).toBe('codex');
    expect(report.profileName).toBe('p');
    expect(report.executable).toBe('codex');
    expect(report.args).toEqual(['--help']);
    expect(report.blockers).toEqual([]);
    await expect(fs.stat(join(tmp.home, '.multi-account-tool/sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('existing profile without required credential is exit 1 report before session state', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/empty');
    await fs.mkdir(profileDir, { recursive: true });

    const result = runMat(['session', 'run', 'codex', 'empty', '--check', '--json', '--'], tmp.home);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok?: boolean;
      profileExists?: boolean;
      blockers?: Array<{ phase?: string; code?: string; message?: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.profileExists).toBe(true);
    expect(report.blockers?.[0]).toMatchObject({
      phase: 'profile',
      code: 'profile-credential-missing'
    });
    await expect(fs.stat(join(tmp.home, '.multi-account-tool/sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('missing profile is exit 1 report, not usage error', () => {
    const result = runMat(['session', 'run', 'codex', 'missing', '--check', '--json', '--'], tmp.home);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok?: boolean;
      profileExists?: boolean;
      blockers?: Array<{ phase?: string; code?: string; message?: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.profileExists).toBe(false);
    expect(report.blockers?.[0]).toMatchObject({
      phase: 'profile',
      code: 'profile-missing',
      message: '프로필을 찾을 수 없습니다: codex/missing'
    });
  });

  it('does not run legacy data-dir migration before session run preflight', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');

    const result = runMat(['session', 'run', 'codex', 'missing', '--explain', '--json', '--'], tmp.home);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).blockers[0]).toMatchObject({ code: 'profile-missing' });
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('mat status/session list observability JSON', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('status --json is parseable and does not run legacy data-dir migration or audit writes', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');

    const result = runMat(['status', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schemaVersion?: number;
      activeProfiles?: unknown[];
      sessions?: { total?: number; active?: number; orphan?: number; unknown?: number };
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.activeProfiles).toEqual([]);
    expect(report.sessions).toEqual({ total: 0, active: 0, orphan: 0, unknown: 0 });
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('session list --json is parseable and does not run legacy data-dir migration', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'sentinel.txt'), 'legacy');

    const result = runMat(['session', 'list', '--json'], tmp.home);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { schemaVersion?: number; summary?: { total?: number }; sessions?: unknown[] };
    expect(report.schemaVersion).toBe(1);
    expect(report.summary?.total).toBe(0);
    expect(report.sessions).toEqual([]);
    await expect(fs.stat(legacy)).resolves.toBeTruthy();
    await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(join(current, 'audit.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('status unknown option exits 2', () => {
    const result = runMat(['status', '--bad'], tmp.home);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mat status: 알 수 없는 옵션');
  });
});
