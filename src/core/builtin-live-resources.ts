/**
 * builtin 이 소유한 **라이브 자격증명 리소스**의 소유권 판정.
 *
 * ## 왜 필요한가
 *
 * v0.8.1 까지 plugin CliDef 는 builtin 의 라이브 자격증명을 자기 source 로 선언할 수 있었다.
 * 실측(0.8.1 빌드): `~/.codex/auth.json`, `~/.claude/.credentials.json`,
 * `~/.gemini/oauth_creds.json`, `~/.grok/auth.json`, `~/.kimi/config.toml`,
 * goose 정경 경로, 그리고 `{type:'keychain', service:'goose', account:'secrets'}` 까지
 * 전부 통과했다.
 *
 * 이건 읽기 유출이 아니라 **파괴**다. account 를 생략한 keychain source 를 restore 하면
 * `loadKeychainBackup(service, undefined)` 가 `-s <service>` 만으로 조회해 builtin 항목을 찾고,
 * 이어지는 `deleteKeychainEntry(service, '<builtin account>')` 가 **진짜 자격증명을 삭제**한다.
 * 또 plugin source 는 `allowAnyApp` 을 설정하지 않으므로 `Claude Code-credentials` 를 다시 쓰면
 * `-A` ACL 이 영구 강등된다.
 *
 * 게다가 락은 cliId 단위(`switcher.ts` 의 `affectsCliIds: [cliId]`)라 스쿼팅 plugin 은 진짜
 * CLI 와 **다른 락**을 잡고 동시에 실행된다 — 상호배제 전제가 무너진다.
 *
 * > **불변식**: `affectsCliIds: [cliId]` 라는 좁은 락 범위는 **def 간 리소스 배타성이 보장될
 * > 때만** 건전하다. 이 모듈이 그 보장을 제공한다. 여기를 완화하면 락 구멍이 조용히 다시 열린다.
 *
 * ## 왜 여기(그리고 병합 지점)인가
 *
 * `parseSource` 는 다른 def 를 볼 수 없고 `cli-defs.ts` 를 import 하면 순환이 된다.
 * `assertValidSourceList` 는 본질적으로 per-def 다. builtin 과 plugin 을 **함께 보는 유일한
 * 지점**은 `getAllCliDefs()` 의 병합 루프뿐이다. 이 모듈은 def 목록을 인자로 받는 순수 함수만
 * 두어(`types.js` / `paths.js` 외 import 없음) 순환을 구조적으로 회피한다.
 *
 * ## 인덱스는 조건부여선 안 된다
 *
 * `BUILTIN_CLI_DEFS` 는 모듈 로드 시점에 평가되고 그 내용은 `process.platform`,
 * `GOOSE_DISABLE_KEYRING`, `XDG_DATA_HOME` 에 따라 갈린다. 그 배열만으로 인덱스를 만들면:
 *  - darwin 인덱스에는 goose `os-keyring` 표현이 없어 그 형태를 선언한 plugin 이 통과하고,
 *    같은 JSON 을 linux 로 옮기면 거기서 진짜 항목을 스쿼팅한다(이식성 문제).
 *  - 더 나쁜 것은 **같은 머신 라이브 우회**다: `GOOSE_DISABLE_KEYRING` 은 **mat 자신의** env 에서
 *    읽히므로, mat 호출에만 그 변수를 걸면 keyring 리소스가 인덱스에서 사라지는데 goose 는
 *    여전히 keyring 을 쓴다.
 * 따라서 조건부 리소스는 `RESERVED_LIVE_RESOURCES` 로 **모든 분기의 합집합**을 무조건 예약한다.
 * 이 접기는 항상 "더 거부하는" 방향이라 안전하다.
 */

import { comparablePath } from './paths.js';
import { resolvePathIdentitySync } from './path-identity.js';
import type { CliDef, Source } from './types.js';

