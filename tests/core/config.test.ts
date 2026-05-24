/**
 * config 단위 테스트.
 *
 * loadConfig / saveConfig / mutateConfig / setActiveProfile / getActiveProfile /
 * clearActiveProfile / markFirstImportPromptShown / cleanupTmpFiles 전 함수 검증.
 *
 * io-atomic 의 writeFileAtomic 은 real fs 호출 — config 는 integration-style 테스트.
 * setupTmpHome 으로 $HOME 격리.
 */

import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupTmpFiles,
  clearActiveProfile,
  getActiveProfile,
  loadConfig,
  markFirstImportPromptShown,
  mutateConfig,
  saveConfig,
  setActiveProfile
} from '../../src/core/config.js';
import { configPath, dataDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('config', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  describe('loadConfig', () => {
    it('파일이 없으면 기본 Config 반환 (version 1, active 빈 객체)', async () => {
      const cfg = await loadConfig();
      expect(cfg).toEqual({ version: 1, active: {} });
    });

    it('정상 파일을 그대로 파싱', async () => {
      await saveConfig({ version: 1, active: { codex: 'work' }, firstImportPromptShown: true });
      const cfg = await loadConfig();
      expect(cfg).toEqual({ version: 1, active: { codex: 'work' }, firstImportPromptShown: true });
    });

    it('active 가 누락된 부분 Config 도 안전하게 빈 객체로 처리', async () => {
      await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(configPath(), JSON.stringify({ version: 1 }));
      const cfg = await loadConfig();
      expect(cfg.active).toEqual({});
    });

    it('loadConfig 결과의 active 를 mutate 해도 원본 디스크 상태 무영향 (spread 복사)', async () => {
      await saveConfig({ version: 1, active: { codex: 'work' } });
      const cfg1 = await loadConfig();
      cfg1.active.codex = 'mutated-in-memory';
      const cfg2 = await loadConfig();
      expect(cfg2.active.codex).toBe('work');
    });

    it('손상된 JSON 은 throw (ENOENT 외 에러 전파)', async () => {
      await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(configPath(), 'not-json{{{');
      await expect(loadConfig()).rejects.toThrow();
    });
  });

  describe('saveConfig', () => {
    it('데이터 디렉토리를 자동 생성 (0o700) 하고 config.json 작성', async () => {
      expect(existsSync(dataDir())).toBe(false);
      await saveConfig({ version: 1, active: { codex: 'a' } });

      expect(existsSync(dataDir())).toBe(true);
      const stat = await fs.stat(dataDir());
      expect(stat.mode & 0o777).toBe(0o700);
      const content = JSON.parse(await fs.readFile(configPath(), 'utf8'));
      expect(content).toEqual({ version: 1, active: { codex: 'a' } });
    });

    it('config 파일은 atomic write — 권한 0600 (writeFileAtomic 위임)', async () => {
      await saveConfig({ version: 1, active: {} });
      const stat = await fs.stat(configPath());
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('mutateConfig', () => {
    it('sync mutator: load → mutate → save 순서로 적용', async () => {
      await saveConfig({ version: 1, active: { codex: 'old' } });
      await mutateConfig((cfg) => {
        cfg.active.codex = 'new';
        cfg.active.claude = 'work';
      });
      const cfg = await loadConfig();
      expect(cfg.active).toEqual({ codex: 'new', claude: 'work' });
    });

    it('async mutator 도 await 후 save', async () => {
      await mutateConfig(async (cfg) => {
        await Promise.resolve();
        cfg.active.gemini = 'g';
      });
      const cfg = await loadConfig();
      expect(cfg.active.gemini).toBe('g');
    });
  });

  describe('setActiveProfile / getActiveProfile / clearActiveProfile', () => {
    it('set → get round-trip', async () => {
      await setActiveProfile('codex', 'work');
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('미설정 cli 의 getActiveProfile 은 undefined', async () => {
      expect(await getActiveProfile('unknown')).toBeUndefined();
    });

    it('clear 후 get → undefined, 다른 cli 영향 없음', async () => {
      await setActiveProfile('codex', 'work');
      await setActiveProfile('claude', 'main');
      await clearActiveProfile('codex');
      expect(await getActiveProfile('codex')).toBeUndefined();
      expect(await getActiveProfile('claude')).toBe('main');
    });

    it('미설정 cli 를 clear 해도 에러 없음 (delete 의 멱등성)', async () => {
      await expect(clearActiveProfile('never-set')).resolves.toBeUndefined();
    });
  });

  describe('markFirstImportPromptShown', () => {
    it('첫 호출: firstImportPromptShown=true 로 기록', async () => {
      await markFirstImportPromptShown();
      const cfg = await loadConfig();
      expect(cfg.firstImportPromptShown).toBe(true);
    });

    it('두 번째 호출: 이미 true 면 멱등 (다른 state 변경 없음)', async () => {
      await markFirstImportPromptShown();
      await setActiveProfile('codex', 'work');  // 다른 상태 추가
      await markFirstImportPromptShown();        // 두 번째 호출

      const cfg = await loadConfig();
      expect(cfg.firstImportPromptShown).toBe(true);
      expect(cfg.active.codex).toBe('work');     // 영향 없음
    });
  });

  describe('cleanupTmpFiles', () => {
    it('데이터 디렉토리 없으면 best-effort no-op (에러 안 던짐)', async () => {
      // dataDir 자체가 존재하지 않는 시점에 호출.
      await expect(cleanupTmpFiles()).resolves.toBeUndefined();
    });

    it('.tmp 파일은 삭제, .tmp 아닌 파일은 보존', async () => {
      const base = dataDir();
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(base, 'stale.tmp'), 'tmp data');
      await fs.writeFile(join(base, 'config.json'), '{}');

      await cleanupTmpFiles();

      expect(existsSync(join(base, 'stale.tmp'))).toBe(false);
      expect(existsSync(join(base, 'config.json'))).toBe(true);
    });

    it('서브 디렉토리도 재귀로 .tmp 정리', async () => {
      const base = dataDir();
      const nested = join(base, 'profiles', 'codex', 'work');
      await fs.mkdir(nested, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(nested, 'auth.json'), '{"v":1}');
      await fs.writeFile(join(nested, 'auth.json.tmp'), 'partial');

      await cleanupTmpFiles();

      expect(existsSync(join(nested, 'auth.json'))).toBe(true);
      expect(existsSync(join(nested, 'auth.json.tmp'))).toBe(false);
    });

    it('symlink 는 추적하지 않음 (loop 방지 + out-of-scope 보호)', async () => {
      const base = dataDir();
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      // 외부 디렉토리 시뮬레이션: tmp 안에 별도 dir 만들고 그 안에 .tmp 둠.
      const outside = join(tmp.home, 'outside-dir');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(join(outside, 'should-not-be-deleted.tmp'), 'outside');

      // 데이터 디렉토리 안에서 outside 로 symlink.
      await fs.symlink(outside, join(base, 'link-to-outside'));

      await cleanupTmpFiles();

      // symlink 가 추적됐으면 outside 의 .tmp 가 지워졌을 것 — 보존되어야 한다.
      expect(existsSync(join(outside, 'should-not-be-deleted.tmp'))).toBe(true);
    });
  });
});
