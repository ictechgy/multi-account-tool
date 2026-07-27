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
import type { CliDef, Source } from './types.js';

/** keychain / os-keyring 은 같은 논리적 자원(OS keyring 의 service+account)의 플랫폼별 표현이다. */
export type LiveResourceKind = 'file' | 'os-keyring-family' | 'win-credential';

export interface LiveResourceKey {
  kind: LiveResourceKind;
  /** 비교용 정규화 키. 표시용이 아니다. */
  key: string;
}

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

  /** 이 def 의 모든 source 를 소유자로 등록한다. */
  add(def: CliDef): void {
    for (const src of def.sources) {
      const k = liveResourceKeyOf(src);
      if (!k) continue;
      const id = `${k.kind} ${k.key}`;
      if (!this.owners.has(id)) this.owners.set(id, { cliId: def.id, kind: k.kind });
    }
  }

  /** 플랫폼/env 분기 때문에 현재 def 배열에 나타나지 않는 리소스를 예약한다. */
  reserve(cliId: string, key: LiveResourceKey): void {
    const id = `${key.kind} ${key.key}`;
    if (!this.owners.has(id)) this.owners.set(id, { cliId, kind: key.kind });
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

  get size(): number {
    return this.owners.size;
  }
}

/** 판정에 쓸 수 있도록 def 목록에서 인덱스를 만든다. 호출 시점 평가 — 모듈 레벨 const 로 굳히지 말 것. */
export function buildLiveResourceIndex(defs: readonly CliDef[], reserved: readonly (LiveResourceOwner & LiveResourceKey)[] = []): LiveResourceIndex {
  const index = new LiveResourceIndex();
  for (const def of defs) index.add(def);
  for (const r of reserved) index.reserve(r.cliId, { kind: r.kind, key: r.key });
  return index;
}

/**
 * 이 def 가 이미 소유된 라이브 자격증명 리소스를 주장하는지. 첫 충돌을 반환한다.
 * 자기 자신은 아직 인덱스에 없어야 한다(호출자가 통과 후 `add` 한다).
 */
export function findLiveResourceCollision(def: CliDef, index: LiveResourceIndex): LiveResourceCollision | undefined {
  for (const [sourceIndex, src] of def.sources.entries()) {
    const k = liveResourceKeyOf(src);
    if (!k) continue;
    const owner = index.lookup(k);
    if (!owner) continue;
    const declared = 'path' in src ? src.path
      : src.type === 'win-credential' ? src.targetName
      : 'service' in src ? src.service
      : src.saveAs;
    return { sourceIndex, kind: k.kind, ownerCliId: owner.cliId, declared };
  }
  return undefined;
}
