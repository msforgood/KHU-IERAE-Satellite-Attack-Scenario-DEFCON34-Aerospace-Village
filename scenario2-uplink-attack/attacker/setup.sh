#!/usr/bin/env bash
# setup.sh — one-time setup for the attacker 3rd screen (OpenVSA + gpredict).
set -e
cd "$(dirname "$0")"

echo "[1/3] OpenVSA deps (Electron/Node)"
( cd openvsa && npm install --no-audit --no-fund )

echo "[2/3] gpredict — install or build from the vendored source"
if command -v gpredict >/dev/null 2>&1; then
  echo "  gpredict already installed: $(command -v gpredict)"
elif command -v brew >/dev/null 2>&1; then
  brew install gpredict
elif command -v apt >/dev/null 2>&1; then
  sudo apt update && sudo apt install -y gpredict xvfb x11vnc novnc websockify
else
  echo "  build from vendored source:"
  echo "    cd gpredict && ./autogen.sh && ./configure && make && sudo make install"
fi

echo "[3/3] gpredict config → copy to ~/.config/Gpredict (see gpredict-config/README.md)"
echo "done. Run the 3rd screen with:  ./launch.sh   (see README.md)"
