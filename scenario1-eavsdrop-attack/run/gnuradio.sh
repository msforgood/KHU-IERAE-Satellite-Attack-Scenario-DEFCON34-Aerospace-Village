#!/usr/bin/env bash
# [WSL/Docker] (3) gnuradio container  (noVNC:$GN_WEB_PORT)
#   If a PHASE4 upload exists (gnuradio-web/upload/uploaded.cf32), use it as the File Source (applying samp_rate),
#   otherwise use the default 96k recording (enigma34_downlink.cf32). Run output png files go to gnuradio-out/.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
command -v docker >/dev/null 2>&1 || { err "docker not found - check that Docker Desktop is running"; exit 1; }
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
docker image inspect "$GN_IMG" >/dev/null 2>&1 || { log "building image $GN_IMG"; docker build -t "$GN_IMG" "$HOSTBASE/gnuradio-web" || exit 1; }
# Remove the old container FIRST so its bind-mount on the input file is released before we touch it.
docker rm -f "$GN_NAME" >/dev/null 2>&1
mkdir -p "$SCEN1/gnuradio-out"
# Start every decode from a black image: drop the previous run's recovered image + progressive state
# so a fresh File Source is not painted on top of a previous participant's persisted buffer (the
# reassembler preloads persist.raw). reset.sh also clears these; this also covers a bare gnuradio recreate.
rm -f "$SCEN1/gnuradio-out/"*.png "$SCEN1/gnuradio-out/"*_progress.txt \
      "$SCEN1/gnuradio-out/persist.raw" "$SCEN1/gnuradio-out/offset.txt" 2>/dev/null || true
# Mount a COPY of the upload, not the server's own uploaded.cf32. The web server owns uploaded.cf32
# and must overwrite it on every new recording; a file that is bind-mounted into a running container
# CANNOT be rewritten on WSL2/drvfs (the path gets corrupted -> future recordings fail to save). So
# copy it to uploaded_gr.cf32 (which the server never touches) and mount that instead.
UPGR="$SCEN1/gnuradio-web/upload/uploaded_gr.cf32"
if [ -f "$SCEN1/gnuradio-web/upload/uploaded.cf32" ]; then
  cp -f "$SCEN1/gnuradio-web/upload/uploaded.cf32" "$UPGR" 2>/dev/null
  REC="$HOSTBASE/gnuradio-web/upload/uploaded_gr.cf32"
  SR="$(cat "$SCEN1/gnuradio-web/upload/samp_rate.txt" 2>/dev/null)"; SR="${SR:-50000}"
else
  rm -f "$UPGR" 2>/dev/null
  REC="$HOSTBASE/signal/enigma34_downlink.cf32"; SR=96000
fi
log "starting gnuradio -> noVNC localhost:$GN_WEB_PORT (samp_rate=$SR)"
docker run -d --rm --name "$GN_NAME" -p "$GN_WEB_PORT:6081" \
  -e SAMP_RATE="$SR" \
  -v "$REC:$SIG:ro" \
  -v "$HOSTBASE/gnuradio-out:$SOL" \
  -v "$HOSTBASE/decoder:/grc:ro" \
  "$GN_IMG" >/dev/null || { err "docker run failed"; exit 1; }
sleep 4
check_http "$GN_WEB_PORT" "gnuradio noVNC"
