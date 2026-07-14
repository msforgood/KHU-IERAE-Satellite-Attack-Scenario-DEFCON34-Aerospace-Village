#!/usr/bin/env bash
# setup.sh — attacker 3rd screen deps.
#   · OpenVSA (Node)  → installed PROJECT-LOCAL (attacker/openvsa/node_modules). Not global.
#   · gpredict        → runs ISOLATED in Docker (nothing on the host). See below.
set -e
cd "$(dirname "$0")"

echo "[1/2] OpenVSA deps → attacker/openvsa/node_modules  (project-local, not global/root)"
( cd openvsa && npm install --no-audit --no-fund )

echo "[2/2] gpredict → isolated in Docker (recommended — nothing installs on your Mac):"
echo "        ./gpredict-web/run.sh    # builds a container with gpredict+noVNC, serves :6080"
echo
echo "  (Optional native install instead of Docker — this DOES touch your system:"
echo "     macOS: brew install gpredict   ·   Linux: sudo apt install gpredict xvfb x11vnc novnc websockify)"
echo "done."
