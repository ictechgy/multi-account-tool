/**
 * 경로의 **파일시스템 identity** 판정.
 *
 * ## 왜 필요한가
 *
 * v0.8.1(하드닝)과 v0.8.2(소유권)의 판정이 둘 다 경로 **표기**에 묶여 있어 별칭 하나로 동시에
 * 우회됐다. v0.8.2 빌드 실측:
 *
 * - `~/aliasdir` → `~/.codex` 를 만들고 plugin 이 `~/aliasdir/auth.json` 을 선언하면 소유권
 *   가드를 통과하고 **실제 codex 토큰을 읽고 덮어썼다**.
 * - goose 정경 경로는 조상 symlink 를 거부하지만, 같은 파일을 `~/goosealias/tokens.json` 로
 *   부르면 어휘 멤버십이 빗나가 하드닝이 **아예 걸리지 않고** 토큰을 반환했다.
 *
 * ## 왜 "거부" 가 아니라 "해석 후 비교" 인가
 *
 * 조상 symlink 거부(v0.8.1 goose 방식)를 다른 builtin 으로 확대하는 방향은 기각했다. 실측:
 * `~/.config` → `~/dotfiles/config` 로 dotfiles 를 관리하는 사용자는 **오늘 이미** goose provider
 * 캐시가 `unsafe Goose provider cache parent` 로 막혀 있다. 반면 공격자는 표기만 바꾸면 그
 * 거부를 통과한다. 즉 그 거부는 **정직한 사용자만 막고 공격자는 못 막는다.** 확대하면 codex ·
 * claude · gemini · kimi · grok 까지 같은 상태가 되어 mat 자체를 못 쓰게 된다.
 *
 * 대신 별칭이든 정경이든 **같은 실물로 귀결되면 같은 리소스로 취급**한다. dotfiles 사용자는
 * 통과하고 별칭 우회는 막힌다.
 *
 * ## bounded resolve
 *
 * `realpath` 전면 적용은 불가능하다 — 자격증명 파일은 **아직 없는 것이 정상**이고(부재 source 는
 * skip 된다) `realpath` 는 ENOENT 로 실패한다. 그래서 **존재하는 최장 접두**만 해석하고 나머지
 * 꼬리는 어휘적으로 이어 붙인다. 꼬리는 해석된 접두에 붙으므로 `~/aliasdir/auth.json` 은
 * 대상 파일이 아직 없어도 `~/.codex/auth.json` 으로 정확히 접힌다.
 *
 * ## 실패는 통과로 접히지 않는다
 *
 * `realpath` 는 ENOENT 말고도 EACCES/ELOOP 로 실패할 수 있고, 공격자는 **해석을 실패시키기만**
 * 하면 된다. 그래서 반환 타입을 판별 유니온으로 두어 "실패 → 통과" 분기를 타입 수준에서 막는다.
 * ENOENT 만 `absent-tail` 로 승격하고 나머지는 `unresolvable` 이며, 호출자는 이를 **거부**로 다뤄야 한다.
 *
 * ## hardlink
 *
 * hardlink 는 경로 해석으로 접히지 않는다(같은 inode 를 가리키는 서로 다른 정경 경로).
 * 따라서 `dev`/`ino` 보조 키가 필요하다. 다만 `nlink === 1` 이면 그 inode 를 가리키는 디렉토리
 * 엔트리가 자기 자신뿐이므로 **어떤 다른 경로와도 hardlink 관계일 수 없다** — 이 경우 비교를
 * 통째로 건너뛸 수 있다.
 */

