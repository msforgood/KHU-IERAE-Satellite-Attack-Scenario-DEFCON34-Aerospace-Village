#!/usr/bin/env bash
# booth.sh — DEFCON 부스 수퍼바이저. 피해 지상국(start-victim.sh)과 공격자 콘솔
# (start-attacker.sh)을 함께 띄우고, 시나리오가 요청하면(드론 스푸핑 화면의 "OK, I'll
# quit") 또는 예기치 않게 죽으면 각각을 다시 살린다 → 다음 참가자는 항상 깨끗한 상태로 시작.
#
# 동작:
#   드론 화면의 "OK, I'll quit" → 각 서버로 POST /api/quit
#     · victim server.js  → 상태 리셋 + /tmp/demosat-restart.victim   기록
#     · attacker app.py   →              /tmp/demosat-restart.attacker 기록
#   이 루프가 sentinel을 감지 → 해당 스크립트를 종료(그 스크립트의 Ctrl+C 정리 훅이
#   모터 MODE 0 + 포트 해제) → 다시 기동. 두 sentinel이 함께 찍히므로 둘 다 재시작된다
#   = "start-attacker.sh 와 start-victim.sh 를 둘 다 껐다 켠" 효과.
#
# 사용법 (시나리오 폴더에서):
#   ./booth.sh          # 둘 다 기동 + 무한 감독 (전체 종료: Ctrl+C)
#
# 재시작 비용:
#   attacker 최초 부팅은 FULL(펌웨어 플래시 + 모터 자가진단). 재시작은 FAST
#   (NO_FLASH=1 NO_SELFTEST=1) — 펌웨어는 참가자마다 안 바뀌므로 ~20-30초 안테나
#   스윕을 건너뛰어 교대를 빠르게 한다. 매번 FULL로 하려면 FULL_RESTART=1.
#
# 이 파일은 기존 start-*.sh 를 건드리지 않는다: 각 스크립트의 Ctrl+C 정리 훅(모터 정지·
# 포트 해제)을 그대로 재사용하고, 여기서는 "언제 죽이고 언제 다시 띄우는가"만 책임진다.

set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

ATT_FLAG="/tmp/demosat-restart.attacker"
VIC_FLAG="/tmp/demosat-restart.victim"
rm -f "$ATT_FLAG" "$VIC_FLAG"

say() { printf "\033[36m▸ [booth] %s\033[0m\n" "$*"; }

# 감독 대상 하나: (재)기동 → sentinel/사망 감시 → 재시작 요청이나 예기치 않은 죽음에 재기동.
#   $1 라벨 · $2 sentinel 파일 · $3 최초 명령(FULL) · $4 재시작 명령(FAST)
# 백그라운드 서브셸로 돌며, booth 종료 시 TERM 을 받으면 현재 스크립트를 죽이고 빠진다.
supervise() {
  local label="$1" flag="$2" first_cmd="$3" rest_cmd="$4"
  local pid="" first=1
  trap 'kill "$pid" 2>/dev/null; exit 0' TERM INT
  while true; do
    rm -f "$flag"
    if [ "$first" = 1 ]; then
      say "$label 최초 기동"
      eval "$first_cmd" &
    else
      say "$label 재기동"
      eval "$rest_cmd" &
    fi
    pid=$!
    first=0
    # 스크립트가 살아있는 동안: sentinel 이 찍히면 정리 후 재기동, 아니면 계속 감시.
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f "$flag" ]; then
        say "$label 재시작 요청 감지 → 정리 후 재기동"
        kill "$pid" 2>/dev/null || true # → 스크립트 트랩: 모터 MODE 0 + 포트 해제
        break
      fi
      sleep 0.4
    done
    wait "$pid" 2>/dev/null # 정리(모터·docker stop) 끝날 때까지 대기
    rm -f "$flag"
    sleep 1 # 죽자마자 재기동하는 폭주 방지(예기치 않은 크래시 시 백오프)
  done
}

CHILDREN=()
shutdown() {
  echo
  say "종료 — 모든 하위 프로세스 정리(모터 정지·포트 해제는 각 스크립트 훅이 수행)"
  for p in "${CHILDREN[@]:-}"; do kill "$p" 2>/dev/null || true; done
  # 안전빵: 감독 서브셸을 못 거쳐 남은 start-*.sh 가 있으면 직접 INT 로 정리 훅을 태운다
  # (터미널 Ctrl+C 면 프로세스 그룹으로 이미 전달되지만, booth PID 만 kill 된 경우 대비).
  pkill -INT -f 'start-victim\.sh' 2>/dev/null || true
  pkill -INT -f 'start-attacker\.sh' 2>/dev/null || true
  sleep 3 # 각 스크립트의 정리 훅(모터 MODE 0·docker stop)이 끝날 여유
  for p in "${CHILDREN[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  exit 0
}
trap shutdown INT TERM

# attacker 재시작 명령: 기본 FAST(플래시·자가진단 생략). FULL_RESTART=1 이면 최초와 동일.
ATT_FIRST="./start-attacker.sh"
ATT_REST="NO_FLASH=1 NO_SELFTEST=1 ./start-attacker.sh up"
[ "${FULL_RESTART:-0}" = "1" ] && ATT_REST="./start-attacker.sh"

# victim 먼저 — 공격자 브리지가 :4542 를 폴링하기 시작하기 전에 GS 가 떠 있게 한다.
supervise "victim GS" "$VIC_FLAG" "./start-victim.sh" "./start-victim.sh" &
CHILDREN+=($!)
sleep 2
supervise "attacker" "$ATT_FLAG" "$ATT_FIRST" "$ATT_REST" &
CHILDREN+=($!)

echo "───────────────────────────────────────────────"
say "부스 감독 시작 — victim GS + attacker 콘솔"
say "재시작: 드론 스푸핑 화면의 'OK, I'll quit' (또는 컴포넌트 사망 시 자동)"
if [ "${FULL_RESTART:-0}" = "1" ]; then
  say "attacker 재시작: FULL(매번 펌웨어 플래시 + 모터 자가진단)"
else
  say "attacker 재시작: FAST(플래시·자가진단 생략) — 매번 full 은 FULL_RESTART=1"
fi
say "전체 종료: Ctrl+C"
echo "───────────────────────────────────────────────"

wait
