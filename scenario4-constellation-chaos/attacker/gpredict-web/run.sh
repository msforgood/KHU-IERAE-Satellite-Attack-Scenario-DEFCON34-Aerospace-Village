#!/usr/bin/env bash
# Build + run the isolated gpredict-in-Docker. Nothing installs on the host.
# gpredict UI → http://localhost:6080/vnc.html?autoconnect=1&resize=remote
set -e
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1   # Windows Git Bash: keep the /config mount target from being path-converted
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

docker build -t "$IMG" .
URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "───────────────────────────────────────────────"
echo " gpredict (web) → $URL"
echo " time-control   → http://localhost:${CTRL_PORT:-6079}/status  (phase3 → /arm)"
echo "───────────────────────────────────────────────"
exec docker run --rm -p "$PORT:6080" -p "${CTRL_PORT:-6079}:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="${ROTCTLD_HOST:-host.docker.internal}" \
  -v "$(cd .. && pwd)/gpredict-config:/config:ro" \
  "$IMG"
