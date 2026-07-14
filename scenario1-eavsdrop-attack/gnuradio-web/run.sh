#!/usr/bin/env bash
# Build + run the isolated GNU-Radio-in-Docker. Nothing installs on the host.
# GNU Radio Companion -> http://localhost:6081/vnc.html?autoconnect=1&resize=remote
# The answer flowgraph opens ready to Run: it reads the mounted recording and
# writes the recovered image to ./gnuradio-out/ on the host.
set -e
cd "$(dirname "$0")"
IMG=${IMG:-enigma1-gnuradio}
PORT=${WEB_PORT:-6081}

if ! command -v docker >/dev/null 2>&1; then
  echo "x The docker command was not found. Please install Docker Desktop." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "x The Docker daemon is not running. Please start Docker Desktop first." >&2
  echo "  (5) The GNU Radio screen only appears for real once this container is up. If it is not running, web-guide falls back to a static flowgraph." >&2
  exit 1
fi

# -- bind-mount targets so the flowgraph is actually runnable ------------------
# File Source: if there is a recording uploaded in PHASE 4 (web/server.py saves it into upload/), use that;
# otherwise use the built-in 96 kSps recording. samp_rate is passed to start.sh to match the .grc.
UPLOAD_DIR="$PWD/upload"
if [ -f "$UPLOAD_DIR/uploaded.cf32" ]; then
  REC="$UPLOAD_DIR/uploaded.cf32"                            # PHASE 4 uploaded recording
  SAMP_RATE="$(cat "$UPLOAD_DIR/samp_rate.txt" 2>/dev/null)"; SAMP_RATE="${SAMP_RATE:-50000}"
else
  REC="$(cd .. && pwd)/signal/enigma34_downlink.cf32"       # default 96 kSps recording
  SAMP_RATE=96000
fi
export SAMP_RATE
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
OUT="$(cd .. && pwd)/gnuradio-out"                            # recovered PNG lands here (host)
mkdir -p "$OUT"

if [ ! -f "$REC" ]; then
  echo "! The recording file is missing: $REC" >&2
  echo "  Run reads this file as the File Source. Without it the flowgraph still displays, but it will not decode." >&2
fi

docker build -t "$IMG" .
URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "-----------------------------------------------"
echo " GNU Radio (web) -> $URL"
echo " File Source     -> $REC  (samp_rate=$SAMP_RATE)"
echo " Run to save the recovered image here: $OUT"
echo " web-guide integration -> GNURADIO_URL='$URL' python3 ../web-guide/server.py"
echo "-----------------------------------------------"
exec docker run --rm -p "$PORT:6081" \
  -e SAMP_RATE="$SAMP_RATE" \
  -v "$REC:$SIG:ro" \
  -v "$OUT:$SOL" \
  -v "$(cd .. && pwd)/decoder:/grc:ro" \
  "$IMG"