/** keychain / os-keyring 은 같은 논리적 자원(OS keyring 의 service+account)의 플랫폼별 표현이다. */
export type LiveResourceKind = 'file' | 'os-keyring-family' | 'win-credential';

export interface LiveResourceKey {
  kind: LiveResourceKind;
  /** 비교용 정규화 키. 표시용이 아니다. */
  key: string;
}

/**
 * 예약 리소스.
 *
 * 파일 종류는 `declaredPath` 가 **필수**다 — 이 값이 identity 축과 inode 축을 만든다. optional 로
 * 두면 호출자가 빠뜨렸을 때 어휘 키만 남고 조용히 보호가 사라진다(v0.8.3 리뷰에서 실제로 그
 * 상태였고, `~/.claude` 를 symlink 로 관리하는 macOS 사용자에게서 실측으로 뚫렸다).
 * 판별 유니온으로 두어 **컴파일 타임에** 강제한다 — 호출자의 기억에 맡기지 않는다.
 */
export type ReservedLiveResource =
  | (LiveResourceOwner & { kind: 'file'; key: string; declaredPath: string })
  | (LiveResourceOwner & { kind: Exclude<LiveResourceKind, 'file'>; key: string; declaredPath?: undefined });

export interface LiveResourceOwner {
  cliId: string;
  kind: LiveResourceKind;
}

export interface LiveResourceCollision {
  /** 충돌한 source 의 def 내 인덱스 */
  sourceIndex: number;
  kind: LiveResourceKind;
  /** 이미 이 리소스를 소유한 def 의 id */
  ownerCliId: string;
  /** 사용자에게 보여줄 원본 표기 (표시 안전성은 호출자가 formatPluginWarning 으로 보장) */
  declared: string;
}

/** account 미지정 keychain 조회는 `-s service` 만 쓰므로 그 service 의 **어떤** account 와도 충돌한다. */
const ACCOUNT_WILDCARD = '*';

function keyringKey(service: string, account: string | undefined): string {
  const svc = service.normalize('NFC').toLowerCase();
  const acct = account && account.length > 0 ? account.normalize('NFC').toLowerCase() : ACCOUNT_WILDCARD;
  return `${svc} ${acct}`;
}

/**
 * source 하나의 소유권 키. 라이브 자격증명을 점유하지 않는 종류는 `null`.
 *
 * `switch (src.type)` 는 **exhaustive** 다 — `never` 체크가 있으므로 새로운 source 종류가
 * 추가되면 컴파일이 깨진다. 이게 없으면 6번째 종류가 조용히 통과해 "다음 번 계약 축소"를
 * 스스로 불러온다.
 */
/**
 * 경로를 **해석해서** 얻은 소유권 키. 어휘 키만 쓰면 별칭 표기로 우회된다(실측: `~/aliasdir/auth.json`
 * 이 `~/.codex/auth.json` 을 그대로 읽고 덮어썼다).
 *
 * `unresolvable`(EACCES/ELOOP 등)은 **키를 만들지 않고 null 을 반환하지 않는다** — 호출자가
 * 거부로 다룰 수 있도록 별도 신호를 준다. 공격자가 해석을 실패시키기만 하면 통과하는
 * fail-open 을 막기 위함이다.
 */
export function resolvedLiveResourceKeyOf(src: Source): { key: LiveResourceKey; nlink?: number } | 'unresolvable' | null {
  const lexical = liveResourceKeyOf(src);
  if (!lexical) return null;
  if (lexical.kind !== 'file') return { key: lexical };   // keyring 류는 경로가 아니다
  const id = resolvePathIdentitySync('path' in src ? src.path : '');
  if (id.kind === 'unresolvable') return 'unresolvable';
  return { key: { kind: 'file', key: id.comparable }, nlink: id.kind === 'resolved' ? id.nlink : undefined };
}

