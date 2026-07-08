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
( cd "$BACKEND" && GS_HTTP_PORT="$PORT" ATTACK_DELAY_MS="${ATTACK_DELAY_MS:-4000}" node server.js ) &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT INT TERM

# 대시보드가 응답할 때까지 대기(최대 ~10초)
for _ in $(seq 1 50); do
  if curl -fsS "$URL/api/state" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

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
wait $SRV
