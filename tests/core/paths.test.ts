import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cliLockPath,
  cliProfilesDir,
  configPath,
  dataDir,
  expandTilde,
  locksDir,
  profileDir,
  profileFilePath,
  profileMetaPath,
  profilesDir
} from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('paths', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  describe('dataDir 계열', () => {
    it('dataDir 는 ~/.multi-account-tool 이다', () => {
      expect(dataDir()).toBe(join(tmp.home, '.multi-account-tool'));
    });

    it('configPath / profilesDir / cliProfilesDir / profileDir / profileFilePath / profileMetaPath 는 dataDir 하위로 일관 구성된다', () => {
      const base = join(tmp.home, '.multi-account-tool');
      expect(configPath()).toBe(join(base, 'config.json'));
      expect(profilesDir()).toBe(join(base, 'profiles'));
      expect(cliProfilesDir('codex')).toBe(join(base, 'profiles', 'codex'));
      expect(profileDir('codex', 'work')).toBe(join(base, 'profiles', 'codex', 'work'));
      expect(profileFilePath('codex', 'work', 'auth.json')).toBe(
        join(base, 'profiles', 'codex', 'work', 'auth.json')
      );
      expect(profileMetaPath('codex', 'work')).toBe(
        join(base, 'profiles', 'codex', 'work', 'meta.json')
      );
    });

    it('locksDir 는 dataDir/locks 이다', () => {
      expect(locksDir()).toBe(join(tmp.home, '.multi-account-tool', 'locks'));
    });
  });

  describe('cliLockPath — SAFE_CLI_ID_RE 검증 (path traversal 방어)', () => {
    // 정상 case 도 [input, reason] 튜플로 통일 — it 제목에 의도 노출.
    // 'a' (1자, 최소) 와 'a'.repeat(32) (정확한 상한) 경계값 모두 포함 →
    // 정규식이 {0,30} 또는 {0,32} 로 잘못 바뀌어도 회귀 감지 가능 (Quad-review L+M).
    it.each([
      ['codex', '기본 cli'],
      ['claude', '하이픈 없는 영문'],
      ['my-cli', '하이픈 포함'],
      ['cli_2', '언더스코어 + 숫자'],
      ['a', '1글자 최소 경계'],
      ['a'.repeat(32), '정확히 32자 (상한 경계)']
    ])('정상 cliId 수락: %s (%s)', (id) => {
      expect(() => cliLockPath(id)).not.toThrow();
      expect(cliLockPath(id)).toBe(join(locksDir(), `${id}.lock`));
    });

    it.each([
      ['../etc/passwd', 'path traversal'],
      ['../../foo', 'nested traversal'],
      ['foo/bar', 'subdirectory separator'],
      ['', '빈 문자열'],
      ['1cli', '숫자 시작 (SAFE_CLI_ID_RE 의 [a-zA-Z] 위배)'],
      ['-cli', '하이픈 시작 (선두는 영문만)'],
      ['_cli', '언더스코어 시작 (선두는 영문만)'],
      ['cli.id', '점 포함 (path separator 위험)'],
      ['cli space', '공백 (shell 인자 분리 위험)'],
      ['cli\x00null', 'NUL 바이트 (path 종결자 우회)'],
      ['a'.repeat(33), '33자 (상한 32 초과)']
    ])('위험한 cliId 거부: %s (%s)', (id) => {
      expect(() => cliLockPath(id)).toThrow(/path segment/);
    });
  });

  describe('expandTilde', () => {
    it('단독 ~ 는 home 으로 치환', () => {
      expect(expandTilde('~')).toBe(homedir());
    });
    it('~/foo 는 home/foo 로 치환', () => {
      expect(expandTilde('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
    });
    it('절대경로는 그대로 반환', () => {
      expect(expandTilde('/etc/hosts')).toBe('/etc/hosts');
    });
    it('상대경로는 그대로 반환', () => {
      expect(expandTilde('foo/bar')).toBe('foo/bar');
    });
    it('~foo (슬래시 없음) 는 치환하지 않는다 (다른 사용자 디렉토리 해석 회피)', () => {
      expect(expandTilde('~foo')).toBe('~foo');
    });
  });
});
