#!/usr/bin/env bash
# [Windows / git-bash] (5) Arduino bridge  (COM3 is the Windows serial port)
#   * Must be run from the Windows git-bash (or python under cmd) - WSL cannot access COM3.
#   WS is fixed to IPv4 (127.0.0.1) to avoid mirrored-networking IPv6 timeouts. COM is auto-detected.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
cd "$SCEN1" || exit 1
log "arduino_bridge.py starting -> WS=$ARDUINO_WS baud=$ARDUINO_BAUD"
exec python arduino/arduino_bridge.py --ws "$ARDUINO_WS" --baud "$ARDUINO_BAUD" -v
