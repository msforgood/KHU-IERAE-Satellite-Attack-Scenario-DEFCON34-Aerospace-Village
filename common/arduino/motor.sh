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
# 실제 시리얼 열기·보율 설정·읽기는 bridge/serial.js 가 OS 별로 처리합니다
# (macOS·Linux = stty + tty 스트림, Windows = mode.com + .NET SerialPort).
# 예전엔 이 파일이 직접 `stty -f` 와 /dev/cu.* 를 썼는데 macOS 전용이라 Windows 에선 못 썼습니다.
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
# 포트 강제 지정(자동탐지 생략):
#   PORT=/dev/cu.xxx ./motor.sh antenna spin     # macOS·Linux
#   PORT=COM3 ./motor.sh antenna spin            # Windows
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SERIAL_JS="$DIR/bridge/serial.js"
BAUD="${BAUD:-9600}"

command -v node >/dev/null 2>&1 || { echo "node 가 필요합니다 → https://nodejs.org (LTS) 설치 후 다시 실행"; exit 1; }
[ -f "$SERIAL_JS" ] || { echo "serial.js 를 찾을 수 없습니다: $SERIAL_JS"; exit 1; }

ROLE="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"; shift 2>/dev/null || true
CMD="$(echo "${1:-ping} ${2:-}" | tr '[:lower:]' '[:upper:]' | xargs)"

case "$ROLE" in
  solar|solar_panel) ROLE="solar" ;;
  antenna|ant)       ROLE="antenna" ;;
  *) echo "사용법: ./motor.sh <solar|antenna> <spin|stop|speed N|sweep|ping ...>"; exit 1;;
esac

# 한 포트에 대해: 열기(Uno는 1회 리셋, MKR는 리셋 없음) → WHOAMI 로 역할 확인 →
# 역할이 맞을 때만 CMD 전송 후 응답 출력. 종료코드 3 = 그 역할의 보드가 아님(다음 포트로).
try_port() {
  local p="$1" out rc
  out="$(node "$SERIAL_JS" cmd "$p" "$BAUD" "$ROLE" "$CMD" 2>/dev/null)"; rc=$?
  [ "$rc" -eq 0 ] || return 1
  echo "✓ $ROLE 보드 발견: $p"
  echo ">> 전송: $CMD"
  [ -n "$out" ] && printf '%s\n' "$out" | sed -e 's/^/   /' | head -8
  return 0
}

if [ -n "${PORT:-}" ]; then
  try_port "$PORT" && exit 0
  echo "지정한 포트($PORT)에서 '$ROLE' 응답이 없습니다."; exit 1
fi

# 포트 열거도 serial.js 에 맡긴다(macOS cu.* · Linux ttyACM/ttyUSB · Windows COMx).
any=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  any=1
  echo "탐색 중: $p ..." >&2
  try_port "$p" && exit 0
done <<EOF
$(node "$SERIAL_JS" list 2>/dev/null | tr -d '\r')
EOF

[ -z "$any" ] && { echo "시리얼 포트가 하나도 없습니다. USB 연결을 확인하세요."; exit 1; }
echo "'$ROLE' 역할 펌웨어가 응답하는 포트를 못 찾았습니다. 전원/업로드 상태를 확인하세요."
exit 1
