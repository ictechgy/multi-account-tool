#!/usr/bin/env bash
#
# run.sh — Linux keyring 개발/테스트 컨테이너를 빌드하고 명령을 실행한다.
#
# 사용 예:
#   docker/run.sh                       # 대화형 bash 셸 (keyring 활성 상태)
#   docker/run.sh npm ci                # 의존성 설치 (named volume 에 캐시)
#   docker/run.sh npm test              # 전체 테스트 (Linux + secret-tool 환경)
#   docker/run.sh bash scripts/secret-tool-e2e.sh   # 실 keyring round-trip e2e
#
# node_modules 는 named volume(mat_node_modules)에 격리한다 — 호스트(macOS)와
# 컨테이너(Linux)의 네이티브 바이너리가 충돌하지 않도록.
# 따라서 코드를 처음 받은 뒤 한 번은 `docker/run.sh npm ci` 가 필요하다.

set -euo pipefail

IMAGE_NAME="mat-linux-keyring"
VOLUME_NAME="mat_node_modules"

# 스크립트 위치 기준으로 프로젝트 루트를 찾는다(어디서 호출해도 동작).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 이미지 빌드 (레이어 캐시로 재빌드는 빠름).
docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR"

# TTY 가 있으면 -it, 없으면(CI/파이프) -i 만.
tty_flags=(-i)
if [ -t 0 ] && [ -t 1 ]; then
  tty_flags=(-it)
fi

# 인자가 없으면 기본 CMD(bash) 로 떨어진다.
exec docker run --rm "${tty_flags[@]}" \
  -v "$PROJECT_ROOT:/work" \
  -v "$VOLUME_NAME:/work/node_modules" \
  "$IMAGE_NAME" "$@"
