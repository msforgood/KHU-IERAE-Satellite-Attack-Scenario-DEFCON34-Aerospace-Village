#!/usr/bin/env bash
# [Windows / git-bash] ⑤ 아두이노 브릿지  (COM3 는 Windows 시리얼)
#   ★ 반드시 Windows 의 git-bash(또는 cmd 의 python)에서 실행 — WSL 은 COM3 접근 불가.
#   WS 는 IPv4(127.0.0.1) 로 고정(미러드 네트워킹 IPv6 타임아웃 회피). COM 은 자동탐지.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
cd "$SCEN1" || exit 1
log "arduino_bridge.py 시작 → WS=$ARDUINO_WS baud=$ARDUINO_BAUD"
exec python arduino_bridge.py --ws "$ARDUINO_WS" --baud "$ARDUINO_BAUD" -v
