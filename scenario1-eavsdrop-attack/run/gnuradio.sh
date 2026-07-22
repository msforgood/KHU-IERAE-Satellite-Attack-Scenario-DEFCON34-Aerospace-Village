#!/usr/bin/env bash
# [WSL/Docker] (3) gnuradio container  (noVNC:$GN_WEB_PORT)
#   If a PHASE4 upload exists (gnuradio-web/upload/uploaded.cf32), use it as the File Source (applying samp_rate),
#   otherwise use the default 96k recording (enigma34_downlink.cf32). Run output png files go to gnuradio-out/.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v docker >/dev/null 2>&1 || { err "docker not found - check that Docker Desktop is running"; exit 1; }
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
if [ -f "$SCEN1/gnuradio-web/upload/uploaded.cf32" ]; then
  REC="$HOSTBASE/gnuradio-web/upload/uploaded.cf32"
  SR="$(cat "$SCEN1/gnuradio-web/upload/samp_rate.txt" 2>/dev/null)"; SR="${SR:-50000}"
else
  REC="$HOSTBASE/signal/enigma34_downlink.cf32"; SR=96000
fi
docker image inspect "$GN_IMG" >/dev/null 2>&1 || { log "building image $GN_IMG"; docker build -t "$GN_IMG" "$HOSTBASE/gnuradio-web" || exit 1; }
docker rm -f "$GN_NAME" >/dev/null 2>&1
mkdir -p "$SCEN1/gnuradio-out"
log "starting gnuradio -> noVNC localhost:$GN_WEB_PORT (samp_rate=$SR)"
docker run -d --rm --name "$GN_NAME" -p "$GN_WEB_PORT:6081" \
  -e SAMP_RATE="$SR" \
  -v "$REC:$SIG:ro" \
  -v "$HOSTBASE/gnuradio-out:$SOL" \
  -v "$HOSTBASE/decoder:/grc:ro" \
  "$GN_IMG" >/dev/null || { err "docker run failed"; exit 1; }
sleep 4
check_http "$GN_WEB_PORT" "gnuradio noVNC"
