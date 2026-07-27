/**
 * **I/O 시점** builtin 라이브 자격증명 게이트 (Gate 2).
 *
 * ## Gate 1 만으로 부족한 이유
 *
 * Gate 1(`cli-defs.ts` 병합 지점)은 **로드 시점**에 소유권을 판정한다. 그 판정은 그 순간의
 * 파일시스템 형상에 대한 것이므로, 로드 이후에 별칭이 생기면 이미 수락된 def 가 그 별칭을 타고
 * builtin 자격증명에 도달한다:
 *
 * 1. plugin 이 `~/myapp/creds.json` 을 선언한다 — 그 시점에 별칭이 아니므로 Gate 1 통과.
 * 2. 그 뒤 `~/myapp` 가 `~/.codex` 로의 symlink 로 바뀐다.
 * 3. 다음 `readSource` 가 실제 codex 토큰을 반환한다.
 *
 * 즉 **Gate 1 은 선언을 심사하고 Gate 2 는 별칭을 심사한다.** 이 역할 분담이 아래 면제 규칙의
 * 근거이기도 하다.
 *
 * ## 면제 규칙 — "선언 표기가 곧 정경 표기인가"
 *
 * 게이트는 builtin 자신의 접근을 막으면 안 된다. 그 판별자로 처음에는 builtin source **객체
 * identity**(`WeakSet`)를 썼는데, 실제로 돌려보니 틀린 축이었다: `BUILTIN_CLI_DEFS` 스냅샷과
 * 같은 경로를 **새로 만든** 동등한 source 객체(테스트, 또는 def 를 재구성하는 모든 코드)가 전부
 * 거부됐다. 객체 identity 는 "정당한 접근인가" 와 상관이 없다.
 *
 * 대신 이렇게 묻는다: **선언 표기 자체가 그 리소스의 정경 표기인가.**
 *
 * - builtin 의 goose 캐시 source 는 `~/.config/goose/...` 를 정경 그대로 선언한다 → 면제.
 * - 별칭은 정의상 정경과 **다르게** 부른다(`~/aliasdir/auth.json`) → 거부.
 *
 * 정경 표기를 그대로 선언한 plugin 은 어떻게 되는가? 그건 Gate 2 가 아니라 **Gate 1 이 로드
 * 시점에 def 째로 버린다.** 그런 def 는 애초에 I/O 진입점에 도달하지 못한다. 두 게이트가 각자
 * 자기 축만 담당하므로 규칙이 단순하고, 어느 쪽도 상대의 판정을 재기술하지 않는다.
 *
 * ## 경로 없는 source 는 대상이 아니다
 *
 * keychain / os-keyring / win-credential 은 경로가 없어 **별칭이라는 개념 자체가 없다**.
 * service/account 표기의 소유권은 Gate 1 의 어휘 키가 그대로 권위다(service 명 동형 위장은
 * 별개의 미해결 항목). 여기서 걸러내지 않으면 builtin 과 같은 service 를 쓰는 정당한 호출까지
 * 막힌다.
 *
 * ## 인덱스를 캐시하지 않는 이유
 *
 * 호출마다 새로 만든다. 캐시하면 인덱스가 굳은 시점 이후의 별칭을 놓쳐 Gate 2 의 존재 이유
 * (로드 이후 변화 탐지)를 스스로 없앤다. 비용은 builtin 파일 리소스 약 20 개의 1-pass 해석 —
 * 실측 0.088ms 로, 같은 경로에 있는 keychain `security` 스폰 1 회(31.9ms) 대비 무시 가능하다.
 */

import { BUILTIN_CLI_DEFS, reservedLiveResources } from './cli-defs.js';
import { buildLiveResourceIndex, findSourceCollision, liveResourceKeyOf } from './builtin-live-resources.js';
import { classifyGoosePath, classifyGoosePathByIdentity } from './goose-provider-cache.js';
import type { Source } from './types.js';

/**
 * 게이트 거부 오류.
 *
 * **메시지에 경로를 넣을 수 없도록 생성자가 경로를 받지 않는다.** 후처리 필터로 거르는 방식은
 * 새 호출부가 생길 때마다 필터를 빠뜨릴 수 있지만, 애초에 넣을 자리가 없으면 빠뜨릴 수 없다.
 *
 * 이 오류는 `detector.ts` 와 `doctor.ts` 의 catch 를 통해 **사용자 화면까지 그대로 도달**한다
 * (`status: 'error'`, `error: err.message`). HOME 절대 경로나 해석된 실물 경로가 섞이면 그대로
 * 유출되므로 메시지는 고정 문자열이고, 소유자 cliId 는 프로그램적 소비를 위해 속성으로만 둔다.
 */
export class LiveResourceGuardError extends Error {
  readonly ownerCliId: string;

  constructor(ownerCliId: string) {
    super('unsafe credential resource: claimed by another CLI');
    this.name = 'LiveResourceGuardError';
    this.ownerCliId = ownerCliId;
  }
}

/**
 * 이 source 에 접근해도 되는지 판정하고, 아니면 throw 한다.
 *
 * `sources.ts` 의 `readSource` / `writeSource` / `sourceExists` / `removeSource` **진입부**에서
 * 부른다. 진입부인 이유: 그 아래 분기(goose 하드닝 경로 / 일반 파일 경로 / keychain …)마다
 * 따로 부르면 새 분기가 추가될 때 조용히 빠지고, 빠진 자리가 그대로 우회 경로가 된다.
 */
export function assertSourceMayBeAccessed(src: Source): void {
  const declared = liveResourceKeyOf(src);
  if (!declared || declared.kind !== 'file') return;
  const path = 'path' in src ? src.path : '';

  // (1) goose **예약구역**. 소유권보다 넓다 — 구역 안이지만 어떤 builtin source 도 아닌 경로가
  //     있고(예: 아직 mat 이 모르는 provider 캐시), 그런 경로는 아래 소유권 검사에 걸리지 않는다.
  //     로드 시점에만 구역을 보면, 로드 후에 구역 안으로 별칭된 source 가 그대로 접근한다.
  //     선언 표기가 이미 구역 안이면 그건 Gate 1 이 심사한 사안이므로 여기서 다시 막지 않는다.
  if (classifyGoosePath(path) === 'outside' && classifyGoosePathByIdentity(path) === 'reserved-nonadmitted') {
    throw new LiveResourceGuardError('goose');
  }

  // (2) builtin 소유권.
  const index = buildLiveResourceIndex(BUILTIN_CLI_DEFS, reservedLiveResources());
  const collision = findSourceCollision(src, index);
  if (!collision) return;
  // 선언 표기가 그 소유자의 **선언 표기**와 같으면 별칭이 아니다 (위 "면제 규칙" 참고).
  // `lookup` 이 아니라 `lookupDeclared` 여야 한다 — `lookup` 은 해석 키도 맞히므로, 조상이
  // symlink 인 환경에서 해석된 정경 표기를 그대로 선언한 공격자까지 면제해 버린다.
  if (index.lookupDeclared(declared)?.cliId === collision.ownerCliId) return;
  throw new LiveResourceGuardError(collision.ownerCliId);
}
