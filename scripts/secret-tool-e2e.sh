#!/usr/bin/env bash
#
# secret-tool-e2e.sh — 실 Linux Secret Service(secret-tool) round-trip 검증 +
#                      mock fixture 파생용 실측 출력 캡처.
#
# plan(.omc/plans/os-keyring-source-type.md) §196 의 hard gate 를 구현한다:
#   "mock fixture 를 freeze 하기 전에 실제 secret-tool 출력 캡처가 의무.
#    hand-authored stdout fixture 로 freeze 금지 — green-test/red-prod 차단."
# 그리고 §197 account-recovery gap round-trip(시리즈에서 가장 중요한 E2E)도 검증한다.
#
# ⚠️ 이 스크립트는 keyring 이 이미 활성화된 환경에서 실행되어야 한다.
#    docker/run.sh 의 entrypoint(keyring-entrypoint.sh)가 그 환경을 만든다:
#        docker/run.sh bash scripts/secret-tool-e2e.sh
#        docker/run.sh bash scripts/secret-tool-e2e.sh --capture tests/fixtures/os-keyring
#
# 종료코드: 모든 검증 통과 0, 하나라도 실패 1, 환경 미비 2.

set -uo pipefail

# --capture <dir> 가 주어지면 실측 stdout/stderr 를 그 디렉토리에 저장한다.
CAPTURE_DIR=""
if [ "${1:-}" = "--capture" ]; then
  CAPTURE_DIR="${2:?--capture 다음에 출력 디렉토리를 지정하세요}"
  mkdir -p "$CAPTURE_DIR"
fi

# 격리된 테스트 service 이름(실제 자격증명과 충돌 방지).
SVC="mat-e2e-$$"
PASS=0
FAIL=0

ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# secret-tool 가용성 사전 점검.
if ! command -v secret-tool >/dev/null 2>&1; then
  echo "secret-tool 미설치 — 이 스크립트는 docker/run.sh 안에서 실행하세요." >&2
  exit 2
fi
if ! printf 'p' | secret-tool store --label=_p "_mat_e2e_probe_$$" ready >/dev/null 2>&1; then
  echo "keyring 미활성(daemon locked/down) — docker/run.sh entrypoint 를 거쳤는지 확인하세요." >&2
  exit 2
fi
secret-tool clear "_mat_e2e_probe_$$" ready >/dev/null 2>&1 || true

# 매칭된 search 블록(stdout 의 '[/N]' 헤더) 개수를 센다 = 실제 N 카운트.
count_blocks() { secret-tool search --all "$@" 2>/dev/null | grep -c '^\[/' || true; }

echo "================================================================"
echo " secret-tool 실측 round-trip e2e  (service=$SVC)"
echo "================================================================"

# ── 검증 1: store → lookup round-trip ────────────────────────────
echo "[1] store → lookup round-trip"
echo -n 'token-alice' | secret-tool store --label="$SVC" service "$SVC" account alice 2>/dev/null
got="$(secret-tool lookup service "$SVC" account alice 2>/dev/null)"
[ "$got" = "token-alice" ] && ok "lookup 이 저장값 반환" || bad "lookup 불일치: [$got]"

# ── 검증 2: store 는 upsert(덮어쓰기) ────────────────────────────
echo "[2] 동일 (service,account) 재store = upsert"
echo -n 'token-alice-v2' | secret-tool store --label="$SVC" service "$SVC" account alice 2>/dev/null
got="$(secret-tool lookup service "$SVC" account alice 2>/dev/null)"
n="$(count_blocks service "$SVC" account alice)"
{ [ "$got" = "token-alice-v2" ] && [ "$n" = "1" ]; } \
  && ok "재store 후 값=v2, block=1 (upsert 확정)" \
  || bad "upsert 실패: 값=[$got] block=[$n]"

# ── 검증 3: (service,account) 2-attr 조회는 N=1 ──────────────────
echo "[3] 2-attribute 조회 유일성"
n="$(count_blocks service "$SVC" account alice)"
[ "$n" = "1" ] && ok "service+account 조회 = N=1" || bad "N=$n (1 기대)"

# ── 검증 4: account-recovery gap (§197, 가장 중요) ──────────────
echo "[4] account-recovery gap — service-only 조회 collision"
echo -n 'token-bob' | secret-tool store --label="$SVC" service "$SVC" account bob 2>/dev/null
n_svc="$(count_blocks service "$SVC")"
n_alice="$(count_blocks service "$SVC" account alice)"
n_bob="$(count_blocks service "$SVC" account bob)"
{ [ "$n_svc" = "2" ] && [ "$n_alice" = "1" ] && [ "$n_bob" = "1" ]; } \
  && ok "service-only=N2 / 각 account=N1 (collision 은 service-only 조회에서만)" \
  || bad "collision 시맨틱 불일치: svc=$n_svc alice=$n_alice bob=$n_bob"

