#!/usr/bin/env bash
# start-victim.sh — victim 지상국(Ground Station) 원클릭 실행.
#
#   최초 설치 → 설치 확인 → victim 대시보드 실행 + 브라우저 열기
#
# 사용법:  ./start-victim.sh
#   env:  GS_HTTP_PORT (기본 4540)   ATTACK_DELAY_MS (경보 지연, 예: 2500)   NO_OPEN=1 (브라우저 자동열기 끄기)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$DIR/victim/backend"
FRONTEND="$DIR/victim/frontend"
PORT="${GS_HTTP_PORT:-4540}"
URL="http://localhost:$PORT"

say(){ printf "\033[36m▸ %s\033[0m\n" "$*"; }
ok(){  printf "\033[32m  ✓ %s\033[0m\n" "$*"; }
die(){ printf "\033[31m  ✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ── 1. 최초 설치 ──────────────────────────────────────────────
say "1/3  최초 설치"
command -v node >/dev/null 2>&1 || die "Node.js가 없습니다 → https://nodejs.org 에서 LTS(20+) 설치 후 다시 실행"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] && ok "Node $(node -v)" || printf "\033[33m  ! Node %s (20+ 권장, 계속 진행)\033[0m\n" "$(node -v)"
# 지상국 백엔드는 순수 Node(의존성 0). package.json이 있으면 안전하게 install(있어도 no-op).
if [ -f "$BACKEND/package.json" ] && command -v npm >/dev/null 2>&1; then
  ( cd "$BACKEND" && npm install --silent --no-audit --no-fund ) && ok "지상국 의존성 준비 완료(순수 Node)"
fi

# ── 2. 설치 확인 ──────────────────────────────────────────────
say "2/3  설치 확인"
[ -f "$BACKEND/server.js" ]     || die "server.js 없음: $BACKEND/server.js"
[ -f "$FRONTEND/index.html" ]   || die "대시보드 없음: $FRONTEND/index.html"
node --check "$BACKEND/server.js" || die "server.js 문법 오류"
ok "파일·문법 확인 완료"

# ── 3. victim 화면 실행 + 브라우저 열기 ───────────────────────
say "3/3  victim 지상국 실행 → $URL"
UPLINK_PORT="${UPLINK_PORT:-4536}"

# 포트 선점 정리: 이전 지상국(server.js)이 남아 있으면 종료, 다른 앱이 잡고 있으면 중단
free_port(){
  local p="$1" pids pid cmd
  pids="$(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if printf '%s' "$cmd" | grep -q "server.js"; then
      printf "\033[33m  ! 포트 %s 를 잡고 있던 이전 지상국(pid %s) 종료\033[0m\n" "$p" "$pid"
      kill "$pid" 2>/dev/null || true
    else
      die "포트 $p 를 다른 프로세스(pid $pid)가 사용 중 → $cmd
     그 프로그램을 종료하거나  GS_HTTP_PORT/UPLINK_PORT 로 다른 포트를 지정해 다시 실행하세요."
    fi
  done
  sleep 1
}
free_port "$PORT"
free_port "$UPLINK_PORT"

TAILPID=""
LOG="$(mktemp -t victim.XXXXXX)"
( cd "$BACKEND" && GS_HTTP_PORT="$PORT" UPLINK_PORT="$UPLINK_PORT" ATTACK_DELAY_MS="${ATTACK_DELAY_MS:-4000}" node server.js ) >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV ${TAILPID:-} 2>/dev/null || true; rm -f "$LOG"' EXIT INT TERM

# 대시보드가 응답할 때까지 대기 — 단, 서버가 죽으면 즉시 실제 오류를 출력하고 중단
ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "─── 서버 로그 ───"; cat "$LOG"
    grep -q EADDRINUSE "$LOG" && die "포트 충돌(EADDRINUSE) — 이미 실행 중인 지상국을 종료하고 다시 실행하세요."
    die "지상국 실행 실패 — 위 로그를 확인하세요."
  fi
  if curl -fsS "$URL/api/state" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { echo "─── 서버 로그 ───"; cat "$LOG"; die "대시보드가 응답하지 않습니다 ($URL)"; }

open_url(){
  [ "${NO_OPEN:-0}" = "1" ] && return 0
  case "$(uname)" in
    Darwin) open "$1" ;;
    Linux)  xdg-open "$1" >/dev/null 2>&1 || true ;;
    *)      command -v powershell >/dev/null 2>&1 && powershell.exe start "$1" || true ;;
  esac
}
open_url "$URL"

echo "───────────────────────────────────────────────"
ok "victim 대시보드 실행 중 →  $URL   (전체화면 F11)"
echo "   리셋:  curl -X POST $URL/api/reset"
echo "   종료:  Ctrl+C"
echo "───────────────────────────────────────────────"
cat "$LOG"                 # 시작 로그
tail -n0 -f "$LOG" &       # 이후 라이브 로그(업링크 RX 등) 스트리밍
TAILPID=$!
wait $SRV
