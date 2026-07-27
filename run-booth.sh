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
# 포트/프로세스 정리는 OS 마다 도구가 다르다(macOS·Linux=lsof/pkill, Windows Git Bash=
# netstat/taskkill). 공용 헬퍼로 흡수 — 이게 없으면 Windows 에서 이전 실행이 살아남아
# 다음 실행이 EADDRINUSE(0.0.0.0:4552/4553 등)로 죽는다.
. "$DIR/common/proc.sh"

# Scenario is required — map the short alias (scn2/scn3) to its folder. No argument →
# show the two examples and ask which one to start, then quit.
# BOOTH_PORTS: 그 시나리오가 쓰는 TCP 포트 전부(피해 GS HTTP·업링크 WS, 빌더, OpenVSA).
#   재시작 때 이 포트들을 직접 회수해, 래퍼 kill 이 실패해도 다음 실행이 반드시 bind 되게 한다.
#   (gpredict 는 Docker 라 포트 주인이 도커 데몬 — free_gpredict 가 docker stop 으로 따로 처리.)
case "${1:-}" in
  scn2) SCN="scenario2-uplink-attack"; BOOTH_PORTS="4542 4552 8002 4534 4533 4532" ;;
  scn3) SCN="scenario3-spoofing";      BOOTH_PORTS="4543 4553 8003 4534 4533 4532" ;;
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
# attacker-ready flag: start-attacker.sh writes it AFTER the antenna/solar setup, app.py
# serves it at /api/ready, the finale's reload waits on it. We clear it on every (re)launch
# so a stale "ready" from the previous run can't reload the browser too early.
export READY_FLAG="${READY_FLAG:-/tmp/demosat-attacker-ready.flag}"

VPID=""; APID=""

start_all() {   # $1 = attacker mode: 'all' (install+check+up) first time, 'up' after
  local mode="${1:-up}"
  rm -f "$RESTART_FLAG" "$READY_FLAG"
  # First boot auto-opens the browser(s), exactly like running the start scripts directly.
  # On a RESTART the console already reloads the participant's existing tab to phase 1, so
  # we suppress the auto-open then (NO_OPEN=1) to avoid piling up a new tab per participant.
  local no_open=1
  [ "$mode" = "all" ] && no_open=0
  ( cd "$SCN_DIR" && NO_OPEN="$no_open" ./start-victim.sh ) & VPID=$!
  ( cd "$SCN_DIR" && NO_OPEN="$no_open" ./start-attacker.sh "$mode" ) & APID=$!
}

stop_all() {
  # Kill the two script wrappers TOGETHER WITH their children. On macOS/Linux the wrapper's
  # own EXIT trap tears the services down; on Windows a killed bash subshell leaves its
  # node.exe children running (no signal propagation), so kill_shell_tree uses taskkill /T.
  kill_shell_tree "$APID"
  kill_shell_tree "$VPID"
  kill_by_pattern 'start-attacker\.sh'
  kill_by_pattern 'start-victim\.sh'
  # Belt and braces: reclaim the scenario's ports directly. The next launch's free_port
  # would normally do this, but a service that outlives its wrapper (Windows) must be gone
  # BEFORE we relaunch — otherwise the new GS dies with
  #   Error: listen EADDRINUSE: address already in use 0.0.0.0:4553
  local p
  for p in $BOOTH_PORTS; do free_tcp_port "$p" "booth :$p"; done
  kill_by_pattern 'bridge\.js'   # Arduino 시리얼 브리지(포트가 아니라 시리얼을 물어 포트 회수로는 안 잡힘)
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
    rm -f "$READY_FLAG"   # go not-ready at once → the browser holds until setup is done again
    stop_all
    start_all up   # relaunch: deps already installed, just bring services back up
    echo "▸ relaunched."
  fi
  sleep 1
done
