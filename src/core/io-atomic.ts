/**
 * 자격증명/설정 파일을 안전하게 쓰는 공용 atomic 유틸.
 *
 * 동일 보안 모델을 sources / config / profile-store 모든 쓰기에 일관 적용한다:
 * - unique tmp: deterministic `${path}.tmp` 선점/symlink 공격 차단
 * - O_EXCL: tmp 가 이미 존재하면 fail (난수 충돌/race 방지)
 * - O_NOFOLLOW: tmp 가 symlink 라면 fail (attacker symlink 추적 차단)
 * - 0600 권한: 다른 사용자 읽기 차단
 * - unique tmp → rename: 원자적 교체
 * - 실패 시 tmp 정리 (best-effort)
 *
 * 호출자는 같은 path 에 동시 호출하지 않도록 보장해야 한다
 * (config.ts 의 mutateConfig 같은 직렬화 헬퍼 사용).
 */

import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

const ATOMIC_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

function atomicTmpPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
}

export function isAtomicTmpFileName(name: string): boolean {
  return name.endsWith('.tmp') || /\.tmp-\d+-[0-9a-f]{16}$/.test(name);
}

/**
 * 파일을 원자적으로 쓴다. 권한 0600, 부모 디렉토리 자동 생성.
 * path 는 이미 expanded 된 절대 경로여야 한다 (`~/` 확장은 호출자 책임).
 */
export async function writeFileAtomic(path: string, value: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = atomicTmpPath(path);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tmp, ATOMIC_FLAGS, 0o600);
    await handle.writeFile(value);
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, path);
  } catch (err) {
    if (handle) await handle.close().catch(() => { /* best-effort */ });
    await fs.rm(tmp, { force: true }).catch(() => { /* best-effort */ });
    throw err;
  }
}
