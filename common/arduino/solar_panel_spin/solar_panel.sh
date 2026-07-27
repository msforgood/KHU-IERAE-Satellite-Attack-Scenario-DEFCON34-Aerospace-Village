#!/usr/bin/env bash
# solar_panel.sh — 솔라 패널 스핀 보드 "자동탐지" + 시리얼 명령 전송
#
# 연결된 시리얼 포트가 여러 개여도, 매 실행마다 각 포트에 PING을 보내
# "SOLAR PANEL" 이라고 응답하는 포트(=우리 솔라 패널 보드)만 골라 명령을 보냅니다.
# (펌웨어는 부팅 배너/PING 응답에 항상 "SOLAR PANEL"을 출력 → 이걸 지문처럼 사용)
#
# 사용법:
#   ./solar_panel.sh spin        # 무한 회전 시작
#   ./solar_panel.sh stop        # 정지 (무음)
#   ./solar_panel.sh speed 1     # 속도 1~30
#   ./solar_panel.sh ping        # 상태 확인
#
# 포트를 강제 지정하려면(자동탐지 생략):
#   PORT=/dev/cu.usbserial-1140 ./solar_panel.sh spin
set -uo pipefail

CMD="$(echo "${1:-ping} ${2:-}" | tr '[:lower:]' '[:upper:]' | xargs)"
SIG="SOLAR PANEL"        # 우리 보드를 식별하는 응답 지문

# 포트 하나를 열어(=보드 1회 리셋) PING 후 SIG가 오는지 확인.
# 우리 보드가 맞으면 같은 연결에서 CMD까지 보내고 응답을 출력한 뒤 0 반환.
try_port() {
  local p="$1" line found=""
  [ -e "$p" ] || return 1
  stty -f "$p" 9600 raw -echo -hupcl clocal 2>/dev/null || return 1
  exec 3<>"$p" 2>/dev/null || return 1
  sleep 2.2                         # 부트로더 종료 대기(명령 씹힘 방지)
  printf 'PING\n' >&3
  while IFS= read -r -t 2 line <&3; do
    line="${line%$'\r'}"
    case "$line" in *"$SIG"*) found=1; break;; esac
  done
  if [ -z "$found" ]; then exec 3>&- 2>/dev/null; return 1; fi

  # 우리 보드 확정 → 실제 명령 전송, 응답 잠깐 출력
  printf '%s\n' "$CMD" >&3
  echo "✓ 솔라 패널 보드 발견: $p"
  echo ">> 전송: $CMD"
  local n=0
  while IFS= read -r -t 2 line <&3; do
    line="${line%$'\r'}"
    [ -n "$line" ] && echo "   $line"
    n=$((n+1)); [ $n -ge 6 ] && break
  done
  exec 3>&- 2>/dev/null
  return 0
}

# 1) PORT를 지정했으면 그 포트만 시도
if [ -n "${PORT:-}" ]; then
  try_port "$PORT" && exit 0
  echo "지정한 포트($PORT)에서 '$SIG' 응답이 없습니다."; exit 1
fi

# 2) 자동탐지: usbserial → usbmodem 순으로 후보를 훑어 SIG 응답 포트를 채택
found_any=""
for p in /dev/cu.usbserial-* /dev/cu.usbmodem*; do
  [ -e "$p" ] || continue
  found_any=1
  echo "탐색 중: $p ..." >&2
  try_port "$p" && exit 0
done
[ -z "$found_any" ] && { echo "시리얼 포트가 하나도 없습니다. 보드 USB를 꽂았는지 확인하세요."; exit 1; }
echo "'$SIG' 펌웨어가 응답하는 포트를 못 찾았습니다. 전원/업로드 상태를 확인하세요."
exit 1