import { lstatSync, promises as fsp, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { comparablePath, expandTilde } from './paths.js';

/** 해석 결과. `unresolvable` 은 **거부**로 다뤄야 하며 통과로 접으면 안 된다. */
export type PathIdentity =
  | { kind: 'resolved'; path: string; comparable: string; dev: number; ino: number; nlink: number }
  | { kind: 'absent-tail'; path: string; comparable: string }
  | { kind: 'unresolvable'; reason: string };

/**
 * `$HOME` 의 해석된 형태.
 *
 * macOS 의 `os.tmpdir()` 이 symlink 라 테스트 HOME 이 `/var/folders/...` 로 들어오는데,
 * 해석된 경로와 섞이면 `parent.startsWith(home + sep)` 류 비교가 즉시 거짓이 된다.
 * 기준선을 한 곳으로 모은다.
 */
export function resolvedHomeSync(): string {
  try {
    return realpathSync(rawHome());
  } catch {
    return rawHome();
  }
}

/** `resolvedHomeSync` 의 비동기 변형. `sources.ts` / `directory-source.ts` 의 부모 walk 기준선. */
export async function resolvedHome(): Promise<string> {
  try {
    return await fsp.realpath(rawHome());
  } catch {
    return rawHome();
  }
}

function rawHome(): string {
  return process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
}

/** 존재하는 최장 접두를 찾아 해석하고, 남은 꼬리를 어휘적으로 이어 붙인다. */
function boundedResolveWith(
  input: string,
  ops: { realpath: (p: string) => string; lstat: (p: string) => { dev: number; ino: number; nlink: number } }
): PathIdentity {
  const expanded = expandTilde(input);
  const tail: string[] = [];
  let cursor = expanded;

  for (;;) {
    try {
      const real = ops.realpath(cursor);
      const full = tail.length === 0 ? real : join(real, ...tail);
      if (tail.length === 0) {
        // 대상 자체가 존재한다 — inode 정보를 함께 싣는다(hardlink 판정용).
        try {
          const st = ops.lstat(real);
          return { kind: 'resolved', path: real, comparable: comparablePath(real), dev: st.dev, ino: st.ino, nlink: st.nlink };
        } catch (err) {
          // `realpath` 가 방금 성공했으므로 대상은 **존재한다**. 여기서의 lstat 실패를
          // `absent-tail` 로 접으면 dev/ino 가 사라져 hardlink 축이 조용히 꺼진다 — 공격자가
          // lstat 을 실패시키기만 하면 되는 fail-open 이다. ENOENT(그 사이 삭제됨)만 부재로
          // 인정하고 나머지는 거부한다.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') return { kind: 'unresolvable', reason: code ?? 'lstat-failed' };
          return { kind: 'absent-tail', path: real, comparable: comparablePath(real) };
        }
      }
      return { kind: 'absent-tail', path: full, comparable: comparablePath(full) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT 만 "아직 없는 꼬리" 로 승격한다. EACCES/ELOOP 등은 공격자가 만들 수 있으므로
      // 통과로 접지 않는다.
      if (code !== 'ENOENT') return { kind: 'unresolvable', reason: code ?? 'unknown' };
      const parent = dirname(cursor);
      if (parent === cursor) return { kind: 'unresolvable', reason: 'no-existing-prefix' };
      tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

/** 동기 변형 — 로드 시점 판정용. `getAllCliDefs()` 가 동기라(React render 본문에서 호출) 필수다. */
export function resolvePathIdentitySync(input: string): PathIdentity {
  return boundedResolveWith(input, {
    realpath: (p) => realpathSync(p),
    lstat: (p) => {
      const st = lstatSync(p);
      return { dev: Number(st.dev), ino: Number(st.ino), nlink: Number(st.nlink) };
    }
  });
}

/** 비동기 변형 — I/O 시점 게이트용. `sources.ts` 의 4 진입점은 이미 전부 async 다. */
export async function resolvePathIdentity(input: string): Promise<PathIdentity> {
  // 동기 코어와 결과가 갈라지면 안 되므로 같은 알고리즘을 쓰되 I/O 만 비동기로 바꾼다.
  // (두 변형의 동치는 단위 테스트로 고정한다.)
  const expanded = expandTilde(input);
  const tail: string[] = [];
  let cursor = expanded;
  for (;;) {
    try {
      const real = await fsp.realpath(cursor);
      if (tail.length === 0) {
        try {
          const st = await fsp.lstat(real);
          return { kind: 'resolved', path: real, comparable: comparablePath(real), dev: Number(st.dev), ino: Number(st.ino), nlink: Number(st.nlink) };
        } catch (err) {
          // 동기 변형과 **같은 규칙**이어야 한다 — 여기만 무조건 absent-tail 로 접으면
          // I/O 시점 경로에서만 hardlink 축이 꺼지는 비대칭 fail-open 이 생긴다.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') return { kind: 'unresolvable', reason: code ?? 'lstat-failed' };
          return { kind: 'absent-tail', path: real, comparable: comparablePath(real) };
        }
      }
      const full = join(real, ...tail);
      return { kind: 'absent-tail', path: full, comparable: comparablePath(full) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return { kind: 'unresolvable', reason: code ?? 'unknown' };
      const parent = dirname(cursor);
      if (parent === cursor) return { kind: 'unresolvable', reason: 'no-existing-prefix' };
      tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

/**
 * **부모만** 해석하고 마지막 세그먼트(leaf)는 어휘 표기로 남긴다. I/O 대상 경로를 만들 때 쓴다.
 *
 * ## 왜 leaf 를 해석하면 안 되는가
 *
 * 전면 해석은 자격증명 **파일 자신**이 symlink 인 경우까지 따라간다. 실측(이 함수를 도입하기 전
 * 상태): `~/.config/goose/gemini_oauth/tokens.json` 을 `~/evil/planted.json` 으로의 symlink 로
 * 만들면 `readSource` 가 공격자 내용을 반환했고, `writeSource` 는 **피해자 토큰을 공격자 파일에
 * 썼다**. v0.8.2 는 `unsafe Goose provider cache file` 로 막던 것이다 — 해석을 도입하면서
 * 조상 완화만 의도했는데 leaf 검사까지 함께 지워버린 회귀였다.
 *
 * leaf 를 어휘로 남기면 뒤따르는 `lstat` + `isSymbolicLink()` 와 `O_NOFOLLOW` 가 v0.8.2 와
 * 동일하게 동작하고, 조상(`~/.config` 같은 dotfiles symlink)만 해석되어 의도한 완화만 남는다.
 *
 * `null` 은 거부 신호다(`unresolvable`).
 */
export async function resolveParentKeepLeaf(input: string): Promise<string | null> {
  const expanded = expandTilde(input);
  const parent = dirname(expanded);
  if (parent === expanded) return expanded;   // 파일시스템 루트 — 해석할 부모가 없다
  const id = await resolvePathIdentity(parent);
  if (id.kind === 'unresolvable') return null;
  return join(id.path, basename(expanded));
}

/** 판정에 쓸 비교 키. `unresolvable` 은 키가 없다 — 호출자가 거부해야 한다. */
export function identityComparable(id: PathIdentity): string | null {
  return id.kind === 'unresolvable' ? null : id.comparable;
}
