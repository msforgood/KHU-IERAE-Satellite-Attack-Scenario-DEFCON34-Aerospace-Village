#!/bin/sh
# In-container: preconfigure gpredict (DEMOSAT + OpenVSA rotator), run it under
# libfaketime, and stream over noVNC. The rotator HOST is rewritten so gpredict
# reaches the host machine's OpenVSA rotctld (:4533).
#
# Time control (scenario-2): control.py (:6079) places DEMOSAT LEAD seconds before
# a grazing pass over the Las Vegas QTH and re-arms every RESET_INTERVAL seconds.
# It only rewrites the libfaketime offset file — gpredict reads it live
# (FAKETIME_NO_CACHE=1), so it is NEVER restarted and the rotctld link stays up.
#
# TLE registration: local /config/demosat.tle → gpredict DB (satdata/<cat>.sat) +
# a module, so DEMOSAT is trackable on launch (no manual New Module step).
set -e
CFG=/root/.config/Gpredict
mkdir -p "$CFG/satdata" "$CFG/hwconf" "$CFG/modules" "$CFG/trsp"
NAME=DEMOSAT
CAT=70003

if [ -d /config ]; then
  cp -f /config/defcon.qth "$CFG/" 2>/dev/null || true
  # rotator → host rotctld (gpredict wants group [Rotator], key Host)
  sed "s/^Host=.*/Host=${ROTCTLD_HOST:-host.docker.internal}/" /config/OpenVSA.rot \
      > "$CFG/hwconf/OpenVSA.rot" 2>/dev/null || true
  # radio → host rigctld :4532 (group [Radio]); harmless if unused
  if [ -f /config/OpenVSA.rig ]; then
    sed "s/^Host=.*/Host=${ROTCTLD_HOST:-host.docker.internal}/" /config/OpenVSA.rig \
        > "$CFG/hwconf/OpenVSA.rig" 2>/dev/null || true
  fi

  # local TLE → gpredict .sat DB entry (registers DEMOSAT) + module
  if [ -f /config/demosat.tle ]; then
    L1=$(sed -n '2p' /config/demosat.tle)
    L2=$(sed -n '3p' /config/demosat.tle)
    NAME=$(sed -n '1p' /config/demosat.tle | tr -d '\r')
    C=$(sed -n '2p' /config/demosat.tle | cut -c3-7 | tr -d ' ')
    [ -n "$C" ] && CAT="$C"
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
TIMEOUT=1000
GRID=1
QTHFILE=defcon.qth
SATELLITES=${CAT}
EOF
  fi
fi

# faketime offset file — control.py rewrites it; gpredict reads it live.
FT="${FAKETIME_FILE:-/tmp/faketime.rc}"
[ -f "$FT" ] || echo '+0' > "$FT"
LIB=$(ls /usr/lib/*/faketime/libfaketime.so.1 2>/dev/null | head -1)

Xvfb :99 -screen 0 "${GEOM:-1280x900x24}" >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99
openbox >/dev/null 2>&1 &

# time-control server (:6079) — finds a grazing pass, arms LEAD-before-AOS, re-arms.
QTH_FILE="$CFG/defcon.qth" TLE_FILE=/config/demosat.tle python3 /control.py >/dev/null 2>&1 &

# gpredict supervisor: write the open-modules cfg and launch under libfaketime;
# relaunch only if it exits/crashes (control.py never kills it).
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
