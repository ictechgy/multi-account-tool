/**
 * profile-store 단위 테스트.
 *
 * 10 함수의 happy-path + 주요 edge case 검증:
 *   validateProfileName / listProfiles / profileExists /
 *   createProfile / readMeta / touchProfile / renameProfile / deleteProfile /
 *   readProfileFile / writeProfileFile
 *
 * io-atomic + paths 의존으로 real fs 통합 테스트. setupTmpHome 으로 $HOME 격리.
 */

import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProfile,
  deleteProfile,
  listProfiles,
  profileExists,
  readMeta,
  readProfileFile,
  renameProfile,
  touchProfile,
  validateProfileFileName,
  validateProfileName,
  writeProfileFile
} from '../../src/core/profile-store.js';
import {
  cliProfilesDir,
  profileDir,
  profileFilePath,
  profileMetaPath
} from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('profile-store', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  describe('validateProfileName', () => {
    it.each([
      ['work', '영문'],
      ['일하기', '한글'],
      ['user_2', '언더스코어 + 숫자'],
      ['my-cli', '하이픈'],
      ['v1.0', '점 포함'],
      ['a', '1자 최소'],
      ['a'.repeat(40), '40자 상한 경계'],
      ['MixedCase123', '대소문자 + 숫자']
    ])('정상 이름 수락 (NFC 정규화 후 반환): %s (%s)', (name, _reason) => {
      expect(validateProfileName(name)).toBe(name.normalize('NFC'));
    });

    it.each([
      ['.', '예약된 단일 점'],
      ['..', '예약된 더블 점'],
      ['foo/bar', 'forward slash'],
      ['foo\\bar', 'backslash'],
      ['foo\x00bar', 'NUL 바이트'],
      ['', '빈 문자열'],
      ['a'.repeat(41), '41자 (상한 초과)'],
      ['foo bar', '공백'],
      ['foo*bar', 'glob 문자'],
      ['foo?bar', 'glob ?'],
      ['foo:bar', '콜론']
    ])('위험한 이름 거부: %s (%s)', (name, _reason) => {
      expect(() => validateProfileName(name)).toThrow();
    });

    it('NFD 한글 입력은 NFC 로 정규화되어 반환', () => {
      // 'ㄱ' + 'ㅏ' (NFD) → '가' (NFC). 같은 사용자 표기지만 byte 다름.
      const nfd = '가'.normalize('NFD');  // 'ᄀ' + 'ᅡ' (2 codepoints)
      const nfc = '가'.normalize('NFC');  // '가' (1 codepoint)
      expect(nfd).not.toBe(nfc);  // 입력은 다른 byte sequence
      expect(validateProfileName(nfd)).toBe(nfc);  // 출력은 NFC 통일
    });
  });

  describe('listProfiles', () => {
    it('CLI 디렉토리 없으면 [] 반환 (ENOENT)', async () => {
      expect(await listProfiles('codex')).toEqual([]);
    });

    it('정상 디렉토리들만 알파벳 순으로 반환', async () => {
      await fs.mkdir(profileDir('codex', 'work'), { recursive: true });
      await fs.mkdir(profileDir('codex', 'home'), { recursive: true });
      await fs.mkdir(profileDir('codex', 'side'), { recursive: true });
      expect(await listProfiles('codex')).toEqual(['home', 'side', 'work']);
    });

    it('non-ENOENT 에러 (ENOTDIR) → throw 전파 (catch 분기 회귀 가드)', async () => {
      // cliProfilesDir 경로를 일반 파일로 만들면 fs.readdir 가 ENOTDIR 로 throw.
      // ENOENT swallow 분기 외 throw 분기 (profile-store.ts line 43) 회귀 가드.
      const profilesRoot = join(tmp.home, '.multi-account-tool', 'profiles');
      await fs.mkdir(profilesRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(cliProfilesDir('codex'), 'not-a-directory');
      await expect(listProfiles('codex')).rejects.toThrow();
    });

    it('일반 file 은 결과에서 제외 (디렉토리만)', async () => {
      const base = cliProfilesDir('codex');
      await fs.mkdir(base, { recursive: true });
      await fs.mkdir(join(base, 'real-profile'));
      await fs.writeFile(join(base, 'stray-file.json'), '{}');
      expect(await listProfiles('codex')).toEqual(['real-profile']);
    });
  });

  describe('profileExists', () => {
    it('디렉토리 있으면 true', async () => {
      await fs.mkdir(profileDir('codex', 'work'), { recursive: true });
      expect(await profileExists('codex', 'work')).toBe(true);
    });

    it('디렉토리 없으면 false', async () => {
      expect(await profileExists('codex', 'absent')).toBe(false);
    });
  });

  describe('createProfile', () => {
    it('디렉토리 (0o700) + meta.json 생성, Profile 반환', async () => {
      const profile = await createProfile('codex', 'work', '내 작업');

      expect(profile.name).toBe('work');
      expect(profile.cli).toBe('codex');
      expect(profile.label).toBe('내 작업');
      expect(profile.createdAt).toBe(profile.updatedAt);

      const dirStat = await fs.stat(profileDir('codex', 'work'));
      expect(dirStat.mode & 0o777).toBe(0o700);

      const metaStat = await fs.stat(profileMetaPath('codex', 'work'));
      expect(metaStat.mode & 0o777).toBe(0o600);

      const persisted = JSON.parse(await fs.readFile(profileMetaPath('codex', 'work'), 'utf8'));
      expect(persisted).toEqual(profile);
    });

    it('label 생략하면 meta.label 도 undefined', async () => {
      const profile = await createProfile('codex', 'no-label');
      expect(profile.label).toBeUndefined();
    });

    it('이미 존재하는 프로필 → throw', async () => {
      await createProfile('codex', 'work');
      await expect(createProfile('codex', 'work')).rejects.toThrow(/이미 존재하는 프로필/);
    });

    it('잘못된 이름 → validateProfileName 단계에서 throw, 디렉토리 미생성', async () => {
      await expect(createProfile('codex', '../escape')).rejects.toThrow();
      expect(existsSync(join(cliProfilesDir('codex'), '../escape'))).toBe(false);
    });

    describe('writeMeta 실패 시 디렉토리 rollback (vi.doMock io-atomic)', () => {
      // doMock + dynamic import 격리 패턴 — migrate.test.ts 의 renameSync 실패 분기와 동일 스타일.
      // beforeEach 에서 vi.resetModules() 먼저 호출해 doMock 효과가 dynamic import 에 정확히 적용.
      beforeEach(() => { vi.resetModules(); });
      afterEach(() => {
        vi.doUnmock('../../src/core/io-atomic.js');
        vi.doUnmock('node:fs');
        vi.resetModules();
      });

      it('writeFileAtomic throw → 생성된 디렉토리 롤백 (partial state 방지)', async () => {
        // 디스크 풀/권한 거부 등으로 writeMeta 가 실패하는 시나리오. renameProfile 과 동일하게
        // catch 에서 best-effort 롤백 → 디렉토리만 남는 부분 상태가 발생하지 않는다.
        const writeMock = vi.fn(async () => { throw new Error('simulated disk full'); });
        vi.doMock('../../src/core/io-atomic.js', async () => {
          const actual = await vi.importActual<typeof import('../../src/core/io-atomic.js')>(
            '../../src/core/io-atomic.js'
          );
          return { ...actual, writeFileAtomic: writeMock };
        });

        const { createProfile: cp } = await import('../../src/core/profile-store.js');
        const { profileDir: pd } = await import('../../src/core/paths.js');

        await expect(cp('codex', 'doomed')).rejects.toThrow(/simulated disk full/);
        expect(writeMock).toHaveBeenCalledOnce();
        // 핵심 회귀 가드: 디렉토리가 남아있지 않아야 (rollback 동작).
        expect(existsSync(pd('codex', 'doomed'))).toBe(false);
      });

      it('rollback 실패해도 원본 writeMeta 에러를 전파 (롤백 swallow 분기)', async () => {
        // fs.rm 자체가 실패하는 극단 시나리오를 시뮬: writeFileAtomic 후 fs.rm 도 throw 하게 만든다.
        // best-effort 패턴이므로 롤백 실패는 swallow 되고 원본 에러만 호출자가 받는다.
        const writeMock = vi.fn(async () => { throw new Error('write fail'); });
        const rmMock = vi.fn(async () => { throw new Error('rollback fail (should be swallowed)'); });
        vi.doMock('../../src/core/io-atomic.js', async () => {
          const actual = await vi.importActual<typeof import('../../src/core/io-atomic.js')>(
            '../../src/core/io-atomic.js'
          );
          return { ...actual, writeFileAtomic: writeMock };
        });
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            promises: { ...actual.promises, rm: rmMock }
          };
        });

        const { createProfile: cp } = await import('../../src/core/profile-store.js');

        await expect(cp('codex', 'rollback-fail')).rejects.toThrow(/write fail/);
        expect(writeMock).toHaveBeenCalledOnce();
        expect(rmMock).toHaveBeenCalledOnce();
      });
    });
  });

  describe('readMeta', () => {
    it('존재 → Profile 반환', async () => {
      const created = await createProfile('codex', 'work', 'L');
      const meta = await readMeta('codex', 'work');
      expect(meta).toEqual(created);
    });

    it('meta 없으면 null', async () => {
      expect(await readMeta('codex', 'no-such')).toBeNull();
    });

    it('corrupt JSON 은 throw (ENOENT 외 에러 전파, runtime validation 부재 명시)', async () => {
      // production readMeta 의 catch 는 ENOENT 만 swallow → SyntaxError 가 그대로 전파.
      // 또한 runtime validation 없이 JSON.parse 결과를 `as Profile` 로 cast — 잘못된 shape
      // 는 type-level 에서만 차단되고 디스크가 망가지면 caller 가 unsafe object 받음.
      await fs.mkdir(profileDir('codex', 'corrupt'), { recursive: true, mode: 0o700 });
      await fs.writeFile(profileMetaPath('codex', 'corrupt'), 'not-json{{{');
      await expect(readMeta('codex', 'corrupt')).rejects.toThrow();
    });
  });

  describe('touchProfile', () => {
    it('정상: updatedAt 만 갱신 (createdAt 보존, strict-greater 시간 검증)', async () => {
      const created = await createProfile('codex', 'work');
      // ISO 8601 millisecond 정밀도. 20ms 대기로 OS scheduling 변동 흡수.
      await new Promise((r) => setTimeout(r, 20));
      await touchProfile('codex', 'work');
      const meta = await readMeta('codex', 'work');
      expect(meta?.createdAt).toBe(created.createdAt);
      // strict-greater: `>=` 면 동일 timestamp 도 통과해 "갱신됐다" 의도가 약함.
      expect(new Date(meta!.updatedAt).getTime())
        .toBeGreaterThan(new Date(created.updatedAt).getTime());
    });

    it('meta 없으면 no-op (throw 안 함)', async () => {
      await expect(touchProfile('codex', 'never-created')).resolves.toBeUndefined();
    });
  });

  describe('renameProfile', () => {
    it('정상: 디렉토리 rename + meta.name + updatedAt 갱신 (strict-greater 시간 검증)', async () => {
      const created = await createProfile('codex', 'old-profile', 'Legacy Label');
      await new Promise((r) => setTimeout(r, 20));
      await renameProfile('codex', 'old-profile', 'new-profile');

      expect(existsSync(profileDir('codex', 'old-profile'))).toBe(false);
      expect(existsSync(profileDir('codex', 'new-profile'))).toBe(true);
      const meta = await readMeta('codex', 'new-profile');
      expect(meta?.name).toBe('new-profile');
      expect(meta?.createdAt).toBe(created.createdAt);
      expect(new Date(meta!.updatedAt).getTime())
        .toBeGreaterThan(new Date(created.updatedAt).getTime());
      expect(meta?.label).toBe('Legacy Label');
    });

    it('같은 이름 → no-op (rename 안 함, 디스크 무변경)', async () => {
      const created = await createProfile('codex', 'same');
      await renameProfile('codex', 'same', 'same');
      const meta = await readMeta('codex', 'same');
      expect(meta?.updatedAt).toBe(created.updatedAt);
    });

    it('새 이름 이미 존재 → throw, 원본 보존', async () => {
      await createProfile('codex', 'a');
      await createProfile('codex', 'b');
      await expect(renameProfile('codex', 'a', 'b')).rejects.toThrow(/이미 존재/);
      expect(existsSync(profileDir('codex', 'a'))).toBe(true);
      expect(existsSync(profileDir('codex', 'b'))).toBe(true);
    });

    it('잘못된 새 이름 → validateProfileName throw, 디스크 무변경', async () => {
      await createProfile('codex', 'a');
      await expect(renameProfile('codex', 'a', '../escape')).rejects.toThrow();
      expect(existsSync(profileDir('codex', 'a'))).toBe(true);
    });

    it('meta.json 누락 (디렉토리만 존재) → rename 성공, writeMeta 미호출 (if(meta) else 분기 가드)', async () => {
      // readMeta 가 ENOENT 로 null 반환 → renameProfile 의 `if (meta)` false 분기.
      // 디렉토리 rename 만 수행하고 writeMeta 는 호출 안 함. 사용자가 meta 를 수동 삭제한 시나리오.
      await fs.mkdir(profileDir('codex', 'no-meta'), { recursive: true, mode: 0o700 });
      await renameProfile('codex', 'no-meta', 'renamed');
      expect(existsSync(profileDir('codex', 'no-meta'))).toBe(false);
      expect(existsSync(profileDir('codex', 'renamed'))).toBe(true);
      // meta.json 은 여전히 없어야 (writeMeta 미호출 검증).
      expect(existsSync(profileMetaPath('codex', 'renamed'))).toBe(false);
    });

    it('rollback (line 129-132): 손상된 meta.json 으로 readMeta throw → 디렉토리 rename 원복', async () => {
      // createProfile 로 정상 디렉토리 생성 후, 외부에서 meta.json 을 invalid JSON 으로 손상.
      // renameProfile 의 fs.rename 은 성공하지만, readMeta 의 JSON.parse 가 throw 하면
      // catch 분기에서 디렉토리를 원래 이름으로 rollback 해야 한다.
      // io-atomic mock 없이 real fs 통합으로 동일 분기 도달 (writeMeta 가 아니라 readMeta 가 throw).
      await createProfile('codex', 'src');
      await fs.writeFile(profileMetaPath('codex', 'src'), 'not-valid-json{{{', { mode: 0o600 });

      await expect(renameProfile('codex', 'src', 'dst')).rejects.toThrow();

      // rollback 결과: 원본 디렉토리 복구, 새 이름 디렉토리 없음.
      expect(existsSync(profileDir('codex', 'src'))).toBe(true);
      expect(existsSync(profileDir('codex', 'dst'))).toBe(false);
    });
  });

  describe('deleteProfile', () => {
    it('디렉토리 + 내용 모두 삭제', async () => {
      await createProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', '{"v":1}');
      expect(existsSync(profileFilePath('codex', 'work', 'auth.json'))).toBe(true);

      await deleteProfile('codex', 'work');
      expect(existsSync(profileDir('codex', 'work'))).toBe(false);
    });

    it('없는 프로필 삭제 → 에러 없음 (force: true)', async () => {
      await expect(deleteProfile('codex', 'never-existed')).resolves.toBeUndefined();
    });

    it('중첩 디렉토리 + 다수 파일이 있어도 recursive 로 모두 삭제', async () => {
      // production fs.rm(recursive: true) 동작 검증 — 단순 single file 보다 강한 보장.
      const target = profileDir('codex', 'multi');
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(target, 'auth.json'), '{}');
      await fs.writeFile(join(target, 'meta.json'), '{}');
      const subdir = join(target, 'sub');
      await fs.mkdir(subdir);
      await fs.writeFile(join(subdir, 'nested-data.json'), '{}');
      await fs.writeFile(join(subdir, 'other.json'), '{}');

      await deleteProfile('codex', 'multi');
      expect(existsSync(target)).toBe(false);
    });
  });

  describe('readProfileFile / writeProfileFile', () => {
    it('round-trip', async () => {
      await createProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', '{"token":"abc"}');
      expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('{"token":"abc"}');
    });

    it('writeProfileFile: 프로필 디렉토리 없어도 자동 생성 (권한 0o700)', async () => {
      // createProfile 미호출 — writeProfileFile 가 디렉토리 만들어야.
      await writeProfileFile('codex', 'auto-created', 'data.json', '{}');
      expect(existsSync(profileDir('codex', 'auto-created'))).toBe(true);
      expect(await readProfileFile('codex', 'auto-created', 'data.json')).toBe('{}');
      // auto-create 분기도 createProfile 과 동일하게 0o700 보안 권한 보장.
      const dirStat = await fs.stat(profileDir('codex', 'auto-created'));
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it('writeProfileFile: 파일 권한 0o600 (atomic write 위임)', async () => {
      await writeProfileFile('codex', 'work', 'auth.json', '{}');
      const stat = await fs.stat(profileFilePath('codex', 'work', 'auth.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('readProfileFile: 없으면 null (ENOENT swallow)', async () => {
      expect(await readProfileFile('codex', 'work', 'never.json')).toBeNull();
    });

    it('readProfileFile: non-ENOENT 에러 (EISDIR) → throw 전파 (catch 분기 회귀 가드)', async () => {
      // 파일 path 를 디렉토리로 만들면 fs.readFile 가 EISDIR 로 throw.
      // ENOENT swallow 분기 외 throw 분기 (profile-store.ts readProfileFile catch) 회귀 가드.
      await createProfile('codex', 'work');
      await fs.mkdir(profileFilePath('codex', 'work', 'auth.json'), { recursive: true });
      await expect(readProfileFile('codex', 'work', 'auth.json')).rejects.toThrow();
    });
  });

  describe('validateProfileFileName', () => {
    it.each([
      ['auth.json', '기본 saveAs'],
      ['credentials.json', 'claude saveAs'],
      ['oauth_creds.json', 'gemini saveAs'],
      ['file-1.json', '하이픈 + 숫자'],
      ['a', '1자 최소 경계'],
      ['a'.repeat(64), '64자 상한 경계'],
      ['.hiddenfile', '선행 점 (Unix dotfile, 화이트리스트 매치)'],
      ['file.tar.gz', '복수 점']
    ])('정상 파일명 통과 → 동일 값 반환: %s (%s)', (fileName, _reason) => {
      expect(validateProfileFileName(fileName)).toBe(fileName);
    });

    it.each([
      ['.', '예약된 단일 점'],
      ['..', '예약된 더블 점'],
      ['../escape.json', 'parent traversal'],
      ['../../etc/passwd', '다중 traversal'],
      ['sub/file.json', 'forward slash (subdirectory)'],
      ['sub\\file.json', 'backslash'],
      ['file\x00.json', 'NUL 바이트'],
      ['', '빈 문자열'],
      ['a'.repeat(65), '65자 (상한 +1)'],
      ['file name.json', '공백'],
      ['file*.json', 'glob 별표'],
      ['file?.json', 'glob 물음표'],
      ['한글파일.json', '한글 (saveAs 는 영문/숫자만 — profile name 보다 엄격)'],
      [':file.json', '콜론']
    ])('위험한 파일명 throw: %s (%s)', (fileName, _reason) => {
      expect(() => validateProfileFileName(fileName)).toThrow();
    });
  });

  describe('cliId 검증 (defense-in-depth: 모든 public 함수)', () => {
    // 모든 public 함수가 validateCliId 를 내부 호출 — 호출자의 신뢰성과 무관하게
    // path traversal cliId (`../escape`) 가 들어와도 절대 파일시스템 mutation 발생 안 함.
    const BAD_CLI = '../escape';

    it('listProfiles: cliId traversal → throw, fs 접근 안 함', async () => {
      await expect(listProfiles(BAD_CLI)).rejects.toThrow(/path segment/);
    });

    it('profileExists: cliId traversal → throw', async () => {
      await expect(profileExists(BAD_CLI, 'work')).rejects.toThrow(/path segment/);
    });

    it('createProfile: cliId traversal → throw, 디렉토리 미생성', async () => {
      await expect(createProfile(BAD_CLI, 'work')).rejects.toThrow(/path segment/);
      expect(existsSync(join(tmp.home, '.multi-account-tool', 'profiles', '..', 'escape'))).toBe(false);
    });

    it('readMeta: cliId traversal → throw', async () => {
      await expect(readMeta(BAD_CLI, 'work')).rejects.toThrow(/path segment/);
    });

    it('touchProfile: cliId traversal → throw', async () => {
      await expect(touchProfile(BAD_CLI, 'work')).rejects.toThrow(/path segment/);
    });

    it('renameProfile: cliId traversal → throw, 원본 보존', async () => {
      await createProfile('codex', 'src');
      await expect(renameProfile(BAD_CLI, 'src', 'dst')).rejects.toThrow(/path segment/);
      expect(existsSync(profileDir('codex', 'src'))).toBe(true);
    });

    it('deleteProfile: cliId traversal → throw, fs.rm 호출 안 함', async () => {
      await expect(deleteProfile(BAD_CLI, 'work')).rejects.toThrow(/path segment/);
    });

    it('readProfileFile: cliId traversal → throw', async () => {
      await expect(readProfileFile(BAD_CLI, 'work', 'auth.json')).rejects.toThrow(/path segment/);
    });

    it('writeProfileFile: cliId traversal → throw, 파일 미생성', async () => {
      await expect(writeProfileFile(BAD_CLI, 'work', 'auth.json', '{}')).rejects.toThrow(/path segment/);
    });
  });

  describe('profile name 검증 강제 (회귀 가드: 모든 public 함수가 validateProfileName 호출)', () => {
    // 이전 버전: createProfile/renameProfile 만 new name 검증, 나머지는 무방비.
    // 새 버전: 모든 함수가 input name 을 검증 → traversal name 으로 escape 불가.
    const BAD_NAMES = ['../escape', '../../etc/passwd', 'foo/bar', 'foo\\bar', '.', '..', 'foo\x00bar', ''];

    it.each(BAD_NAMES)('profileExists("%s") → throw (디렉토리 escape 안 함)', async (badName) => {
      await expect(profileExists('codex', badName)).rejects.toThrow();
    });

    it.each(BAD_NAMES)('readMeta("%s") → throw', async (badName) => {
      await expect(readMeta('codex', badName)).rejects.toThrow();
    });

    it.each(BAD_NAMES)('touchProfile("%s") → throw', async (badName) => {
      await expect(touchProfile('codex', badName)).rejects.toThrow();
    });

    it.each(BAD_NAMES)('deleteProfile("%s") → throw (catastrophic fs.rm 차단)', async (badName) => {
      // 가장 위험한 경로: deleteProfile 은 { recursive: true, force: true } 이므로
      // 검증 없이 `../../etc` 가 들어오면 사용자 데이터 영구 손실. 절대 mutation 발생 안 함.
      await expect(deleteProfile('codex', badName)).rejects.toThrow();
    });

    it.each(BAD_NAMES)('renameProfile(oldName="%s") → throw, 디스크 무변경', async (badName) => {
      await expect(renameProfile('codex', badName, 'valid')).rejects.toThrow();
    });

    it.each(BAD_NAMES)('readProfileFile("%s") → throw', async (badName) => {
      await expect(readProfileFile('codex', badName, 'auth.json')).rejects.toThrow();
    });

    it.each(BAD_NAMES)('writeProfileFile("%s") → throw, 파일 미생성', async (badName) => {
      await expect(writeProfileFile('codex', badName, 'auth.json', '{}')).rejects.toThrow();
    });

    it('catastrophic 시나리오: deleteProfile("../codex") 로 형제 cli 디렉토리 삭제 시도 — 차단되어야', async () => {
      await createProfile('codex', 'sibling');
      const sibling = profileDir('codex', 'sibling');
      expect(existsSync(sibling)).toBe(true);
      // claude/sibling 디렉토리는 없지만, name='../codex/sibling' 이 통과하면 codex/sibling 이 삭제됨.
      await expect(deleteProfile('claude', '../codex/sibling')).rejects.toThrow();
      // 형제 cli 의 프로필이 보존되었는지 확인 (회귀 시 false 가 됨).
      expect(existsSync(sibling)).toBe(true);
    });
  });

  describe('NFC/NFD round-trip — PR #10 quad-review Claude+Forge 합의', () => {
    // validateProfileName 이 NFC 정규화한다는 점을 활용해 모든 public 함수가
    // NFD/NFC 양쪽 입력을 동일 디스크 경로로 resolve 하는지 검증.
    // 이전 버전: 단순 BAD_NAMES 매트릭스만 있어 "정상 NFD 입력 → NFC 디스크" 일관성 미커버.

    const NFD = '가'.normalize('NFD');  // 'ᄀ' + 'ᅡ' (2 codepoints)
    const NFC = '가'.normalize('NFC');  // '가' (1 codepoint)

    it('NFD 입력으로 createProfile → 디스크는 NFC 단일 표기', async () => {
      // sanity: NFD 와 NFC 가 다른 byte sequence 라야 의미 있음
      expect(NFD).not.toBe(NFC);
      await createProfile('codex', NFD, 'NFD 입력');

      const dirs = await listProfiles('codex');
      expect(dirs).toContain(NFC);
      expect(dirs).not.toContain(NFD);
    });

    it('NFC/NFD 양쪽 lookup 동일 결과 (profileExists/readMeta)', async () => {
      await createProfile('codex', NFC);
      expect(await profileExists('codex', NFC)).toBe(true);
      expect(await profileExists('codex', NFD)).toBe(true);

      expect((await readMeta('codex', NFC))?.name).toBe(NFC);
      expect((await readMeta('codex', NFD))?.name).toBe(NFC);
    });

    it('NFD 로 delete → NFC 디스크 디렉토리 제거', async () => {
      await createProfile('codex', NFC);
      await deleteProfile('codex', NFD);
      expect(await profileExists('codex', NFC)).toBe(false);
    });

    it('NFD 로 read/writeProfileFile → NFC 디스크 경로로 round-trip', async () => {
      await writeProfileFile('codex', NFD, 'auth.json', '{"v":1}');
      expect(await readProfileFile('codex', NFC, 'auth.json')).toBe('{"v":1}');
      expect(await readProfileFile('codex', NFD, 'auth.json')).toBe('{"v":1}');
    });

    it('touchProfile: NFD 입력 → NFC 디스크의 meta.updatedAt 갱신 + NFD lookup 결과도 NFC name 반환', async () => {
      // round-2 Claude-2 Issue 5: NFD round-trip 매트릭스의 touchProfile 누락 보강.
      // round-3 R3 보강: NFD lookup 자체 검증 + defensive toBeTruthy assertion (agy-1 LOW).
      const created = await createProfile('codex', NFC);
      await new Promise((r) => setTimeout(r, 20));  // ISO ms 정밀도 + scheduling 흡수
      await touchProfile('codex', NFD);

      // defensive: meta null 일 때 non-null assertion 의 raw TypeError 회피.
      const metaViaNfc = await readMeta('codex', NFC);
      expect(metaViaNfc).toBeTruthy();
      expect(metaViaNfc!.createdAt).toBe(created.createdAt);
      expect(new Date(metaViaNfc!.updatedAt).getTime())
        .toBeGreaterThan(new Date(created.updatedAt).getTime());

      // NFD lookup 자체도 동일 NFC 디스크 항목으로 resolve 되는지 매트릭스 완결.
      const metaViaNfd = await readMeta('codex', NFD);
      expect(metaViaNfd?.name).toBe(NFC);
      expect(metaViaNfd?.updatedAt).toBe(metaViaNfc!.updatedAt);
    });

    it('renameProfile: NFD oldName → NFD newName 도 NFC 디스크에서 처리', async () => {
      await createProfile('codex', NFC, 'L');
      // 다른 한글: '나' NFD ↔ NFC
      const NFD2 = '나'.normalize('NFD');
      const NFC2 = '나'.normalize('NFC');
      await renameProfile('codex', NFD, NFD2);
      expect(await profileExists('codex', NFC)).toBe(false);
      expect(await profileExists('codex', NFC2)).toBe(true);
      expect((await readMeta('codex', NFC2))?.name).toBe(NFC2);
    });

    it('정규화 후 길이 경계: NFC 40자 통과 / NFC 41자 throw', () => {
      const exactly40 = 'a'.repeat(40);
      const exactly41 = 'a'.repeat(41);
      expect(validateProfileName(exactly40)).toBe(exactly40);
      expect(() => validateProfileName(exactly41)).toThrow();
    });

    it('정규화 후 길이 경계 한글: NFC 40자 통과', () => {
      // 한글 1글자 = NFC 1 codepoint = 1 char 로 .length 측정
      const exactly40Korean = '가'.repeat(40);
      expect(validateProfileName(exactly40Korean)).toBe(exactly40Korean);
      // NFD 입력은 codepoint 2개씩이므로 raw length 는 80, 그러나 정규화 후 40 — 통과
      const exactly40KoreanNFD = '가'.normalize('NFD').repeat(40);
      expect(validateProfileName(exactly40KoreanNFD)).toBe(exactly40Korean);
    });
  });

  describe('fileName 검증 강제 (회귀 가드: readProfileFile / writeProfileFile)', () => {
    const BAD_FILES = ['../escape.json', '../../etc/passwd', 'sub/file.json', '.', '..', 'file\x00.json', ''];

    it.each(BAD_FILES)('readProfileFile fileName="%s" → throw', async (badFile) => {
      await createProfile('codex', 'work');
      await expect(readProfileFile('codex', 'work', badFile)).rejects.toThrow();
    });

    it.each(BAD_FILES)('writeProfileFile fileName="%s" → throw, 파일 미생성', async (badFile) => {
      await createProfile('codex', 'work');
      await expect(writeProfileFile('codex', 'work', badFile, 'leaked')).rejects.toThrow();
      // 프로필 디렉토리 외부에 파일이 생성되지 않았는지 확인 (escape 차단 검증).
      expect(existsSync(join(profileDir('codex', 'work'), '..', 'escape.json'))).toBe(false);
    });

    it('catastrophic 시나리오: writeProfileFile fileName="../../../tmp/leaked" 차단', async () => {
      await createProfile('codex', 'work');
      await expect(writeProfileFile('codex', 'work', '../../../tmp/leaked', 'secret'))
        .rejects.toThrow();
    });
  });
});