export function liveResourceKeyOf(src: Source): LiveResourceKey | null {
  switch (src.type) {
    case 'file':
    case 'directory':
      return { kind: 'file', key: comparablePath(src.path) };
    case 'keychain':
    case 'os-keyring':
      return { kind: 'os-keyring-family', key: keyringKey(src.service, src.account) };
    case 'win-credential':
      // WindowsCredentialSource 는 `service` 가 아니라 `targetName` 을 쓰고 `account` 는 필수다
      // (그래서 여기서는 와일드카드가 발생하지 않는다).
      return { kind: 'win-credential', key: keyringKey(src.targetName, src.account) };
    case 'env-secret':
      // 지금은 소유권 채널이 아니다 — `switcher.ts` 의 `assertNoEnvSecretSources` 가
      // snapshot/restore/switch 를 런타임에서 차단하므로 라이브 자격증명을 점유할 수 없다.
      // env-secret 이 활성화되는 날 `backend.handle` 이 goose 의 secret-service 항목을
      // 가리킬 수 있으므로 **이 case 를 반드시 다시 판정해야 한다.**
      return null;
    default: {
      const exhaustive: never = src;
      return exhaustive;
    }
  }
}

export class LiveResourceIndex {
  private readonly owners = new Map<string, LiveResourceOwner>();
  /**
   * **선언 표기**로 등록된 키만 따로 둔다. I/O 시점 게이트의 면제 판정이 이걸 쓴다.
   *
   * `owners` 에는 해석 키도 함께 들어 있어서 그걸로 면제를 판정하면, 조상이 symlink 인 환경에서
   * 공격자가 **해석된 정경 표기**를 그대로 선언했을 때 "정경이니 면제" 로 통과한다(실측).
   * builtin 자신은 언제나 `~/...` 선언 표기로 접근하므로 면제에는 이 집합만 있으면 충분하다.
   */
  private readonly lexicalOwners = new Map<string, LiveResourceOwner>();
  /** builtin 파일 리소스의 **선언 경로**. hardlink 판정 시 그 자리에서 lstat 한다. */
  private readonly filePathsByOwner: Array<{ cliId: string; declared: string }> = [];

  /**
   * 이 def 의 모든 source 를 소유자로 등록한다.
   *
   * **어휘 키와 해석 키를 둘 다** 등록한다. 둘은 대체 관계가 아니다:
   * - 해석 키는 별칭을 접어 잡지만, 대상이 부재하고 접두조차 없으면(`unresolvable`) 키가 없다.
   * - 어휘 키는 부재 경로도 항상 잡지만 별칭에 우회된다.
   * 하나만 등록하면 그 하나의 사각지대가 그대로 우회 경로가 된다. 또 I/O 시점 게이트는
   * "선언 표기가 정경인가" 를 물어야 하므로 어휘 키 조회가 반드시 가능해야 한다.
   */
  add(def: CliDef): void {
    for (const src of def.sources) {
      const lexical = liveResourceKeyOf(src);
      if (!lexical) continue;
      this.register(def.id, lexical, 'path' in src ? src.path : undefined);
    }
  }

