#!/bin/sh
# In-container: preconfigure gpredict (ENIGMA-1 + OpenVSA rotator/radio), run it
# under libfaketime (so the web "reset to next pass" button can jump its clock),
# and stream over noVNC. rotctld/rigctld HOST are rewritten to reach the host's
# scenario-1 VSA (rotctld :4533, rigctld :4532, VSA-DEFCON2026/server.js).
#
# TLE registration: local /config/enigma1.tle → gpredict DB (satdata/90001.sat) +
# module, so ENIGMA-1 is trackable on launch. The raw .tle stays under /config so
# the user can also re-import via  Edit ▸ Update TLE data ▸ From local files… .
set -e
CFG=/root/.config/Gpredict
mkdir -p "$CFG/satdata" "$CFG/hwconf" "$CFG/modules" "$CFG/trsp"
NAME=ENIGMA-1

if [ -d /config ]; then
  cp -f /config/defcon.qth "$CFG/" 2>/dev/null || true
  # rotator → host rotctld (gpredict wants group [Rotator], key Host)
  sed "s/^Host=.*/Host=${ROTCTLD_HOST:-host.docker.internal}/" /config/OpenVSA.rot \
      > "$CFG/hwconf/OpenVSA.rot" 2>/dev/null || true
  # radio → host rigctld :4532 (group [Radio]) for Doppler tuning
  sed "s/^Host=.*/Host=${ROTCTLD_HOST:-host.docker.internal}/" /config/OpenVSA.rig \
      > "$CFG/hwconf/OpenVSA.rig" 2>/dev/null || true

  # local TLE → gpredict .sat DB entry (registers ENIGMA-1, catalog 90001)
  if [ -f /config/enigma1.tle ]; then
    CAT=$(sed -n '2p' /config/enigma1.tle | cut -c3-7 | tr -d ' ')
    L1=$(sed -n '2p' /config/enigma1.tle)
    L2=$(sed -n '3p' /config/enigma1.tle)
    NAME=$(sed -n '1p' /config/enigma1.tle | tr -d '\r')
    : "${CAT:=90001}"
    cat > "$CFG/satdata/${CAT}.sat" <<EOF
[Satellite]
VERSION=1.0
NAME=${NAME}
NICKNAME=${NAME}
TLE1=${L1}
TLE2=${L2}
STATUS=0
EOF
    cat > "$CFG/modules/${NAME}.mod" <<EOF
[GLOBAL]
VERSION=1.4
TIMEOUT=250
GRID=1
QTHFILE=defcon.qth
SATELLITES=${CAT}
EOF
  fi
fi

# faketime: 첫 기동도 '다음 좋은 패스 LEAD초 전'에서 시작(실시간 아님). control.py --seed 가
# 오프셋을 미리 기록하고, 이후 리셋은 파일만 갱신해 gpredict 재시작 없이 실시간 반영된다.
# (FAKETIME_TIMESTAMP_FILE + FAKETIME_NO_CACHE=1 → 아래 supervisor 의 gpredict 가 파일을 실시간 재읽기)
FT="${FAKETIME_FILE:-/tmp/faketime.rc}"
QTH_FILE="$CFG/defcon.qth" TLE_FILE=/config/enigma1.tle python3 /control.py --seed >/tmp/seed.log 2>&1 \
  || echo '+0' > "$FT"      # 패스 계산 실패 시 실시간(+0)로 폴백
LIB=$(ls /usr/lib/*/faketime/libfaketime.so.1 2>/dev/null | head -1)

Xvfb :99 -screen 0 "${GEOM:-1280x900x24}" >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99
openbox >/dev/null 2>&1 &

# time-control server (:6079) — computes next AOS, writes faketime (no restart; live re-read)
QTH_FILE="$CFG/defcon.qth" TLE_FILE=/config/enigma1.tle python3 /control.py >/dev/null 2>&1 &

# gpredict supervisor: (re)write the open-modules cfg and launch under libfaketime;
# relaunch whenever it exits (the reset button SIGTERMs it → it reopens at new time).
(
  while true; do
    cat > "$CFG/gpredict.cfg" <<EOF
[GLOBAL]
OPEN_MODULES=${NAME}
WINDOW_WIDTH=1280
WINDOW_HEIGHT=900
EOF
    LD_PRELOAD="$LIB" FAKETIME_TIMESTAMP_FILE="$FT" FAKETIME_NO_CACHE=1 \
      FAKETIME_DONT_FAKE_MONOTONIC=1 gpredict >/dev/null 2>&1 || true
    sleep 1
  done
) &

x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6080}" localhost:"${VNC_PORT:-5900}"
