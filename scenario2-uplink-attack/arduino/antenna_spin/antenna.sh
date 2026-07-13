#!/usr/bin/env bash
# antenna.sh — 안테나 스핀 보드에 시리얼 명령 전송 (손쉬운 시작/정지)
#
# 사용법:
#   ./antenna.sh spin        # 무한 회전 시작
#   ./antenna.sh stop        # 정지
#   ./antenna.sh speed 1     # 속도 1~30 (작을수록 느리고 잔떨림↓)
#   ./antenna.sh ping        # 상태 확인
#
# 포트는 자동 탐지(/dev/cu.usbserial-*, usbmodem*). 다른 포트면:
#   PORT=/dev/cu.usbserial-140 ./antenna.sh spin
#
# 참고: Uno 클론(CH340)은 포트를 열 때마다 DTR로 보드가 한 번 리셋됩니다.
#       그래서 명령을 보내기 전 부트로더(~2s)가 끝나길 기다립니다.
set -euo pipefail

PORT="${PORT:-$(ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1 || true)}"
[ -n "${PORT:-}" ] || { echo "보드 포트를 못 찾음. PORT=/dev/cu.xxx 로 지정하세요."; exit 1; }

CMD="$(echo "${1:-ping} ${2:-}" | tr '[:lower:]' '[:upper:]' | xargs)"

stty -f "$PORT" 9600 raw -echo -hupcl clocal 2>/dev/null || true  # -hupcl: 닫을 때 재리셋 방지

# 포트를 여는 순간 보드가 리셋됨 → 부트로더가 끝나고 스케치가 뜬 뒤에 명령 전송
( cat "$PORT" & CATPID=$!; sleep 4; kill $CATPID 2>/dev/null ) &
READER=$!
sleep 2.2                       # 부트로더 종료 대기 (명령이 씹히지 않게)
printf '%s\n' "$CMD" > "$PORT"
echo ">> 전송: $CMD  (포트: $PORT)"
wait $READER 2>/dev/null || true
