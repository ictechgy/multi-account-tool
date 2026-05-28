import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appLogPath,
  cliLockPath,
  cliProfilesDir,
  configPath,
  dataDir,
  expandTilde,
  locksDir,
  profileDir,
  profileFilePath,
  profileMetaPath,
  profilesDir,
  validateCliId,
  validateProfileFileName,
  validateProfileName
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

    it('PR-R: appLogPath 는 dataDir/app.log 이다 (TUI best-effort 로그 — Ink 충돌 회피)', () => {
      // 옛 코드: persist 실패 시 process.stderr.write → Ink alternate-buffer 충돌 가능.
      // 새 코드: dataDir/app.log 에 append. 본 path 헬퍼가 일관된 위치 제공.
      expect(appLogPath()).toBe(join(tmp.home, '.multi-account-tool', 'app.log'));
    });
  });

  describe('validateCliId — 공용 cliId path-safety 가드 (cliLockPath 와 동일 규칙)', () => {
    // validateCliId 는 cliLockPath 의 SAFE_CLI_ID_RE 가드를 공개 헬퍼로 export 한 것.
    // profile-store 등 다른 호출자가 동일 가드를 재사용하기 위함.
    // cliLockPath 의 it.each 와 같은 케이스를 통과/거부해야 한다 (회귀 일치 보장).
    it.each([
      ['codex', '기본 cli'],
      ['claude', '하이픈 없는 영문'],
      ['my-cli', '하이픈 포함'],
      ['cli_2', '언더스코어 + 숫자'],
      ['a', '1글자 최소 경계'],
      ['a'.repeat(32), '32자 상한 경계']
    ])('정상 cliId 통과 → 동일 값 반환: %s (%s)', (id, _reason) => {
      expect(validateCliId(id)).toBe(id);
    });

    it.each([
      ['../etc/passwd', 'path traversal'],
      ['foo/bar', 'subdirectory separator'],
      ['', '빈 문자열'],
      ['1cli', '숫자 시작'],
      ['cli.id', '점 포함'],
      ['cli space', '공백'],
      ['cli\x00null', 'NUL 바이트'],
      ['a'.repeat(33), '33자 (상한 +1)']
    ])('위험한 cliId throw: %s (%s)', (id, _reason) => {
      expect(() => validateCliId(id)).toThrow(/path segment/);
    });
  });

  describe('cliLockPath — SAFE_CLI_ID_RE 검증 (path traversal 방어)', () => {
    // 정상/위험 case 모두 [input, reason] 튜플로 통일 — it 제목에 의도 노출.
    // 'a' (1자, 최소) 와 'a'.repeat(32) (정확한 상한) 경계값 + 'a'.repeat(33) (상한 +1) →
    // 정규식이 {0,30} 또는 {0,32} 로 잘못 바뀌어도 양방향 회귀 감지 가능.
    // 콜백은 `(id, _reason)` 으로 두 인자 모두 받아 it.each 의 tuple 매핑 의도를 명시.
    it.each([
      ['codex', '기본 cli'],
      ['claude', '하이픈 없는 영문'],
      ['my-cli', '하이픈 포함'],
      ['cli_2', '언더스코어 + 숫자'],
      ['a', '1글자 최소 경계'],
      ['a'.repeat(32), '정확히 32자 (상한 경계 — 허용)']
    ])('정상 cliId 수락: %s (%s)', (id, _reason) => {
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
    ])('위험한 cliId 거부: %s (%s)', (id, _reason) => {
      expect(() => cliLockPath(id)).toThrow(/path segment/);
    });
  });

  describe('typeof string guard (3 validators 모두) — PR #10 quad-review Codex-2', () => {
    // RegExp.test() 가 비문자열을 string 으로 강제 변환 → null/undefined/true 가
    // 'null'/'undefined'/'true' 로 regex 통과할 수 있는 corner case.
    // TypeScript strict 가 컴파일 타임만 보장하므로 unknown cast / dynamic import / JSON 경계 방어용.
    const BAD_TYPES: [unknown, string][] = [
      [null, 'null'],
      [undefined, 'undefined'],
      [true, 'boolean true'],
      [123, 'number'],
      [{}, 'object'],
      [[], 'array'],
      [Symbol('s'), 'symbol'],
      [10n, 'bigint'],
      [() => 'x', 'function']
    ];

    it.each(BAD_TYPES)('validateCliId 비문자열 throw: %s (%s)', (bad, _r) => {
      expect(() => validateCliId(bad as string)).toThrow(/문자열/);
    });

    it.each(BAD_TYPES)('validateProfileName 비문자열 throw: %s (%s)', (bad, _r) => {
      expect(() => validateProfileName(bad as string)).toThrow(/문자열/);
    });

    it.each(BAD_TYPES)('validateProfileFileName 비문자열 throw: %s (%s)', (bad, _r) => {
      expect(() => validateProfileFileName(bad as string)).toThrow(/문자열/);
    });
  });

  describe('path constructor 직접 호출 traversal 방어 — PR #10 quad-review Codex-1', () => {
    // 이전 버전: validateCliId 가 cliLockPath 에만 적용 → profile-store 우회해
    // paths.ts 의 cliProfilesDir/profileDir/profileFilePath/profileMetaPath 를 직접
    // import 하는 호출자는 untrusted cliId 로 traversal 가능했음.
    // 새 정책: 모든 path constructor 가 입력 자체 검증.

    it.each([
      ['cliProfilesDir', () => cliProfilesDir('../escape')],
      ['profileDir cliId', () => profileDir('../escape', 'work')],
      ['profileDir name', () => profileDir('codex', '../escape')],
      ['profileFilePath cliId', () => profileFilePath('../escape', 'work', 'auth.json')],
      ['profileFilePath name', () => profileFilePath('codex', '../escape', 'auth.json')],
      ['profileFilePath fileName', () => profileFilePath('codex', 'work', '../escape.json')],
      ['profileMetaPath cliId', () => profileMetaPath('../escape', 'work')],
      ['profileMetaPath name', () => profileMetaPath('codex', '../escape')]
    ])('%s traversal 입력 → throw', (_label, fn) => {
      expect(fn).toThrow();
    });

    it('정상 입력은 모두 통과 (회귀 가드)', () => {
      expect(() => cliProfilesDir('codex')).not.toThrow();
      expect(() => profileDir('codex', 'work')).not.toThrow();
      expect(() => profileFilePath('codex', 'work', 'auth.json')).not.toThrow();
      expect(() => profileMetaPath('codex', 'work')).not.toThrow();
    });

    it('profileDir 는 NFC 정규화된 경로 반환 (NFD 입력 → NFC 디렉토리)', () => {
      const nfd = '가'.normalize('NFD');
      const nfc = '가'.normalize('NFC');
      expect(profileDir('codex', nfd)).toBe(profileDir('codex', nfc));
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
