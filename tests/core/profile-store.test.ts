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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProfile,
  deleteProfile,
  listProfiles,
  profileExists,
  readMeta,
  readProfileFile,
  renameProfile,
  touchProfile,
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
  });

  describe('touchProfile', () => {
    it('정상: updatedAt 만 갱신 (createdAt 보존)', async () => {
      const created = await createProfile('codex', 'work');
      await new Promise((r) => setTimeout(r, 5));  // ISO 초 단위 변경 위해 잠시 대기
      await touchProfile('codex', 'work');
      const meta = await readMeta('codex', 'work');
      expect(meta?.createdAt).toBe(created.createdAt);
      expect(meta!.updatedAt >= created.updatedAt).toBe(true);
    });

    it('meta 없으면 no-op (throw 안 함)', async () => {
      await expect(touchProfile('codex', 'never-created')).resolves.toBeUndefined();
    });
  });

  describe('renameProfile', () => {
    it('정상: 디렉토리 rename + meta.name + updatedAt 갱신', async () => {
      const created = await createProfile('codex', 'old', 'L');
      await new Promise((r) => setTimeout(r, 5));
      await renameProfile('codex', 'old', 'new');

      expect(existsSync(profileDir('codex', 'old'))).toBe(false);
      expect(existsSync(profileDir('codex', 'new'))).toBe(true);
      const meta = await readMeta('codex', 'new');
      expect(meta?.name).toBe('new');
      expect(meta?.createdAt).toBe(created.createdAt);
      expect(meta!.updatedAt >= created.updatedAt).toBe(true);
      expect(meta?.label).toBe('L');
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
  });

  describe('readProfileFile / writeProfileFile', () => {
    it('round-trip', async () => {
      await createProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', '{"token":"abc"}');
      expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('{"token":"abc"}');
    });

    it('writeProfileFile: 프로필 디렉토리 없어도 자동 생성', async () => {
      // createProfile 미호출 — writeProfileFile 가 디렉토리 만들어야.
      await writeProfileFile('codex', 'auto-created', 'data.json', '{}');
      expect(existsSync(profileDir('codex', 'auto-created'))).toBe(true);
      expect(await readProfileFile('codex', 'auto-created', 'data.json')).toBe('{}');
    });

    it('writeProfileFile: 파일 권한 0o600 (atomic write 위임)', async () => {
      await writeProfileFile('codex', 'work', 'auth.json', '{}');
      const stat = await fs.stat(profileFilePath('codex', 'work', 'auth.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('readProfileFile: 없으면 null (ENOENT swallow)', async () => {
      expect(await readProfileFile('codex', 'work', 'never.json')).toBeNull();
    });
  });
});
