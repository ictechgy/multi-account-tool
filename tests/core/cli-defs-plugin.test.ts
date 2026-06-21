/**
 * cli-defs-plugin 단위 테스트 + getAllCliDefs / findCliDef 의 plugin 통합.
 *
 * setupTmpHome 으로 $HOME 격리 → dataDir() 가 tmp 를 가리키므로
 * `~/.multi-account-tool/cli-defs/` 도 tmp 하위. resetCliDefCache 로 매 테스트마다 캐시 무효화.
 *
 * 검증 매트릭스:
 *  - loadUserCliDefs: 디렉토리 없음 / 빈 디렉토리 / 정상 plugin / .json 외 무시 / 정렬
 *  - 검증 실패 매트릭스: malformed JSON / non-object / id 누락 / id 형식 위반 /
 *    name 누락 / sources 빈 배열 / source.type 잘못 / source.saveAs 위반 / source.path 빈 값 /
 *    source.service 빈 값 / plugin 끼리 id 충돌
 *  - getAllCliDefs / findCliDef 통합: builtin 우선 / plugin 추가 / 충돌 시 warn
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_CLI_DEFS,
  findCliDef,
  getAllCliDefs,
  getCliDefsWarnings,
  resetCliDefCache
} from '../../src/core/cli-defs.js';
import {
  loadUserCliDefs,
  validateCliDefRaw,
  validatePluginDefinition,
  validatePluginDirectory
} from '../../src/core/cli-defs-plugin.js';
import { dataDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

function cliDefsDir(): string {
  return join(dataDir(), 'cli-defs');
}

async function writePlugin(name: string, content: unknown): Promise<void> {
  const dir = cliDefsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), JSON.stringify(content));
}

async function writePluginRaw(name: string, raw: string): Promise<void> {
  const dir = cliDefsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), raw);
}

describe('validateCliDefRaw (순수 validator)', () => {
  it('정상 입력 → def 반환, error 없음', () => {
    // 비-builtin id 로 plugin 예시 검증 (aider 는 v0.3 부터 builtin).
    const r = validateCliDefRaw({
      id: 'my-cli',
      name: 'My CLI',
      sources: [{ type: 'file', path: '~/.config/my-cli/credentials.json', saveAs: 'credentials.json' }]
    });
    expect(r.error).toBeUndefined();
    expect(r.def?.id).toBe('my-cli');
    expect(r.def?.sources).toHaveLength(1);
  });

  it('plugin name/service 는 정확한 최대 길이(80/128자)를 허용한다', () => {
    const name = 'N'.repeat(80);
    const service = 's'.repeat(128);

    const r = validateCliDefRaw({
      id: 'boundary-cli',
      name,
      sources: [{ type: 'keychain', service, saveAs: 'credentials.json' }]
    });

    expect(r.error).toBeUndefined();
    expect(r.def?.name).toBe(name);
    expect(r.def?.sources[0]).toMatchObject({ type: 'keychain', service });
  });

  it('plugin warning redaction 은 24자 opaque 값을 threshold 에서 redacts 한다', async () => {
    const tmp = await setupTmpHome();
    try {
      const opaque = 'A'.repeat(24);
      await writePlugin('a-threshold.json', {
        id: opaque,
        name: 'A',
        sources: [{ type: 'file', path: '/a', saveAs: 'a.json' }]
      });
      await writePlugin('b-threshold.json', {
        id: opaque,
        name: 'B',
        sources: [{ type: 'file', path: '/b', saveAs: 'b.json' }]
      });

      const r = loadUserCliDefs();
      expect(r.defs.map((d) => d.id)).toEqual([opaque]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('[redacted]');
      expect(r.warnings[0]).not.toContain(opaque);
    } finally {
      resetCliDefCache();
      await tmp.cleanup();
    }
  });

  it.each([
    [null, '최상위'],
    [42, '최상위'],
    ['string', '최상위'],
    [['array'], '최상위'],
    [{}, 'id'],
    [{ id: 'x' }, 'name'],
    [{ id: 'x', name: '' }, 'name'],
    [{ id: 'x', name: 'bad\u001b[31m', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] }, '제어'],
    [{ id: 'x', name: 'safe\u202Egnp.exe', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] }, '제어'],
    [{ id: 'x', name: 'X' }, 'sources'],
    [{ id: 'x', name: 'X', sources: [] }, 'sources'],
    [{ id: '../escape', name: 'X', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] }, 'id'],
    [{ id: 'x', name: 'X', sources: [{ type: 'invalid', saveAs: 'a.json' }] }, 'type'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '/p' }] }, 'saveAs'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '/p', saveAs: '../escape.json' }] }, 'saveAs'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '', saveAs: 'a.json' }] }, 'path'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '/tmp/bad\u202Epath', saveAs: 'a.json' }] }, '제어'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', saveAs: 'a.json' }] }, 'service'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', service: '', saveAs: 'a.json' }] }, 'service'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', service: 'bad\nsvc', saveAs: 'a.json' }] }, '제어'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', service: 'bad\u2028svc', saveAs: 'a.json' }] }, '제어']
  ])('잘못된 입력 → error 메시지에 "%s" 포함', (raw, expectedKeyword) => {
    const r = validateCliDefRaw(raw);
    expect(r.def).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain(expectedKeyword as string);
  });

  it('env-secret source 는 public schema 로 수용하되 runtime/product support 는 열지 않는다', () => {
    const r = validateCliDefRaw({
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'linux-secret-service', handle: 'linux-handle' },
        accountKey: 'linux-account'
      }]
    });

    expect(r.error).toBeUndefined();
    expect(r.def?.sources[0]).toMatchObject({
      type: 'env-secret',
      envName: 'MAT_TEST_SECRET',
      saveAs: 'future.json',
      backend: { kind: 'linux-secret-service' },
      accountKey: 'linux-account'
    });

    const lint = validatePluginDefinition({
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'linux-secret-service', handle: 'linux-handle' },
        accountKey: 'linux-account'
      }]
    });
    expect(lint.def?.sources[0].type).toBe('env-secret');
    expect(lint.diagnostics).toEqual([]);

    const syntheticBackend = validateCliDefRaw({
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'synthetic', handle: 'work-handle' },
        accountKey: 'synthetic-account'
      }]
    });
    expect(syntheticBackend.def).toBeUndefined();
    expect(syntheticBackend.error).toContain('env-secret');
    expect(syntheticBackend.error).not.toContain('synthetic-account');
    expect(syntheticBackend.error).not.toContain('work-handle');

    const missingAccount = validateCliDefRaw({
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'linux-secret-service', handle: 'linux-handle' }
      }]
    });
    expect(missingAccount.def).toBeUndefined();
    expect(missingAccount.error).toContain('account');
    expect(missingAccount.error).not.toContain('linux-handle');
  });

  it('public parser accepted source-type diagnostic includes env-secret but not backend details', () => {
    const r = validateCliDefRaw({
      id: 'bad-type',
      name: 'Bad Type',
      sources: [{ type: 'linux-secret-service', saveAs: 'future.json' }]
    });

    expect(r.def).toBeUndefined();
    expect(r.error).toContain('file');
    expect(r.error).toContain('keychain');
    expect(r.error).toContain('os-keyring');
    expect(r.error).toContain('env-secret');
    expect(r.error).toContain('win-credential');
    expect(r.error).not.toContain('linux-secret-service');
  });

  describe('win-credential source 파싱', () => {
    const validWinSource = {
      type: 'win-credential',
      targetName: 'mat/plugin/sample',
      credentialType: 'generic',
      account: 'sample-account',
      persist: 'local-machine',
      saveAs: 'credentials.json'
    };

    it('정확한 public schema 를 수용하고 secret/backend 필드는 만들지 않는다', () => {
      const r = validateCliDefRaw({
        id: 'win-plugin',
        name: 'Win Plugin',
        sources: [validWinSource]
      });

      expect(r.error).toBeUndefined();
      expect(r.def?.sources[0]).toEqual(validWinSource);
      expect(JSON.stringify(r.def)).not.toContain('secret');
    });

    it.each([
      [{ ...validWinSource, targetName: '' }, 'targetName'],
      [{ ...validWinSource, credentialType: 'domain-password' }, 'credentialType'],
      [{ ...validWinSource, account: '' }, 'account'],
      [{ ...validWinSource, account: 'bad\x00account' }, 'unsafe'],
      [{ ...validWinSource, persist: 'machine' }, 'persist'],
      [{ ...validWinSource, secret: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' }, 'unknown fields'],
      [{ ...validWinSource, password: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' }, 'unknown fields'],
      [{ ...validWinSource, service: 'not-used' }, 'unknown fields']
    ])('win-credential 거부 케이스 → error 에 "%s" 포함하고 값은 누설하지 않음', (source, expectedKeyword) => {
      const r = validateCliDefRaw({ id: 'bad-win', name: 'Bad Win', sources: [source] });
      expect(r.def).toBeUndefined();
      expect(r.error).toContain(expectedKeyword as string);
      expect(r.error).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    });

    it('static linter 는 win-credential 을 generic service/account 경고 대상으로 오분류하지 않는다', () => {
      const r = validatePluginDefinition({
        id: 'win-plugin',
        name: 'Win Plugin',
        sources: [validWinSource]
      });

      expect(r.def?.sources[0].type).toBe('win-credential');
      expect(r.diagnostics).toEqual([]);
    });
  });

  it('보안 회귀 가드: raw 에 session/sessionRun/warning 이 있어도 결과 def 에 없음 (plugin 은 세션 격리 미수용)', () => {
    // 세션 격리는 빌트인 def 전용이다 — plugin 이 임의 env 를 주입할 수 있게 하면 신뢰 경계가
    // 무너진다(예: 사용자 입력 env 로 자격증명 디렉토리를 임의 위치로 리다이렉트). validateCliDefRaw
    // 는 {id,name,sources} 만 반환하므로 raw 의 session 은 구조적으로 drop 된다. 이를 회귀 고정한다.
    const r = validateCliDefRaw({
      id: 'evil',
      name: 'Evil',
      sources: [{ type: 'file', path: '~/.evil/creds.json', saveAs: 'creds.json' }],
      // plugin 작성자가 session 을 끼워 넣어도 절대 반영되면 안 된다.
      session: {
        roots: [
          {
            env: 'EVIL_HOME',
            base: '~/.evil',
            // warning 이 허용되면 plugin 이 mat-branded stderr 문구를 사칭할 수 있다.
            warning: 'pretend this warning came from mat'
          }
        ]
      },
      // command-scoped session run 도 builtin-only 신뢰 경계다. plugin 이 임의 executable 을 주입하면 안 된다.
      sessionRun: { executable: 'evil' },
      warning: 'top-level warning must also be ignored'
    });
    expect(r.error).toBeUndefined();
    expect(r.def).toBeDefined();
    expect(r.def!.session).toBeUndefined(); // session 미수용 — 구조적 drop
    expect(r.def!.sessionRun).toBeUndefined(); // sessionRun 미수용 — 구조적 drop
    // 반환 키가 {id,name,sources} 로만 한정되는지도 고정(향후 필드 추가 시 의도 검토 강제).
    expect(Object.keys(r.def!).sort()).toEqual(['id', 'name', 'sources']);
  });

  it('파일/keychain 혼합 sources 정상 처리', () => {
    const r = validateCliDefRaw({
      id: 'mixed',
      name: 'Mixed',
      sources: [
        { type: 'file', path: '/tmp/x', saveAs: 'x.json' },
        { type: 'keychain', service: 'My Service', saveAs: 'y.json' }
      ]
    });
    expect(r.error).toBeUndefined();
    expect(r.def?.sources).toHaveLength(2);
    expect(r.def?.sources[0].type).toBe('file');
    expect(r.def?.sources[1].type).toBe('keychain');
  });

  describe('os-keyring source 파싱', () => {
    it('service+saveAs 만 → OsKeyringSource (account/backend 없음)', () => {
      const r = validateCliDefRaw({
        id: 'ok', name: 'OK',
        sources: [{ type: 'os-keyring', service: 'mat-creds', saveAs: 'creds.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0] as { type: string; service: string; account?: string; backend?: string; saveAs: string };
      expect(src.type).toBe('os-keyring');
      expect(src.service).toBe('mat-creds');
      expect(src.account).toBeUndefined();
      expect(src.backend).toBeUndefined();
      expect(src.saveAs).toBe('creds.json');
    });

    it('service+account+saveAs → account 반영', () => {
      const r = validateCliDefRaw({
        id: 'ok', name: 'OK',
        sources: [{ type: 'os-keyring', service: 'mat-creds', account: 'user@example.com', saveAs: 'creds.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0] as { account?: string };
      expect(src.account).toBe('user@example.com');
    });

    it("service+backend('auto')+saveAs → backend 반영", () => {
      const r = validateCliDefRaw({
        id: 'ok', name: 'OK',
        sources: [{ type: 'os-keyring', service: 'mat-creds', backend: 'auto', saveAs: 'creds.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0] as { backend?: string };
      expect(src.backend).toBe('auto');
    });

    it("service+backend('secret-service')+account+saveAs → 모든 필드 반영", () => {
      const r = validateCliDefRaw({
        id: 'ok', name: 'OK',
        sources: [{ type: 'os-keyring', service: 'mat-creds', backend: 'secret-service', account: 'alice', saveAs: 'creds.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0] as { type: string; service: string; account?: string; backend?: string; saveAs: string };
      expect(src.type).toBe('os-keyring');
      expect(src.service).toBe('mat-creds');
      expect(src.account).toBe('alice');
      expect(src.backend).toBe('secret-service');
      expect(src.saveAs).toBe('creds.json');
    });

    it.each([
      [{ type: 'os-keyring', saveAs: 'a.json' }, 'service'],
      [{ type: 'os-keyring', service: '', saveAs: 'a.json' }, 'service'],
      [{ type: 'os-keyring', service: 'bad\tsvc', saveAs: 'a.json' }, '제어'],
      [{ type: 'os-keyring', service: 'svc', account: '', saveAs: 'a.json' }, 'account'],
      [{ type: 'os-keyring', service: 'svc', account: 'has\x00nul', saveAs: 'a.json' }, '제어'],
      [{ type: 'os-keyring', service: 'svc', account: 'safe\u202Egnp.exe', saveAs: 'a.json' }, '제어'],
      [{ type: 'os-keyring', service: 'svc', backend: 'kwallet', saveAs: 'a.json' }, 'backend'],
      [{ type: 'os-keyring', service: 'svc', backend: '', saveAs: 'a.json' }, 'backend']
    ])('os-keyring 거부 케이스 → error 에 "%s" 포함', (source, expectedKeyword) => {
      const r = validateCliDefRaw({ id: 'bad', name: 'Bad', sources: [source] });
      expect(r.def).toBeUndefined();
      expect(r.error).toContain(expectedKeyword as string);
    });
  });

  describe('keychain source 의 account optional 필드', () => {
    it('account 미지정 → keychain source 에 account 필드 없음 (기존 동작 유지)', () => {
      const r = validateCliDefRaw({
        id: 'plain', name: 'Plain',
        sources: [{ type: 'keychain', service: 'svc', saveAs: 'a.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0];
      expect(src.type).toBe('keychain');
      expect((src as { account?: string }).account).toBeUndefined();
    });

    it('account 정상 문자열 → KeychainSource.account 에 반영', () => {
      const r = validateCliDefRaw({
        id: 'scoped', name: 'Scoped',
        sources: [{ type: 'keychain', service: 'svc', account: 'user@example.com', saveAs: 'a.json' }]
      });
      expect(r.error).toBeUndefined();
      const src = r.def!.sources[0] as { type: string; account?: string };
      expect(src.account).toBe('user@example.com');
    });

    it.each([
      [42, '비어있지 않은 문자열'],
      [null, '비어있지 않은 문자열'],
      [true, '비어있지 않은 문자열'],
      ['', '비어있지 않은 문자열'],
      ['has\x00nul', '제어']
    ])('account 가 %j → error "%s" 포함', (badAccount, expectedKeyword) => {
      const r = validateCliDefRaw({
        id: 'bad', name: 'Bad',
        sources: [{ type: 'keychain', service: 'svc', account: badAccount, saveAs: 'a.json' }]
      });
      expect(r.def).toBeUndefined();
      expect(r.error).toContain('account');
      expect(r.error).toContain(expectedKeyword as string);
    });
  });
});

describe('validatePluginDefinition / validatePluginDirectory (static plugin linter)', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });

  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('schema-valid risky plugin fields are warnings, not schema errors', () => {
    const r = validatePluginDefinition({
      id: 'risky',
      name: 'Risky',
      sources: [
        { type: 'file', path: '~', saveAs: 'credentials.json' },
        { type: 'keychain', service: 'goose', saveAs: 'goose.json' }
      ],
      session: { roots: [] },
      sessionRun: { executable: 'risky' },
      env: { RISKY_HOME: '/tmp/risky' },
      ambient: { allow: true }
    });

    expect(r.def?.id).toBe('risky');
    expect(r.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      'ignored_trust_boundary_field',
      'ignored_trust_boundary_field',
      'ignored_trust_boundary_field',
      'ignored_trust_boundary_field',
      'broad_file_path',
      'generic_service_without_account'
    ]);
    expect(r.diagnostics.map((d) => d.message).join('\n')).toContain('plugins cannot define session isolation');
  });

  it('builtin id collision is reported as an error before use', () => {
    const r = validatePluginDefinition(
      {
        id: 'codex',
        name: 'Codex Override',
        sources: [{ type: 'file', path: '~/.config/codex/credentials.json', saveAs: 'credentials.json' }]
      },
      { builtinIds: BUILTIN_CLI_DEFS.map((d) => d.id) }
    );

    expect(r.def?.id).toBe('codex');
    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'builtin_id_collision',
        pluginId: 'codex'
      })
    ]);
  });

  it('directory validation reports parse errors and duplicate plugin ids with schemaVersion 1', async () => {
    await writePlugin('a-one.json', {
      id: 'dup',
      name: 'One',
      sources: [{ type: 'file', path: '~/.config/one/credentials.json', saveAs: 'credentials.json' }]
    });
    await writePlugin('b-two.json', {
      id: 'dup',
      name: 'Two',
      sources: [{ type: 'file', path: '~/.config/two/credentials.json', saveAs: 'credentials.json' }]
    });
    await writePluginRaw('c-broken.json', '{not json');

    const report = validatePluginDirectory(cliDefsDir(), { builtinIds: BUILTIN_CLI_DEFS.map((d) => d.id) });

    expect(report.schemaVersion).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.summary).toMatchObject({ files: 3, plugins: 2, errors: 2 });
    expect(report.diagnostics.map((d) => d.code)).toContain('duplicate_plugin_id');
    expect(report.diagnostics.map((d) => d.code)).toContain('json_parse_error');
    expect(report.files.some((file) =>
      file.valid === false && file.diagnostics.some((d) => d.code === 'duplicate_plugin_id')
    )).toBe(true);
  });
});

describe('loadUserCliDefs — fs 통합', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });
  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('cli-defs 디렉토리 없음 → 빈 결과, warning 없음 (조용)', () => {
    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('on-disk plugin 의 unsafe display char 는 warning 후 skip', async () => {
    await writePlugin('bad.json', {
      id: 'bad',
      name: 'Bad\u001b[31mName',
      sources: [{ type: 'file', path: '/tmp/x', saveAs: 'x.json' }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('name');
    expect(r.warnings[0]).toContain('제어');
  });

  it('plugin name 은 앞뒤 공백과 과도한 길이를 거부한다', async () => {
    await writePlugin('space-name.json', {
      id: 'spacename',
      name: ' Bad',
      sources: [{ type: 'file', path: '/tmp/x', saveAs: 'x.json' }]
    });
    await writePlugin('long-name.json', {
      id: 'longname',
      name: 'N'.repeat(81),
      sources: [{ type: 'file', path: '/tmp/y', saveAs: 'y.json' }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toContain('name');
    expect(r.warnings.join('\n')).toContain('공백');
    expect(r.warnings.join('\n')).toContain('80자');
  });

  it('plugin service 는 앞뒤 공백과 과도한 길이를 거부한다', async () => {
    await writePlugin('space-service.json', {
      id: 'spacesvc',
      name: 'Space Svc',
      sources: [{ type: 'keychain', service: ' svc', saveAs: 'x.json' }]
    });
    await writePlugin('long-service.json', {
      id: 'longsvc',
      name: 'Long Svc',
      sources: [{ type: 'keychain', service: 's'.repeat(129), saveAs: 'y.json' }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toContain('service');
    expect(r.warnings.join('\n')).toContain('공백');
    expect(r.warnings.join('\n')).toContain('128자');
  });

  it('warning 의 plugin 파일명도 display sanitize 된다', async () => {
    await writePluginRaw('bad\u001b[31m.json', '{not json');

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('bad?[31m.json');
    expect(r.warnings[0]).not.toContain('\u001b');
  });

  it('warning 의 validation error 본문도 display sanitize 된다', async () => {
    await writePlugin('bad-id.json', {
      id: 'bad\u001b[31m',
      name: 'Bad',
      sources: [{ type: 'file', path: '/tmp/x', saveAs: 'x.json' }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('bad?[31m');
    expect(r.warnings[0]).not.toContain('\u001b');
  });

  it('warning 의 plugin 파일명과 validation error 본문도 secret-like redact 된다', async () => {
    const providerToken = 'sk-abcdefghijklmnop';
    const longOpaqueId = 'A'.repeat(60);
    await writePluginRaw(`${providerToken}.json`, '{not json');
    await writePlugin('bad-long-id.json', {
      id: longOpaqueId,
      name: 'Bad',
      sources: [{ type: 'file', path: '/tmp/x', saveAs: 'x.json' }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toContain('[redacted]');
    expect(r.warnings.join('\n')).not.toContain(providerToken);
    expect(r.warnings.join('\n')).not.toContain(longOpaqueId);
  });

  it('빈 디렉토리 → 빈 결과', async () => {
    await fs.mkdir(cliDefsDir(), { recursive: true });
    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('정상 plugin 1개 → defs 에 포함', async () => {
    // 비-builtin id 사용 (aider 는 v0.3 부터 builtin — getAllCliDefs 단계에서 충돌 처리).
    await writePlugin('my-cli.json', {
      id: 'my-cli',
      name: 'My CLI',
      sources: [{ type: 'file', path: '~/.config/my-cli/credentials.json', saveAs: 'credentials.json' }]
    });
    const r = loadUserCliDefs();
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].id).toBe('my-cli');
    expect(r.warnings).toEqual([]);
  });

  it('.json 확장자 외 파일 무시', async () => {
    await writePlugin('valid.json', { id: 'valid', name: 'Valid', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    await writePluginRaw('README.md', '# 사용자 메모');
    await writePluginRaw('schema.yaml', 'id: ignored');
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['valid']);
  });

  it('파일명 알파벳순 정렬 → 결정적 등장 순서', async () => {
    await writePlugin('z-third.json', { id: 'three', name: 'Three', sources: [{ type: 'file', path: '/3', saveAs: '3.json' }] });
    await writePlugin('a-first.json', { id: 'one', name: 'One', sources: [{ type: 'file', path: '/1', saveAs: '1.json' }] });
    await writePlugin('m-middle.json', { id: 'two', name: 'Two', sources: [{ type: 'file', path: '/2', saveAs: '2.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['one', 'two', 'three']);
  });

  it('JSON 파싱 실패 → warning 추가, 나머지 plugin 은 계속 처리', async () => {
    await writePluginRaw('broken.json', '{ not valid json');
    await writePlugin('valid.json', { id: 'valid', name: 'V', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['valid']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('broken.json');
    expect(r.warnings[0]).toContain('JSON 파싱 실패');
  });

  it('validation 실패 → warning 추가, 나머지 plugin 은 계속 처리', async () => {
    await writePlugin('bad-id.json', { id: '../escape', name: 'Bad', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    await writePlugin('ok.json', { id: 'ok', name: 'OK', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['ok']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('bad-id.json');
  });

  it('on-disk env-secret plugin 은 metadata 로 로드되며 runtime 은 별도 hard-stop 대상이다', async () => {
    await writePlugin('future-env.json', {
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'linux-secret-service', handle: 'linux-handle' },
        accountKey: 'linux-account'
      }]
    });

    const r = loadUserCliDefs();
    expect(r.warnings).toEqual([]);
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].sources[0]).toMatchObject({
      type: 'env-secret',
      envName: 'MAT_TEST_SECRET',
      saveAs: 'future.json',
      backend: { kind: 'linux-secret-service' },
      accountKey: 'linux-account'
    });
  });

  it('on-disk env-secret validation failure 는 payload 를 누설하지 않는다', async () => {
    await writePlugin('future-env.json', {
      id: 'future-env',
      name: 'Future Env',
      sources: [{
        type: 'env-secret',
        envName: 'MAT_TEST_SECRET',
        saveAs: 'future.json',
        backend: { kind: 'synthetic', handle: 'work-handle' },
        accountKey: 'synthetic-account'
      }]
    });

    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('env-secret');
    expect(r.warnings[0]).not.toContain('work-handle');
    expect(r.warnings[0]).not.toContain('synthetic-account');
  });

  it('plugin 끼리 id 충돌 → 첫 등장만 채택, 후속은 warning + skip', async () => {
    // 파일명 정렬 기준: 'a-x' < 'b-x'. 따라서 a-x 가 채택, b-x 가 skip.
    await writePlugin('a-x.json', { id: 'dup', name: 'A', sources: [{ type: 'file', path: '/a', saveAs: 'a.json' }] });
    await writePlugin('b-x.json', { id: 'dup', name: 'B', sources: [{ type: 'file', path: '/b', saveAs: 'b.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['dup']);
    expect(r.defs[0].name).toBe('A');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('b-x.json');
    expect(r.warnings[0]).toContain('dup');
  });

  it('plugin id 충돌 warning 의 secret-like id 는 redact 된다', async () => {
    const providerId = 'sk-abcdefghijklmnop';
    await writePlugin('a-secret.json', { id: providerId, name: 'A', sources: [{ type: 'file', path: '/a', saveAs: 'a.json' }] });
    await writePlugin('b-secret.json', { id: providerId, name: 'B', sources: [{ type: 'file', path: '/b', saveAs: 'b.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual([providerId]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('b-secret.json');
    expect(r.warnings[0]).toContain('[redacted]');
    expect(r.warnings[0]).not.toContain(providerId);
  });

  it('plugin id 충돌 warning 의 32자 opaque id 도 redact 된다', async () => {
    const opaqueId = 'A'.repeat(32);
    await writePlugin('a-opaque.json', { id: opaqueId, name: 'A', sources: [{ type: 'file', path: '/a', saveAs: 'a.json' }] });
    await writePlugin('b-opaque.json', { id: opaqueId, name: 'B', sources: [{ type: 'file', path: '/b', saveAs: 'b.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual([opaqueId]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('b-opaque.json');
    expect(r.warnings[0]).toContain('[redacted]');
    expect(r.warnings[0]).not.toContain(opaqueId);
  });
});

describe('getAllCliDefs / findCliDef — builtin + plugin 통합', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });
  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('plugin 없음 → builtin 만 반환', () => {
    const defs = getAllCliDefs();
    expect(defs.map(d => d.id)).toEqual(BUILTIN_CLI_DEFS.map(d => d.id));
    expect(getCliDefsWarnings()).toEqual([]);
  });

  it('plugin 추가 시 builtin 뒤에 append', async () => {
    // 비-builtin id 사용 (aider 는 v0.3 부터 builtin — 본 테스트는 plugin append 동작 검증).
    await writePlugin('my-cli.json', {
      id: 'my-cli', name: 'My CLI', sources: [{ type: 'file', path: '~/.config/my-cli/cred.json', saveAs: 'cred.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.map(d => d.id)).toEqual([...BUILTIN_CLI_DEFS.map(d => d.id), 'my-cli']);
    expect(findCliDef('my-cli')?.name).toBe('My CLI');
  });

  it('aider plugin 도 builtin 과 충돌 → 무시 + warning (v0.3 회귀 가드)', async () => {
    // v0.3 부터 aider 는 builtin. plugin 의 동일 id 는 skip 되어야 (builtin 우선).
    await writePlugin('aider.json', {
      id: 'aider', name: 'Custom Aider', sources: [{ type: 'file', path: '/custom-aider', saveAs: 'c.yml' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'aider')).toHaveLength(1);  // builtin 만
    expect(findCliDef('aider')?.name).toBe('Aider');  // builtin name 유지 (Custom Aider 가 아니어야)
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('aider') && w.includes('builtin'))).toBe(true);
  });

  it('kimi plugin 도 builtin 과 충돌 → 무시 + warning (v0.3.1+ 회귀 가드)', async () => {
    // kimi 빌트인 도입 이후 plugin 의 동일 id 는 skip (builtin 우선).
    await writePlugin('kimi.json', {
      id: 'kimi', name: 'Custom Kimi', sources: [{ type: 'file', path: '/custom-kimi', saveAs: 'c.toml' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'kimi')).toHaveLength(1);  // builtin 만
    expect(findCliDef('kimi')?.name).toBe('Kimi CLI');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('kimi') && w.includes('builtin'))).toBe(true);
  });

  it('qwen plugin 도 builtin 과 충돌 → 무시 + warning (v0.3.1+ 회귀 가드)', async () => {
    // qwen 빌트인 도입 이후 plugin 의 동일 id 는 skip (builtin 우선).
    await writePlugin('qwen.json', {
      id: 'qwen', name: 'Custom Qwen', sources: [{ type: 'file', path: '/custom-qwen', saveAs: 'c.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'qwen')).toHaveLength(1);  // builtin 만
    expect(findCliDef('qwen')?.name).toBe('Qwen Code CLI');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('qwen') && w.includes('builtin'))).toBe(true);
  });

  it('crush plugin 도 builtin 과 충돌 → 무시 + warning (v0.3.1+ 회귀 가드)', async () => {
    // crush 빌트인 도입 이후 plugin 의 동일 id 는 skip (builtin 우선).
    await writePlugin('crush.json', {
      id: 'crush', name: 'Custom Crush', sources: [{ type: 'file', path: '/custom-crush', saveAs: 'c.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'crush')).toHaveLength(1);  // builtin 만
    expect(findCliDef('crush')?.name).toBe('Crush');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('crush') && w.includes('builtin'))).toBe(true);
  });

  it('opencode plugin 도 builtin 과 충돌 → 무시 + warning (v0.3.1+ 회귀 가드)', async () => {
    // opencode 빌트인 도입 이후 plugin 의 동일 id 는 skip (builtin 우선).
    await writePlugin('opencode.json', {
      id: 'opencode', name: 'Custom OpenCode', sources: [{ type: 'file', path: '/custom-opencode', saveAs: 'c.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'opencode')).toHaveLength(1);  // builtin 만
    expect(findCliDef('opencode')?.name).toBe('OpenCode');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('opencode') && w.includes('builtin'))).toBe(true);
  });

  it('goose plugin 도 builtin 과 충돌 → 무시 + warning (v0.4+ 회귀 가드)', async () => {
    // goose 빌트인 도입 (Block 의 오픈소스 AI agent) 이후 plugin 의 동일 id 는 skip (builtin 우선).
    await writePlugin('goose.json', {
      id: 'goose', name: 'Custom Goose', sources: [{ type: 'file', path: '/custom-goose', saveAs: 'c.yaml' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'goose')).toHaveLength(1);  // builtin 만
    expect(findCliDef('goose')?.name).toBe('Goose');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('goose') && w.includes('builtin'))).toBe(true);
  });

  it('grok plugin 도 builtin 과 충돌 → 무시 + warning (Grok PR1 회귀 가드)', async () => {
    await writePlugin('grok.json', {
      id: 'grok',
      name: 'Custom Grok',
      sources: [{ type: 'file', path: '~/.grok/custom-token.json', saveAs: 'custom-grok.json' }]
    });

    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'grok')).toHaveLength(1);  // builtin 만
    expect(findCliDef('grok')?.name).toBe('Grok Build');  // builtin name 유지
    expect(findCliDef('grok')?.sources).toEqual([
      { type: 'file', path: '~/.grok/auth.json', saveAs: 'grok-auth.json' }
    ]);
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('grok') && w.includes('builtin'))).toBe(true);
  });

  it('README plugin collision guidance lists every builtin id', async () => {
    const builtinIds = BUILTIN_CLI_DEFS.map((d) => d.id);
    const readmeExpectations = [
      {
        path: join(process.cwd(), 'README.md'),
        anchor: 'Built-in CLIs'
      },
      {
        path: join(process.cwd(), 'README.ko.md'),
        anchor: '빌트인 CLI'
      }
    ];

    for (const { path, anchor } of readmeExpectations) {
      const readme = await fs.readFile(path, 'utf8');
      const line = readme.split('\n').find((candidate) => candidate.includes(anchor) && candidate.includes('`mat`'));

      expect(line, `${path} plugin collision guidance`).toBeDefined();
      for (const id of builtinIds) {
        expect(line).toContain(`\`${id}\``);
      }
    }
  });

  it('id 가 builtin 과 충돌 → plugin 무시 + warning', async () => {
    // 'claude' 는 builtin id — plugin 의 동일 id 는 skip.
    await writePlugin('claude.json', {
      id: 'claude', name: 'Custom Claude', sources: [{ type: 'file', path: '/custom', saveAs: 'custom.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'claude')).toHaveLength(1);  // builtin 만
    expect(findCliDef('claude')?.name).toBe('Claude Code');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('claude') && w.includes('builtin'))).toBe(true);
  });

  it('module-level 캐시: 두 번째 호출은 fs 재읽지 않음 (resetCliDefCache 로만 갱신)', async () => {
    // 1) 처음 호출: plugin 없음 → builtin 만
    const first = getAllCliDefs();
    expect(first.map(d => d.id)).toEqual(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen', 'crush', 'opencode', 'goose', 'grok']);

    // 2) 캐시 후 plugin 추가 → getAllCliDefs 는 여전히 캐시 반환
    await writePlugin('late.json', { id: 'late', name: 'Late', sources: [{ type: 'file', path: '/l', saveAs: 'l.json' }] });
    const second = getAllCliDefs();
    expect(second.map(d => d.id)).toEqual(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen', 'crush', 'opencode', 'goose', 'grok']);  // 캐시

    // 3) resetCliDefCache 후 호출 → 새로 로드
    resetCliDefCache();
    const third = getAllCliDefs();
    expect(third.map(d => d.id)).toEqual(['claude', 'codex', 'gemini', 'aider', 'kimi', 'qwen', 'crush', 'opencode', 'goose', 'grok', 'late']);
  });

  it('잘못된 plugin warning 이 getCliDefsWarnings 에 surface 됨', async () => {
    await writePluginRaw('broken.json', 'not json');
    getAllCliDefs();  // 로드 트리거
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('broken.json'))).toBe(true);
  });
});
