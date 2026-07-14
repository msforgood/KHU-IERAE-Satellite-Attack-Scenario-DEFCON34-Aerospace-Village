#!/usr/bin/env bash
# Build + run the isolated GNU-Radio-in-Docker. Nothing installs on the host.
# GNU Radio Companion → http://localhost:6081/vnc.html?autoconnect=1&resize=remote
# The answer flowgraph opens ready to ▶ Run: it reads the mounted recording and
# writes the recovered image to ./gnuradio-out/ on the host.
set -e
cd "$(dirname "$0")"
IMG=${IMG:-enigma1-gnuradio}
PORT=${WEB_PORT:-6081}

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하세요." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker 데몬이 실행 중이 아닙니다. Docker Desktop을 먼저 켜세요." >&2
  echo "  ⑤ GNU Radio 화면은 이 컨테이너가 떠야 실물로 보입니다. 미실행 시 web-guide는 정적 flowgraph로 대체." >&2
  exit 1
fi

# ── bind-mount targets so the flowgraph is actually runnable ──────────────────
# File Source: PHASE 4 에서 업로드한 녹음(web/server.py 가 upload/ 에 저장)이 있으면 그걸,
# 없으면 기본 제공 96 kSps 녹음을 쓴다. samp_rate 는 start.sh 로 넘겨 .grc 를 맞춘다.
UPLOAD_DIR="$PWD/upload"
if [ -f "$UPLOAD_DIR/uploaded.cf32" ]; then
  REC="$UPLOAD_DIR/uploaded.cf32"                            # PHASE 4 업로드 녹음
  SAMP_RATE="$(cat "$UPLOAD_DIR/samp_rate.txt" 2>/dev/null)"; SAMP_RATE="${SAMP_RATE:-50000}"
else
  REC="$(cd .. && pwd)/enigma34_downlink.cf32"              # 기본 제공 96 kSps 녹음
  SAMP_RATE=96000
fi
export SAMP_RATE
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
OUT="$(cd .. && pwd)/gnuradio-out"                            # recovered PNG lands here (host)
mkdir -p "$OUT"

if [ ! -f "$REC" ]; then
  echo "⚠ 녹음 파일이 없습니다: $REC" >&2
  echo "  Run 은 이 파일을 File Source 로 읽습니다. 없으면 flowgraph 표시는 되지만 디코드는 안 됩니다." >&2
fi

docker build -t "$IMG" .
URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "───────────────────────────────────────────────"
echo " GNU Radio (web) → $URL"
echo " File Source     → $REC  (samp_rate=$SAMP_RATE)"
echo " ▶ Run 하면 복원 이미지가 여기로 저장됩니다: $OUT"
echo " web-guide 연동   → GNURADIO_URL='$URL' python3 ../web-guide/server.py"
echo "───────────────────────────────────────────────"
exec docker run --rm -p "$PORT:6081" \
  -e SAMP_RATE="$SAMP_RATE" \
  -v "$REC:$SIG:ro" \
  -v "$OUT:$SOL" \
  -v "$(cd .. && pwd)/postProcess:/grc:ro" \
  "$IMG"
