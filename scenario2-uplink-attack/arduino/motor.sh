#!/usr/bin/env bash
# motor.sh — 역할(solar/antenna) 기반 자동탐지 + 시리얼 명령 전송 (공용 헬퍼)
#
# 여러 보드를 아무 포트에 꽂아도, 매 실행마다 각 포트에 WHOAMI를 보내
# 펌웨어가 응답하는 ID(=역할)로 올바른 보드를 골라 명령을 전송합니다.
#   · 솔라 패널 보드 → 펌웨어가 "ID=SOLAR_PANEL" (또는 부팅배너 "SOLAR PANEL") 응답
#   · 안테나 보드    → 펌웨어가 "ID=ANTENNA"     (또는 부팅배너 "ANT READY id=ANTENNA")
# 모터 모델(MG90S/28BYJ-48 등)은 소프트웨어로 알 수 없으므로, "역할"은 이렇게
# 펌웨어에 심은 ID로 정합니다. 정체불명/빈 보드는 응답이 없어 안전하게 걸러집니다.
#
# 사용법:
#   ./motor.sh solar spin           # 솔라 패널 회전 시작
#   ./motor.sh solar stop
#   ./motor.sh solar speed 1
#   ./motor.sh antenna spin         # 안테나 연속 회전
#   ./motor.sh antenna sweep        # 안테나 좌↔우 조준 스윕
#   ./motor.sh antenna stop
#   ./motor.sh antenna ping
#
# 포트 강제 지정(자동탐지 생략): PORT=/dev/cu.xxx ./motor.sh antenna spin
set -uo pipefail

ROLE="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"; shift 2>/dev/null || true
CMD="$(echo "${1:-ping} ${2:-}" | tr '[:lower:]' '[:upper:]' | xargs)"

case "$ROLE" in
  solar|solar_panel) ID="SOLAR_PANEL"; ALT="SOLAR PANEL";;
  antenna|ant)       ID="ANTENNA";     ALT="id=ANTENNA";;
  *) echo "사용법: ./motor.sh <solar|antenna> <spin|stop|speed N|sweep|ping ...>"; exit 1;;
esac

# 한 포트를 열어(Uno는 1회 리셋, MKR는 리셋 없음) WHOAMI로 역할 확인.
# 맞으면 같은 연결에서 CMD 전송 후 응답을 잠깐 출력하고 0 반환.
try_port() {
  local p="$1" line found=""
  [ -e "$p" ] || return 1
  stty -f "$p" 9600 raw -echo -hupcl clocal 2>/dev/null || return 1
  exec 3<>"$p" 2>/dev/null || return 1
  sleep 2.2                                   # 부트로더/USB 준비 대기
  printf 'WHOAMI\n' >&3
  while IFS= read -r -t 2 line <&3; do
    line="${line%$'\r'}"
    case "$line" in *"ID=$ID"*|*"$ALT"*) found=1; break;; esac
  done
  [ -z "$found" ] && { exec 3>&- 2>/dev/null; return 1; }

  printf '%s\n' "$CMD" >&3
  echo "✓ $ROLE 보드 발견: $p"
  echo ">> 전송: $CMD"
  local n=0
  while IFS= read -r -t 2 line <&3; do
    line="${line%$'\r'}"; [ -n "$line" ] && echo "   $line"
    n=$((n+1)); [ $n -ge 6 ] && break
  done
  exec 3>&- 2>/dev/null
  return 0
}

if [ -n "${PORT:-}" ]; then
  try_port "$PORT" && exit 0
  echo "지정한 포트($PORT)에서 '$ROLE' 응답이 없습니다."; exit 1
fi

any=""
for p in /dev/cu.usbserial-* /dev/cu.usbmodem*; do
  [ -e "$p" ] || continue
  any=1
  echo "탐색 중: $p ..." >&2
  try_port "$p" && exit 0
done
[ -z "$any" ] && { echo "시리얼 포트가 하나도 없습니다. USB 연결을 확인하세요."; exit 1; }
echo "'$ROLE' 역할 펌웨어가 응답하는 포트를 못 찾았습니다. 전원/업로드 상태를 확인하세요."
exit 1
