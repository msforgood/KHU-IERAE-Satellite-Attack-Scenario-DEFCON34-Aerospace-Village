#!/usr/bin/env bash
# run-booth.sh — DEMOSAT booth supervisor.
#
# Runs one scenario's victim + attacker together and, on a restart signal, tears both
# down and relaunches them — giving each participant a clean session. The signal is a
# flag file the ground station drops when the finale "OK, I will quit" button POSTs
# <gs>/api/restart. Because start-victim.sh / start-attacker.sh already free their own
# ports (free_port / free_gpredict / free_serial_bridge) on entry, relaunching is enough
# to reclaim everything the previous run held.
#
# Usage:   ./run-booth.sh <scn2|scn3>            # scenario argument is REQUIRED
#   e.g.   ./run-booth.sh scn2                   # scenario 2 · Uplink Attack
#          ./run-booth.sh scn3                   # scenario 3 · Spoofing
#
# Env:
#   RESTART_FLAG   flag file the GS writes + we poll (default /tmp/demosat-restart.flag)
#   NO_OPEN=1      forwarded so browsers don't auto-open on every relaunch (default: 1)
#
# Stop the whole booth with Ctrl-C.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# Scenario is required — map the short alias (scn2/scn3) to its folder. No argument →
# show the two examples and ask which one to start, then quit.
case "${1:-}" in
  scn2) SCN="scenario2-uplink-attack" ;;
  scn3) SCN="scenario3-spoofing" ;;
  "")
    echo "무엇을 시동할까요?  시나리오 인자가 필요합니다 (scn2 | scn3):"
    echo "  ./run-booth.sh scn2    # 시나리오 2 · Uplink Attack"
    echo "  ./run-booth.sh scn3    # 시나리오 3 · Spoofing"
    exit 1 ;;
  *)
    echo "✗ 알 수 없는 시나리오 '$1' — scn2 또는 scn3 을 지정하세요:"
    echo "  ./run-booth.sh scn2    # 시나리오 2 · Uplink Attack"
    echo "  ./run-booth.sh scn3    # 시나리오 3 · Spoofing"
    exit 1 ;;
esac
SCN_DIR="$DIR/$SCN"
[ -x "$SCN_DIR/start-attacker.sh" ] && [ -x "$SCN_DIR/start-victim.sh" ] \
  || { echo "✗ no runnable scenario at $SCN_DIR (need start-attacker.sh + start-victim.sh)"; exit 1; }

export RESTART_FLAG="${RESTART_FLAG:-/tmp/demosat-restart.flag}"

VPID=""; APID=""

start_all() {   # $1 = attacker mode: 'all' (install+check+up) first time, 'up' after
  local mode="${1:-up}"
  rm -f "$RESTART_FLAG"
  # First boot auto-opens the browser(s), exactly like running the start scripts directly.
  # On a RESTART the console already reloads the participant's existing tab to phase 1, so
  # we suppress the auto-open then (NO_OPEN=1) to avoid piling up a new tab per participant.
  local no_open=1
  [ "$mode" = "all" ] && no_open=0
  ( cd "$SCN_DIR" && NO_OPEN="$no_open" ./start-victim.sh ) & VPID=$!
  ( cd "$SCN_DIR" && NO_OPEN="$no_open" ./start-attacker.sh "$mode" ) & APID=$!
}

stop_all() {
  # Kill the two script wrappers; their background services (GS, builder, OpenVSA,
  # gpredict container, Arduino bridge) are reclaimed by the NEXT launch's own
  # free_port / free_gpredict / free_serial_bridge, which match by port/container/name.
  [ -n "$APID" ] && kill "$APID" 2>/dev/null || true
  [ -n "$VPID" ] && kill "$VPID" 2>/dev/null || true
  pkill -f 'start-attacker.sh' 2>/dev/null || true
  pkill -f 'start-victim.sh'   2>/dev/null || true
  sleep 2
}

trap 'echo; echo "▸ booth shutting down…"; stop_all; exit 0' INT TERM

echo "───────────────────────────────────────────────"
echo "▸ DEMOSAT booth supervisor — scenario: $SCN"
echo "   restart flag: $RESTART_FLAG   (finale 'OK, I will quit' → GS /api/restart)"
echo "   stop the booth with Ctrl-C"
echo "───────────────────────────────────────────────"

start_all all      # first boot: full install + check + up
while true; do
  if [ -f "$RESTART_FLAG" ]; then
    echo "▸ restart requested → relaunching both sides for the next participant…"
    stop_all
    start_all up   # relaunch: deps already installed, just bring services back up
    echo "▸ relaunched."
  fi
  sleep 1
done
