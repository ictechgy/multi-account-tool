#!/usr/bin/env bash
#
# keyring-entrypoint.sh — headless 환경에서 gnome-keyring(Secret Service)을
# 활성화한 뒤 인자로 받은 명령을 실행한다.
#
# 왜 이 절차가 필요한가:
#   secret-tool 은 D-Bus 세션 버스 위의 Secret Service daemon(gnome-keyring)에
#   의존한다. 컨테이너에는 세션 버스도, unlock 된 keyring 도 없으므로:
#     1) dbus-run-session 으로 세션 버스를 띄우고
#     2) 빈 password 로 login keyring 을 생성+unlock 한다
#        (headless 에서 login keyring 이 없으면 store 가 GUI 프롬프트를
#         띄우려다 "collection/login does not exist" 로 실패한다)
#     3) daemon 이 실제 ready 가 될 때까지 store probe 로 polling 한다
#        (unlock 직후 곧장 store 하면 "locked collection" 레이스가 난다)
#
# 이 레시피는 docker 안에서 실측 검증되었다(libsecret-tools 0.21.4 /
# gnome-keyring 46.1, ubuntu:24.04).

set -euo pipefail

# 1) D-Bus 세션 버스가 없으면 dbus-run-session 안에서 자신을 재실행한다.
#    dbus-run-session 이 DBUS_SESSION_BUS_ADDRESS 를 설정해 준다.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0" "$@"
fi

# 2) login keyring 을 빈 password 로 생성 + unlock + daemon 시작.
#    gnome-keyring-daemon 의 출력(GNOME_KEYRING_CONTROL/SSH_AUTH_SOCK)을
#    eval 해야 secret-tool 이 같은 daemon 에 연결된다.
mkdir -p "$HOME/.local/share/keyrings"
eval "$(printf '\n' | gnome-keyring-daemon --unlock 2>/dev/null)" || true
eval "$(printf '\n' | gnome-keyring-daemon --start  2>/dev/null)" || true
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK

# 3) daemon ready polling — store probe 가 성공할 때까지 최대 ~6초 대기.
keyring_ready=0
for _ in $(seq 1 20); do
  if printf 'probe' | secret-tool store --label='_mat_probe' _mat_probe ready >/dev/null 2>&1; then
    secret-tool clear _mat_probe ready >/dev/null 2>&1 || true
    keyring_ready=1
    break
  fi
  sleep 0.3
done

if [ "$keyring_ready" -ne 1 ]; then
  echo "keyring-entrypoint: gnome-keyring 을 unlock 하지 못했습니다 (secret-tool store probe 실패)." >&2
  echo "  → libsecret-tools / gnome-keyring / dbus-x11 설치 여부와 dbus 세션을 확인하세요." >&2
  exit 1
fi

# 4) keyring 준비 완료 — 요청받은 명령 실행.
exec "$@"
