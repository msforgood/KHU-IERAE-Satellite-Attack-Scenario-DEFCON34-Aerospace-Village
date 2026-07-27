#!/usr/bin/env bash
# Build + run the isolated gpredict-in-Docker. Nothing installs on the host.
# gpredict UI -> http://localhost:6080/vnc.html?autoconnect=1&resize=remote
# Point the web-guide at it:  GPREDICT_URL="<that URL>" python3 web-guide/server.py
set -e
cd "$(dirname "$0")"
IMG=${IMG:-enigma1-gpredict}
PORT=${WEB_PORT:-6080}

# The #1 cause of "build failed" here is a stopped Docker daemon - surface it clearly.
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ The docker command was not found. Please install Docker Desktop." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ The Docker daemon is not running. Please start Docker Desktop first." >&2
  echo "  (3) The targeting screen (gpredict) only appears for real once this container is up. If it is not running, the web-guide falls back to a polar preview." >&2
  exit 1
fi

# WSL detection: Docker Desktop's host.docker.internal points to the Windows host,
# but the ground station (VSA server.js) usually runs inside the WSL distribution. So we
# automatically set ROTCTLD_HOST to the WSL IP so the container can reach server.js
# (:4533/:4532) (if it is set explicitly, that value is used as-is).
if [ -z "${ROTCTLD_HOST:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  ROTCTLD_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$ROTCTLD_HOST" ] && echo "  (WSL detected -> ROTCTLD_HOST=$ROTCTLD_HOST set automatically)"
fi

docker build -t "$IMG" .

# gpredict-config volume mount (Windows Git-Bash): MSYS rewrites the ':/config' path
# to 'C:\Program Files\Git\config', so /config never mounts and start.sh skips the
# '[ -d /config ]' block -> gpredict opens with no module (empty window). Disable the
# POSIX->Win path conversion and give Docker a Windows-style source path (cygpath).
CFG_SRC="$(cd .. && pwd)/gpredict-config"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|*NT*)
    export MSYS_NO_PATHCONV=1
    CFG_SRC="$(cygpath -m "$CFG_SRC" 2>/dev/null || echo "$CFG_SRC")" ;;
esac

URL="http://localhost:$PORT/vnc.html?autoconnect=1&resize=remote"
echo "-----------------------------------------------"
echo " gpredict (web) -> $URL"
echo " web-guide integration -> GPREDICT_URL='$URL' python3 ../web-guide/server.py"
echo "-----------------------------------------------"
exec docker run --rm -p "$PORT:6080" -p "${CTRL_PORT:-6079}:6079" \
  --add-host=host.docker.internal:host-gateway \
  -e ROTCTLD_HOST="${ROTCTLD_HOST:-host.docker.internal}" \
  -v "$CFG_SRC:/config:ro" \
  "$IMG"
