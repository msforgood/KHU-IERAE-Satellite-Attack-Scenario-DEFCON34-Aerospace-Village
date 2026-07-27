#!/bin/sh
# In-container: preconfigure gpredict (ENIGMA-1 + OpenVSA rotator/radio), run it
# under libfaketime (so the web "reset to next pass" button can jump its clock),
# and stream over noVNC. rotctld/rigctld HOST are rewritten to reach the host's
# scenario-1 VSA (rotctld :4533, rigctld :4532, VSA-DEFCON2026/server.js).
#
# TLE registration: local /config/enigma1.tle → gpredict DB (satdata/90001.sat) +
# module, so ENIGMA-1 is trackable on launch. The raw .tle stays under /config so
# the user can also re-import via  Edit > Update TLE data > From local files... .
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
    # transponder: 433.5 MHz beacon so Radio Control tracks the real downlink (+Doppler), not the 145.89 default
    cat > "$CFG/trsp/${CAT}.trsp" <<EOF
[ENIGMA-1 beacon 433.5 MHz]
DOWN_LOW=433500000
EOF
  fi
fi

# faketime: even the first launch starts at 'LEAD seconds before the next good pass' (not real time). control.py --seed
# records the offset in advance, and later resets only update the file, so changes take effect live without restarting gpredict.
# (FAKETIME_TIMESTAMP_FILE + FAKETIME_NO_CACHE=1 -> the gpredict under the supervisor below re-reads the file live)
FT="${FAKETIME_FILE:-/tmp/faketime.rc}"
QTH_FILE="$CFG/defcon.qth" TLE_FILE=/config/enigma1.tle python3 /control.py --seed >/tmp/seed.log 2>&1 \
  || echo '+0' > "$FT"      # if the pass computation fails, fall back to real time (+0)
LIB=$(ls /usr/lib/*/faketime/libfaketime.so.1 2>/dev/null | head -1)

Xvfb :99 -screen 0 "${GEOM:-1280x900x24}" >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99
openbox >/dev/null 2>&1 &

# time-control server (:6079) - computes next AOS, writes faketime (no restart; live re-read)
QTH_FILE="$CFG/defcon.qth" TLE_FILE=/config/enigma1.tle python3 /control.py >/dev/null 2>&1 &

# gpredict supervisor: (re)write the open-modules cfg and launch under libfaketime;
# relaunch whenever it exits (the reset button SIGTERMs it -> it reopens at new time).
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

# ── window layout: open Radio Control + Antenna (Rotator) Control from the module popup
# menu and stack them under the main window (top to bottom: GPredict / Antenna / Radio).
# The item positions are relative to the module popup button (top-right hamburger), computed
# from the live window geometry. Re-runs whenever a control window is missing (e.g. after the
# reset button relaunches gpredict), so the layout self-heals.
(
  set +e
  sleep 4
  while true; do
    MAIN=$(xdotool search --name "Gpredict: " 2>/dev/null | head -1)
    if [ -n "$MAIN" ]; then
      HASR=$(wmctrl -l 2>/dev/null | grep -c "Radio Control")
      HASA=$(wmctrl -l 2>/dev/null | grep -c "Rotator Control")
      if [ "$HASR" = "0" ] || [ "$HASA" = "0" ]; then
        wmctrl -ir "$MAIN" -e "0,0,0,870,580"; sleep 0.6   # taller, less-wide main window (gpredict redraws to fit; it may grow past 580 tall, so the control windows below are pushed down to clear it)
        eval "$(xdotool getwindowgeometry --shell "$MAIN")"
        HX=$((X + WIDTH - 24)); HY=$((Y + 22))                     # module popup (hamburger) button
        if [ "$HASR" = "0" ]; then                                # open Radio Control
          xdotool windowactivate "$MAIN"; sleep 0.3
          xdotool mousemove "$HX" "$HY" click 1; sleep 0.5
          xdotool mousemove "$((HX - 156))" "$((HY + 168))" click 1; sleep 0.8
        fi
        if [ "$HASA" = "0" ]; then                                # open Antenna (Rotator) Control
          xdotool windowactivate "$MAIN"; sleep 0.3
          xdotool mousemove "$HX" "$HY" click 1; sleep 0.5
          xdotool mousemove "$((HX - 156))" "$((HY + 183))" click 1; sleep 0.8
        fi
        wmctrl -r "Gpredict Rotator Control" -e "0,0,930,1280,330"    # Antenna (moved down +340 to clear the taller main window)
        wmctrl -r "Gpredict Radio Control"   -e "0,0,1270,1280,412"   # Radio (moved down +340; control.py hit coords shifted to match)
        xdotool mousemove 12 12                                      # park the pointer
      fi
    fi
    sleep 4
  done
) &

x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6080}" localhost:"${VNC_PORT:-5900}"
