#!/bin/sh
# In-container: preconfigure gpredict (DEMOSAT + OpenVSA rotator), run headless,
# stream over noVNC. The rotator HOST is rewritten to reach the host machine's
# OpenVSA rotctld (:4533) from inside the container.
set -e
CFG=/root/.config/Gpredict
mkdir -p "$CFG/satdata" "$CFG/hwconf" "$CFG/modules"
if [ -d /config ]; then
  cp -f /config/demosat.tle "$CFG/satdata/" 2>/dev/null || true
  cp -f /config/70003.sat   "$CFG/satdata/" 2>/dev/null || true
  cp -f /config/defcon.qth  "$CFG/"         2>/dev/null || true
  cp -f /config/DEMOSAT.mod  "$CFG/modules/" 2>/dev/null || true
  cp -f /config/gpredict.cfg "$CFG/"         2>/dev/null || true
  sed "s/^HOST=.*/HOST=${ROTCTLD_HOST:-host.docker.internal}/" /config/OpenVSA.rot \
      > "$CFG/hwconf/OpenVSA.rot" 2>/dev/null || true
fi

Xvfb :99 -screen 0 "${GEOM:-1280x900x24}" >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99
openbox >/dev/null 2>&1 &
gpredict >/dev/null 2>&1 &
x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6080}" localhost:"${VNC_PORT:-5900}"