  /**
   * 리소스 하나를 등록하는 **유일한** 경로. `add`(def 유래)와 `reserve`(플랫폼/env 예약)가
   * 반드시 이 함수를 거친다.
   *
   * 두 등록 경로가 서로 다른 축을 넣으면 그 차이가 곧 우회로가 된다. 실제로 그렇게 됐다:
   * `reserve` 가 어휘 키만 넣던 동안, `~/.claude` 를 symlink 로 관리하는 macOS 사용자에게
   * `~/.claude/.credentials.json` 은 **예약 전용** 리소스라 해석 키가 어디에도 없었고, plugin 이
   * 해석된 정경 표기를 직접 선언하면 두 게이트를 모두 통과해 진짜 자격증명을 읽었다(실측).
   * `nlink === 1` 이라 inode 폴백도 건너뛰어 아무것도 잡지 못했다.
   */
  private register(cliId: string, lexical: LiveResourceKey, declaredPath?: string): void {
    this.own(cliId, lexical);
    const lexicalId = `${lexical.kind} ${lexical.key}`;
    if (!this.lexicalOwners.has(lexicalId)) this.lexicalOwners.set(lexicalId, { cliId, kind: lexical.kind });
    if (lexical.kind !== 'file' || declaredPath === undefined) return;
    // inode 축은 **해석 성공 여부와 무관**하게 등록한다. `lookupInode` 는 조회 시점에 다시 lstat
    // 하므로, 지금 해석이 안 되는 경로(부재 부모, 일시적 EACCES)도 나중에 생기면 그때 잡혀야
    // 한다. 해석 성공 분기 안에 두면 그런 경로는 영영 inode 축에서 빠진다.
    this.filePathsByOwner.push({ cliId, declared: declaredPath });
    const id = resolvePathIdentitySync(declaredPath);
    // 해석 실패는 그 **경로 키**만 등록하지 않는다(거부 신호는 아니다 — 어휘 키는 이미 들어갔다).
    if (id.kind !== 'unresolvable') this.own(cliId, { kind: 'file', key: id.comparable });
  }

  private own(cliId: string, key: LiveResourceKey): void {
    const id = `${key.kind} ${key.key}`;
    if (!this.owners.has(id)) this.owners.set(id, { cliId, kind: key.kind });
  }

  /**
   * hardlink 소유자 조회 — dev/ino 를 **그 자리에서** 다시 구한다.
   *
   * 로드 시점 dev/ino 를 얼려 두면 구멍이 생긴다: 신규 설치 사용자는 `~/.codex/auth.json` 이
   * 로드 시점에 **부재**라 inode 가 인덱스에 없고, 이후 로그인으로 파일이 생긴 뒤 plugin 경로가
   * 그 파일의 hardlink 가 되면 조회가 빈손으로 통과한다. 그래서 매번 lstat 한다.
   *
   * 비용은 무시 가능하다 — builtin 파일 리소스 ~20 개 lstat 1-pass 가 0.09ms 이고, 최악의
   * switcher 루프에서도 1ms 미만이다(keychain `security` 스폰 1회가 ~32ms).
   */
  lookupInode(dev: number, ino: number): LiveResourceOwner | undefined {
    for (const entry of this.filePathsByOwner) {
      const id = resolvePathIdentitySync(entry.declared);
      if (id.kind !== 'resolved') continue;
      if (id.dev === dev && id.ino === ino) return { cliId: entry.cliId, kind: 'file' };
    }
    return undefined;
  }

  /** 플랫폼/env 분기 때문에 현재 def 배열에 나타나지 않는 리소스를 예약한다. */
  reserve(cliId: string, key: LiveResourceKey, declaredPath?: string): void {
    this.register(cliId, key, declaredPath);
  }

  /**
   * 와일드카드는 **양방향**으로 매칭해야 한다.
   *
   * - 조회가 특정 account 이고 인덱스가 와일드카드를 소유한 경우
   * - 조회가 account 를 **생략**(= 와일드카드)하고 인덱스가 특정 account 를 소유한 경우
   *
   * 두 번째가 가장 파괴적인 케이스다: account 없는 keychain source 의 restore 는
   * `-s <service>` 만으로 조회해 builtin 항목을 찾아 **삭제**한다. 한 방향만 처리하면
   * 바로 그 케이스가 그대로 통과한다.
   */
  lookup(key: LiveResourceKey): LiveResourceOwner | undefined {
    const exact = this.owners.get(`${key.kind} ${key.key}`);
    if (exact) return exact;
    if (key.kind !== 'os-keyring-family') return undefined;
    const [svc, acct] = key.key.split(' ');
    if (acct === ACCOUNT_WILDCARD) {
      for (const [id, owner] of this.owners) {
        if (id.startsWith(`os-keyring-family ${svc} `)) return owner;
      }
      return undefined;
    }
    return this.owners.get(`os-keyring-family ${svc} ${ACCOUNT_WILDCARD}`);
  }