# ── 검증 5: clear deletes-all (Scenario 4) ──────────────────────
# 단일 account clear 는 그 account 만 삭제(sibling 생존)해야 한다.
echo "[5] clear 2-attribute = 단일 삭제 (sibling 생존)"
secret-tool clear service "$SVC" account alice 2>/dev/null
n_alice="$(count_blocks service "$SVC" account alice)"
n_bob="$(count_blocks service "$SVC" account bob)"
{ [ "$n_alice" = "0" ] && [ "$n_bob" = "1" ]; } \
  && ok "alice 삭제됨, bob 생존 (2-attr clear 는 안전)" \
  || bad "clear 범위 오류: alice=$n_alice bob=$n_bob"

# service-only clear 는 매칭 전부 삭제(deletes-all) — N>1 일 때 위험함을 실증.
echo "[6] clear service-only = deletes-all (N>1 위험 실증)"
echo -n 'token-carol' | secret-tool store --label="$SVC" service "$SVC" account carol 2>/dev/null
before="$(count_blocks service "$SVC")"   # bob + carol = 2
secret-tool clear service "$SVC" 2>/dev/null
after="$(count_blocks service "$SVC")"
{ [ "$before" = "2" ] && [ "$after" = "0" ]; } \
  && ok "service-only clear 가 N=2 를 전부 삭제 (→ PR-3b 는 clear 전 N=1 검증 필수)" \
  || bad "deletes-all 미확인: before=$before after=$after"

# ── 검증 7: 부재는 exit 0 + 빈 출력 ─────────────────────────────
echo "[7] 부재 판정 = exit 0 + 빈 출력 (exit code 로 부재 판정 불가)"
out="$(secret-tool search --all service "$SVC" account ghost 2>/dev/null)"; ec=$?
{ [ "$ec" = "0" ] && [ -z "$out" ]; } \
  && ok "부재 시 exit=0, 빈 출력" \
  || bad "부재 동작 예상과 다름: exit=$ec out=[$out]"

# ── 옵션: mock fixture 파생용 실측 출력 캡처 ────────────────────
if [ -n "$CAPTURE_DIR" ]; then
  echo "[capture] 실측 stdout/stderr 를 $CAPTURE_DIR 에 저장 (PR-3b mock 파생 소스)"
  # 앞선 검증 단계의 잔여 항목을 비워 fixture 카운트(N0/N1/N2)를 정확히 만든다.
  secret-tool clear service "$SVC" >/dev/null 2>&1 || true
  cap() { # $1=케이스명, 나머지=search attrs
    local name="$1"; shift
    secret-tool search --all "$@" \
      1>"$CAPTURE_DIR/$name.stdout" 2>"$CAPTURE_DIR/$name.stderr" || true
    echo "    캡처: $name (stdout=$(wc -c <"$CAPTURE_DIR/$name.stdout")B, stderr=$(wc -c <"$CAPTURE_DIR/$name.stderr")B)"
  }
  # 각 케이스를 독립적으로 setup 한다(케이스 간 항목 누적 방지 → N 카운트 정확).
  # N=0 — 매칭 없음
  secret-tool clear service "$SVC" >/dev/null 2>&1 || true
  cap "search-n0" service "$SVC" account none
  # N=1 — 단일 매칭(backup 케이스)
  echo -n 'cap-alice' | secret-tool store --label="$SVC" service "$SVC" account alice 2>/dev/null
  cap "search-n1" service "$SVC" account alice
  # N=1 — secret 에 등호/개행 포함(블록 파싱 안정성 F2 가드용)
  secret-tool clear service "$SVC" >/dev/null 2>&1 || true
  printf 'has=eq\nand-newline' | secret-tool store --label="$SVC" service "$SVC" account weird 2>/dev/null
  cap "search-n1-multiline-secret" service "$SVC" account weird
  # N=2 — service-only 조회 collision(clear deletes-all 차단 케이스)
  secret-tool clear service "$SVC" >/dev/null 2>&1 || true
  echo -n 'cap-alice' | secret-tool store --label="$SVC" service "$SVC" account alice 2>/dev/null
  echo -n 'cap-bob'   | secret-tool store --label="$SVC" service "$SVC" account bob   2>/dev/null
  cap "search-n2-service-only" service "$SVC"
  # CAPTURE 환경(service)/타임스탬프는 가변이므로, fixture 정규화는 PR-3b 에서
  # 별도 처리(이 파일들은 '실측 grounding 원본'으로만 사용).
fi

# ── 정리 ────────────────────────────────────────────────────────
secret-tool clear service "$SVC" 2>/dev/null || true
for acct in alice bob carol weird; do
  secret-tool clear service "$SVC" account "$acct" 2>/dev/null || true
done

echo "================================================================"
echo " 결과: PASS=$PASS  FAIL=$FAIL"
echo "================================================================"
[ "$FAIL" -eq 0 ]
