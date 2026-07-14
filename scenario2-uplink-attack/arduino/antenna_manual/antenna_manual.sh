#!/usr/bin/env bash
# antenna_manual.sh — 안테나 스텝모터 대화형 수동 조작
#
# 포트를 한 번 열어(MKR은 리셋 없음) 명령을 실시간으로 타이핑한다.
# 사용: ./antenna_manual.sh        (포트 자동탐지, 안 되면 PORT=/dev/cu.xxx 지정)
#
#   명령:  right / left           두 모터 90° 오른쪽 / 왼쪽으로 1회전
#          right1 left1           모터1만 90°
#          right2 left2           모터2만 90°
#          move 256               두 모터 n스텝 이동(부호=방향, 각도 보정용)
#          stop                   진행 중 이동 중단
#          speed 3                스텝 간격 ms (작을수록 빠름)
#          ping                   상태
#          q (또는 빈 줄)         종료
set -uo pipefail

PORT="${PORT:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1 || true)}"
[ -n "${PORT:-}" ] || { echo "MKR 포트를 못 찾음. PORT=/dev/cu.usbmodemXXXX 로 지정하세요."; exit 1; }

stty -f "$PORT" 9600 raw -echo -hupcl clocal 2>/dev/null || true
exec 3<>"$PORT" || { echo "포트 열기 실패: $PORT"; exit 1; }

# 보드 응답을 실시간으로 출력
( while IFS= read -r line <&3; do printf '\r   << %s\n> ' "${line%$'\r'}"; done ) &
RPID=$!
cleanup() { kill "$RPID" 2>/dev/null; exec 3>&- 2>/dev/null; }
trap cleanup EXIT INT

sleep 0.5
printf 'PING\n' >&3
cat <<'EOF'
── 안테나 스텝모터 수동 조작 (명령 1회 = 90° 회전) ──
  right / left  |  right1 left1 / right2 left2  |  move N  |  stop  |  speed N  |  ping
  종료: q 또는 빈 줄
EOF
echo "  포트: $PORT"

while true; do
  printf '> '
  IFS= read -r line || break
  [ -z "$line" ] && break
  [ "$line" = "q" ] && break
  printf '%s\n' "$line" >&3
  sleep 0.15
done
echo "종료."
