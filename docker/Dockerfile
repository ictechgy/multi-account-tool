# Linux Secret Service(secret-tool) 개발/테스트 환경
#
# 목적: macOS 개발 머신에서 OS keyring(os-keyring source type) PR-3b 이후를
#       개발/검증하기 위한 Linux 컨테이너. ubuntu:24.04 + node 20 으로
#       CI 의 ubuntu-latest 러너 환경과 일치시킨다.
#
# 핵심: headless 환경에서 gnome-keyring 을 빈 password 로 unlock 해
#       secret-tool store/search/clear 가 실제로 동작하게 만든다.
#       (unlock 레시피는 keyring-entrypoint.sh 참조)
#
# 빌드/실행은 docker/run.sh 를 사용한다.

FROM ubuntu:24.04

# noninteractive: apt 가 tzdata 등에서 프롬프트로 멈추지 않게 한다.
ENV DEBIAN_FRONTEND=noninteractive

# libsecret-tools: secret-tool 바이너리 제공 (Linux Secret Service CLI)
# gnome-keyring: Secret Service daemon 구현 (실제 자격증명 저장소)
# dbus-x11: dbus-launch / dbus-run-session (Secret Service 는 D-Bus 세션 버스 필요)
# curl/ca-certificates: NodeSource 설치용
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libsecret-tools \
        gnome-keyring \
        dbus-x11 \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20.x — ubuntu:24.04 기본 node(18.19) 는 vitest 4(rolldown) 가
# 요구하는 node:util.styleText(20+) 미지원이라 NodeSource 로 20 을 설치한다.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# keyring 환경을 셋업한 뒤 인자로 받은 명령을 실행하는 entrypoint.
COPY keyring-entrypoint.sh /usr/local/bin/keyring-entrypoint.sh
RUN chmod +x /usr/local/bin/keyring-entrypoint.sh

# 마운트 포인트: docker/run.sh 가 프로젝트 루트를 여기에 bind-mount 한다.
# /work/node_modules 를 미리 ubuntu 소유로 만들어 두면, run.sh 가 거기에
# named volume 을 마운트할 때 docker 가 이 소유권(ubuntu)으로 초기화한다.
# (호스트/컨테이너 arm64-darwin vs arm64-linux 네이티브 바이너리 충돌 회피)
RUN mkdir -p /work/node_modules && chown -R ubuntu:ubuntu /work
WORKDIR /work

# root 실행을 피한다(보안 모범사례). ubuntu(uid 1000) 는 ubuntu:24.04 기본 user.
# gnome-keyring 은 user 단위로 동작하므로 비-root 에서도 unlock 이 정상 동작한다.
USER ubuntu

ENTRYPOINT ["/usr/local/bin/keyring-entrypoint.sh"]
CMD ["bash"]
