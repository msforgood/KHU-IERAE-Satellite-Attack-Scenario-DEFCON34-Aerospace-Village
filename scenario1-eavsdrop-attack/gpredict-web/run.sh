#!/usr/bin/env bash
# Build + run the isolated gpredict-in-Docker. Nothing installs on the host.
# gpredict UI → http://localhost:6080/vnc.html?autoconnect=1&resize=remote
# Point the web-guide at it:  GPREDICT_URL="<그 URL>" python3 web-guide/server.py
set -e
cd "$(dirname "$0")"
IMG=${IMG:-enigma1-gpredict}
PORT=${WEB_PORT:-6080}

# The #1 cause of "build failed" here is a stopped Docker daemon — surface it clearly.
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하세요." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker 데몬이 실행 중이 아닙니다. Docker Desktop을 먼저 켜세요." >&2
  echo "  ③ 조준 화면(gpredict)은 이 컨테이너가 떠야 실물로 보입니다. 미실행 시 web-guide는 폴라 프리뷰로 대체." >&2
  exit 1
fi

# WSL 감지: Docker Desktop의 host.docker.internal 은 Windows 호스트를 가리키는데
# 지상국(Virtual Antenna server.js)은 보통 WSL 배포판 안에서 돈다. 그래서 컨테이너가 server.js
# (:4533/:4532)에 닿도록 ROTCTLD_HOST 를 WSL IP 로 자동 설정한다(명시 지정 시 그대로 사용).
if [ -z "${ROTCTLD_HOST:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  ROTCTLD_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$ROTCTLD_HOST" ] && echo "  (WSL 감지 → ROTCTLD_HOST=$ROTCTLD_HOST 자동설정)"
fi

docker build -t "$IMG" .
URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "───────────────────────────────────────────────"
echo " gpredict (web) → $URL"
echo " web-guide 연동 → GPREDICT_URL='$URL' python3 ../web-guide/server.py"
echo "───────────────────────────────────────────────"
exec docker run --rm -p "$PORT:6080" -p "${CTRL_PORT:-6079}:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="${ROTCTLD_HOST:-host.docker.internal}" \
  -v "$(cd .. && pwd)/gpredict-config:/config:ro" \
  "$IMG"
