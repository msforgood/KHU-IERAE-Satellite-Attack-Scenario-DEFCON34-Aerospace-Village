#!/usr/bin/env bash
# Build + run the isolated gpredict-in-Docker. Nothing installs on the host.
# gpredict UI → http://localhost:6080/vnc.html?autoconnect=1&resize=remote
set -e
cd "$(dirname "$0")"
IMG=${IMG:-demosat-gpredict}
PORT=${WEB_PORT:-6080}

# The #1 cause of "build failed" here is a stopped Docker daemon — surface it clearly.
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하세요." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker 데몬이 실행 중이 아닙니다. Docker Desktop을 먼저 켜세요 (open -a Docker)." >&2
  echo "  ③ 조준 화면(gpredict)은 이 컨테이너가 떠야 동작합니다. 나머지 화면은 데몬 없이도 정상." >&2
  exit 1
fi

# 리셋마다(부스에서 참가자 교체 때마다) up 이 이 스크립트를 다시 부른다. 이미지가 이미
# 있으면 재빌드하지 않는다 — 매번 컨텍스트 해시+레이어 캐시 확인만 해도 리셋이 느려지고,
# 인터넷이 없는 부스 현장에서는(레지스트리 접근 불가) 캐시가 조금만 어긋나도 그대로 실패한다.
# 최초 빌드는 './start-attacker.sh install' 이 미리(인터넷 있을 때) 해둔다. 이미지를 새로
# 받아야 할 때만 REBUILD=1 로 강제한다.
if [ "${REBUILD:-0}" = "1" ] || ! docker image inspect "$IMG" >/dev/null 2>&1; then
  docker build -t "$IMG" .
fi

# gpredict-config 볼륨 마운트(Windows Git-Bash 대응):
#   Git Bash(MSYS)는 '-v ...:/config:ro' 의 '/config' 를 자동으로 'C:\Program Files\Git\config'
#   로 바꿔버린다(POSIX→Win 경로 변환). 그러면 컨테이너에 /config 가 안 붙고 start.sh 의
#   '[ -d /config ]' 블록이 통째로 스킵돼 DEMOSAT .sat/.mod 가 안 만들어짐 → gpredict 창이
#   위성 없이 빈 화면으로 뜬다. 그래서 ① 변환을 끄고(MSYS_NO_PATHCONV=1) ② 호스트 소스는
#   Docker Desktop 이 이해하는 Windows 경로(C:/...)로 cygpath 변환한다.
CFG_SRC="$(cd .. && pwd)/gpredict-config"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|*NT*)
    export MSYS_NO_PATHCONV=1
    CFG_SRC="$(cygpath -m "$CFG_SRC" 2>/dev/null || echo "$CFG_SRC")" ;;
esac

URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "───────────────────────────────────────────────"
echo " gpredict (web) → $URL"
echo " time-control   → http://localhost:${CTRL_PORT:-6079}/status  (phase3 → /arm)"
echo "───────────────────────────────────────────────"
exec docker run --rm -p "$PORT:6080" -p "${CTRL_PORT:-6079}:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="${ROTCTLD_HOST:-host.docker.internal}" \
  -v "$CFG_SRC:/config:ro" \
  "$IMG"
