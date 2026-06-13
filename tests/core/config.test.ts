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
  markFirstFreshnessPromptShown,
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

    it('파일 없을 때 firstImportPromptShown 은 undefined (명시)', async () => {
      const cfg = await loadConfig();
      expect(cfg.firstImportPromptShown).toBeUndefined();
    });

    it('파일에 firstImportPromptShown=false 면 false 로 보존', async () => {
      await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(configPath(), JSON.stringify({ version: 1, active: {}, firstImportPromptShown: false }));
      const cfg = await loadConfig();
      expect(cfg.firstImportPromptShown).toBe(false);
    });

    it('active 가 null 인 손상 shape → 빈 객체로 안전 처리 (parsed.active ?? {})', async () => {
      // production loadConfig 의 `parsed.active ?? {}` 가 null 도 빈 객체로 정규화.
      // 만약 누군가 ?? 를 || 로 바꿔도 동일 동작이지만, contract 명시 가치.
      await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(configPath(), JSON.stringify({ version: 1, active: null }));
      const cfg = await loadConfig();
      expect(cfg.active).toEqual({});
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

    it('mutator 가 throw 하면 save 안 됨 → 디스크 상태 원본 유지', async () => {
      // production contract: mutator throw 시 saveConfig 호출 안 됨 (try/catch 없음).
      // 따라서 부분 mutation 이 디스크에 누출되지 않음 — atomic 의도된 안전성.
      await saveConfig({ version: 1, active: { codex: 'pristine' } });

      await expect(
        mutateConfig((cfg) => {
          cfg.active.codex = 'mutated-but-should-not-save';
          throw new Error('mutator failure');
        })
      ).rejects.toThrow('mutator failure');

      const cfg = await loadConfig();
      expect(cfg.active.codex).toBe('pristine');
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

  describe('markFirstFreshnessPromptShown (PR-G)', () => {
    it('첫 호출: firstFreshnessPromptShown=true 로 기록', async () => {
      await markFirstFreshnessPromptShown();
      const cfg = await loadConfig();
      expect(cfg.firstFreshnessPromptShown).toBe(true);
    });

    it('두 번째 호출: 이미 true 면 멱등 (다른 state 변경 없음)', async () => {
      await markFirstFreshnessPromptShown();
      await setActiveProfile('codex', 'work');
      await markFirstFreshnessPromptShown();

      const cfg = await loadConfig();
      expect(cfg.firstFreshnessPromptShown).toBe(true);
      expect(cfg.active.codex).toBe('work');
    });

    it('firstImportPromptShown 과 독립 — 한쪽 set 가 다른 쪽 영향 없음', async () => {
      await markFirstImportPromptShown();
      const cfg1 = await loadConfig();
      expect(cfg1.firstImportPromptShown).toBe(true);
      expect(cfg1.firstFreshnessPromptShown).toBeUndefined();

      await markFirstFreshnessPromptShown();
      const cfg2 = await loadConfig();
      expect(cfg2.firstImportPromptShown).toBe(true);
      expect(cfg2.firstFreshnessPromptShown).toBe(true);
    });

    it('파일에 firstFreshnessPromptShown=false 면 false 로 보존 (round-trip)', async () => {
      await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        configPath(),
        JSON.stringify({ version: 1, active: {}, firstFreshnessPromptShown: false })
      );
      const cfg = await loadConfig();
      expect(cfg.firstFreshnessPromptShown).toBe(false);
    });
  });

  describe('cleanupTmpFiles', () => {
    it('데이터 디렉토리 없으면 best-effort no-op (에러 안 던짐)', async () => {
      // dataDir 자체가 존재하지 않는 시점에 호출.
      await expect(cleanupTmpFiles()).resolves.toBeUndefined();
    });

    it('앱 소유 atomic tmp 파일만 삭제하고 합법 tmp-like 파일은 보존', async () => {
      const base = dataDir();
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(base, 'stale.tmp'), 'tmp data');
      await fs.writeFile(join(base, 'config.json.tmp-123-abcdefabcdefabcd'), 'secret tmp data');
      await fs.writeFile(join(base, '.mat-atomic@123-abcdefabcdefabcd.tmp'), 'secret tmp data');
      await fs.writeFile(join(base, 'config.json'), '{}');
      await fs.writeFile(join(base, 'keep.tmp-notatomic'), 'not atomic tmp');

      await cleanupTmpFiles();

      expect(existsSync(join(base, 'stale.tmp'))).toBe(true);
      expect(existsSync(join(base, 'config.json.tmp-123-abcdefabcdefabcd'))).toBe(true);
      expect(existsSync(join(base, '.mat-atomic@123-abcdefabcdefabcd.tmp'))).toBe(false);
      expect(existsSync(join(base, 'config.json'))).toBe(true);
      expect(existsSync(join(base, 'keep.tmp-notatomic'))).toBe(true);
    });

    it('서브 디렉토리도 재귀로 앱 소유 atomic tmp 만 정리', async () => {
      const base = dataDir();
      const nested = join(base, 'profiles', 'codex', 'work');
      await fs.mkdir(nested, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(nested, 'auth.json'), '{"v":1}');
      await fs.writeFile(join(nested, 'auth.json.tmp'), 'partial');
      await fs.writeFile(join(nested, 'auth.json.tmp-456-0123456789abcdef'), 'partial nonce');
      await fs.writeFile(join(nested, '.mat-atomic@456-0123456789abcdef.tmp'), 'partial nonce');

      await cleanupTmpFiles();

      expect(existsSync(join(nested, 'auth.json'))).toBe(true);
      expect(existsSync(join(nested, 'auth.json.tmp'))).toBe(true);
      expect(existsSync(join(nested, 'auth.json.tmp-456-0123456789abcdef'))).toBe(true);
      expect(existsSync(join(nested, '.mat-atomic@456-0123456789abcdef.tmp'))).toBe(false);
    });

    it('symlink 는 추적하지 않음 (out-of-scope 보호) + symlink 자체도 잔존', async () => {
      const base = dataDir();
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const outside = join(tmp.home, 'outside-dir');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(join(outside, '.mat-atomic@999-abcdefabcdefabcd.tmp'), 'outside');

      const linkPath = join(base, 'link-to-outside');
      await fs.symlink(outside, linkPath);

      await cleanupTmpFiles();

      // 두 가지 invariant 명시:
      //  1) symlink 추적 안 함 → outside 의 app-owned tmp-looking 파일도 보존
      //  2) symlink 자체는 'continue' 로 skip → link 도 base 에 남음 (정리 대상 아님)
      expect(existsSync(join(outside, '.mat-atomic@999-abcdefabcdefabcd.tmp'))).toBe(true);
      expect(existsSync(linkPath)).toBe(true);
      const linkStat = await fs.lstat(linkPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
    });

    it('서브 디렉토리 readdir 실패 (chmod 000) → 안쪽 catch 가 무시, sibling .tmp 정리 계속', async () => {
      // walkAndCleanTmp 의 inner try/catch (line 105) 가 fs.readdir 실패를 잡고 silent return.
      // 권한 거부 dir 안의 .tmp 는 정리 못 하지만 sibling 정리는 계속되어야 한다 (best-effort).
      const base = dataDir();
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const denied = join(base, 'denied-dir');
      await fs.mkdir(denied, { mode: 0o700 });
      await fs.writeFile(join(denied, '.mat-atomic@111-abcdefabcdefabcd.tmp'), 'cannot-access');
      await fs.writeFile(join(base, '.mat-atomic@222-abcdefabcdefabcd.tmp'), 'normal');

      // CI runner 가 root 이면 chmod 0o000 이 무시되어 readdir 가 성공 — 그 경우 본 테스트 skip.
      await fs.chmod(denied, 0o000);
      try {
        await fs.readdir(denied);
        // 여기 도달하면 readdir 가 성공 (= root) → 테스트 의도 무효, skip.
        return;
      } catch { /* EACCES 기대대로 발생 — 진행 */ }

      try {
        await expect(cleanupTmpFiles()).resolves.toBeUndefined();
        // sibling 은 정리됨
        expect(existsSync(join(base, '.mat-atomic@222-abcdefabcdefabcd.tmp'))).toBe(false);
        // denied dir 자체는 보존 (안쪽 못 들어가 정리 못 함)
        expect(existsSync(denied)).toBe(true);
      } finally {
        // tmp.cleanup() 이 dir 삭제할 수 있게 권한 복구.
        await fs.chmod(denied, 0o700).catch(() => { /* best-effort, root 아니면 OK */ });
      }
    });
  });
});