  /** 이 키가 **선언 표기**로 등록돼 있는가. 면제 판정 전용 (위 `lexicalOwners` 주석 참고). */
  lookupDeclared(key: LiveResourceKey): LiveResourceOwner | undefined {
    return this.lexicalOwners.get(`${key.kind} ${key.key}`);
  }

  get size(): number {
    return this.owners.size;
  }
}

/** 판정에 쓸 수 있도록 def 목록에서 인덱스를 만든다. 호출 시점 평가 — 모듈 레벨 const 로 굳히지 말 것. */
export function buildLiveResourceIndex(defs: readonly CliDef[], reserved: readonly ReservedLiveResource[] = []): LiveResourceIndex {
  const index = new LiveResourceIndex();
  for (const def of defs) index.add(def);
  for (const r of reserved) index.reserve(r.cliId, { kind: r.kind, key: r.key }, r.declaredPath);
  return index;
}

/**
 * 이 def 가 이미 소유된 라이브 자격증명 리소스를 주장하는지. 첫 충돌을 반환한다.
 * 자기 자신은 아직 인덱스에 없어야 한다(호출자가 통과 후 `add` 한다).
 */
export function findLiveResourceCollision(def: CliDef, index: LiveResourceIndex): LiveResourceCollision | undefined {
  for (const [sourceIndex, src] of def.sources.entries()) {
    const hit = findSourceCollision(src, index);
    if (hit) return { sourceIndex, ...hit };
  }
  return undefined;
}

/** 사용자에게 보여줄 원본 표기. 표시 안전성은 호출자 책임(`formatPluginWarning`). */
function declaredOf(src: Source): string {
  return 'path' in src ? src.path
    : src.type === 'win-credential' ? src.targetName
    : 'service' in src ? src.service
    : src.saveAs;
}

/**
 * source **하나**의 충돌 판정 — 로드 시점 게이트와 I/O 시점 게이트가 공유하는 단일 규칙.
 *
 * 두 게이트가 각자 규칙을 재기술하면 갈라진다. 갈라지는 방향이 "로드는 막는데 I/O 는 통과" 면
 * 그대로 우회 경로가 되므로, 규칙은 반드시 여기 한 곳에만 둔다.
 */
export function findSourceCollision(src: Source, index: LiveResourceIndex): Omit<LiveResourceCollision, 'sourceIndex'> | undefined {
  const r = resolvedLiveResourceKeyOf(src);
  if (r === null) return undefined;
  // 해석 실패는 **거부**다. 통과로 접으면 공격자는 해석을 실패시키기만 하면 된다.
  if (r === 'unresolvable') return { kind: 'file', ownerCliId: UNRESOLVABLE_OWNER, declared: declaredOf(src) };
  const k = r.key;
  let owner = index.lookup(k);
  // 경로 해석으로 접히지 않는 축: hardlink. `nlink === 1` 이면 그 inode 를 가리키는 디렉토리
  // 엔트리가 자기 자신뿐이라 어떤 builtin 파일과도 hardlink 관계일 수 없으므로 건너뛴다.
  if (!owner && k.kind === 'file' && r.nlink !== undefined && r.nlink > 1) {
    const probe = resolvePathIdentitySync(declaredOf(src));
    if (probe.kind === 'resolved') owner = index.lookupInode(probe.dev, probe.ino);
  }
  if (!owner) return undefined;
  return { kind: k.kind, ownerCliId: owner.cliId, declared: declaredOf(src) };
}

/** 해석 실패 거부의 소유자 자리표시자. 실제 cliId 가 아니다. */
export const UNRESOLVABLE_OWNER = '(해석 불가)';
