#!/usr/bin/env bash
# [WSL/Docker] ③ gnuradio 컨테이너  (noVNC:$GN_WEB_PORT)
#   PHASE4 업로드(gnuradio-web/upload/uploaded.cf32) 있으면 그걸 File Source 로(samp_rate 반영),
#   없으면 기본 96k 녹음(enigma34_downlink.cf32). ▶ Run 결과 png 는 gnuradio-out/ 로.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v docker >/dev/null 2>&1 || { err "docker 없음 — Docker Desktop 실행 확인"; exit 1; }
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
if [ -f "$SCEN1/gnuradio-web/upload/uploaded.cf32" ]; then
  REC="$HOSTBASE/gnuradio-web/upload/uploaded.cf32"
  SR="$(cat "$SCEN1/gnuradio-web/upload/samp_rate.txt" 2>/dev/null)"; SR="${SR:-50000}"
else
  REC="$HOSTBASE/enigma34_downlink.cf32"; SR=96000
fi
docker image inspect "$GN_IMG" >/dev/null 2>&1 || { log "이미지 빌드 $GN_IMG"; docker build -t "$GN_IMG" "$HOSTBASE/gnuradio-web" || exit 1; }
docker rm -f "$GN_NAME" >/dev/null 2>&1
mkdir -p "$SCEN1/gnuradio-out"
log "gnuradio 시작 → noVNC localhost:$GN_WEB_PORT (samp_rate=$SR)"
docker run -d --rm --name "$GN_NAME" -p "$GN_WEB_PORT:6081" \
  -e SAMP_RATE="$SR" \
  -v "$REC:$SIG:ro" \
  -v "$HOSTBASE/gnuradio-out:$SOL" \
  -v "$HOSTBASE/postProcess:/grc:ro" \
  "$GN_IMG" >/dev/null || { err "docker run 실패"; exit 1; }
sleep 4
check_http "$GN_WEB_PORT" "gnuradio noVNC"
