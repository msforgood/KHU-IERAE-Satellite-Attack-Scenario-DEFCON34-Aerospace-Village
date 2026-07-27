#!/usr/bin/env bash
# start-attacker.sh — attacker 쪽 원샷 부트스트랩: 최초 설치 → 설치 확인 → 화면 실행.
# 시나리오 폴더에 두지만 phase 1-3 자원은 전부 공용 ../common/attacker 아래에 있어
# 스스로 그리로 진입한다. 시나리오별 차이는 이 폴더의 scenario.json + extras/ 로만 표현.
#
# 단일 포트(:8003) 하나로 ①②③ 전부. 별도 창/프록시 포트 없음.
#   http://localhost:8003  Command Builder (Python)
#     ├ 페이즈① 명령 조립  ·  페이즈② IQ 생성
#     └ 페이즈③ 위성 조준:  /targeting(콘솔) + /vsa(OpenVSA 렌더러) + gpredict(:6083) 직접 iframe
#
# ※ OpenVSA는 Electron 앱이지만 렌더러는 정적 웹(+WS :4534)이라 :8003이 /vsa 로 서빙한다.
#   gpredict noVNC는 Docker :6083 을 그대로 iframe(프록시 불필요). TRANSMIT은 피해 GS API(/api/inject).
#
# 사용법 (시나리오 폴더에서):
#   ./start-attacker.sh            # 설치 + 확인 + 실행 (전체)
#   ./start-attacker.sh install    # 설치만 (최초 1회)
#   ./start-attacker.sh check      # 설치 확인만
#   ./start-attacker.sh up         # 화면 실행만 (설치가 끝난 뒤)
#
# 환경변수(선택):
#   GS_URL       피해 지상국 base (ACQUIRE/RESET·forward 대상). 기본 http://localhost:4543
#   BUILDER_PORT ① Command Builder 포트. 기본 8003
#   CONSOLE_PORT ③ 조준 콘솔 단일 포트(console+vsa+gpredict). 기본 8090
#   GP_PORT      gpredict noVNC Docker 포트(프록시 대상). 기본 6083
#   GP_IMG       gpredict Docker 이미지명. 기본 demosat-gpredict
#   UPLINK_OUT_DIR  attack.cf32 출력 폴더. 기본 ~/uplink
#   NO_OPEN      1이면 브라우저 자동 열기 끄기 (기본: 실행 후 ①③ 화면 자동 오픈)
#   ANT_PORT     안테나 아두이노 시리얼 포트 강제 지정(미지정 시 WHOAMI 자동탐지).
#                예 macOS /dev/cu.usbmodem1101 · Linux /dev/ttyACM0 · Windows COM3
#   SOLAR_PORT   솔라 패널 아두이노 시리얼 포트 강제 지정(미지정 시 WHOAMI 자동탐지).
#   PANEL_SPIN   1이면 솔라 패널을 연속회전 서보로 취급(공격 시 SPIN). bridge.js 로 전달.
#   ── Arduino(scn2 전용, scenario.json 의 "arduinoBridge": true 일 때만) ──
#   FQBN         업로드 보드 타입. 기본 arduino:avr:uno (Nano/MKR 등이면 변경)
#   NO_FLASH     1이면 스케치 자동 업로드 생략(기존 펌웨어 사용)
#   NO_SELFTEST  1이면 모터 자가진단(왕복+준비자세) 생략
#   READY_AZ     자가진단 후 준비 자세 방위각. 기본 0 (콘솔 조준각과 다르게)
#   READY_EL     자가진단 후 준비 자세 앙각. 기본 0
#
# ⚠️ 이 스크립트는 '공격자 쪽'만 띄웁니다. 피해 지상국(⑤)은 별도로 실행하세요:
#     ./start-victim.sh   (또는 cd ../common/victim/backend && node server.js)

set -uo pipefail
# phase 1-3 자원(packet-generator·openvsa·gpredict-web·console)은 공용 ../common/attacker
# 아래에 있다. 시나리오 폴더(scenario.json·extras/ 위치)를 먼저 절대경로로 잡은 뒤
# 공용 트리로 진입해 이하 상대경로를 그대로 쓴다. scn2·scn3·scn4가 이 스크립트를 공유한다.
SCN_DIR="$(cd "$(dirname "$0")" && pwd)"
# 포트/프로세스 정리 헬퍼(OS 별 lsof·pkill ↔ netstat·taskkill). cd 前에 절대경로로 source.
. "$SCN_DIR/../common/proc.sh"
cd "$SCN_DIR/../common/attacker"

MODE="${1:-all}"
GS_URL="${GS_URL:-http://localhost:4543}"
BUILDER_PORT="${BUILDER_PORT:-8003}"
CONSOLE_PORT="${CONSOLE_PORT:-8090}"   # 단일 포트: console(/) + OpenVSA(/vsa) + gpredict(/gpredict)
GP_PORT="${GP_PORT:-6083}"
CTRL_PORT="${CTRL_PORT:-6073}"   # gpredict 시간제어 서버(phase3 → /arm). noVNC(GP_PORT)와 한 쌍.
GP_IMG="${GP_IMG:-demosat-gpredict}"
UPLINK_DEST="${UPLINK_DEST:-ws://localhost:4553}"
UPLINK_OUT_DIR="${UPLINK_OUT_DIR:-$HOME/uplink}"
# "attacker fully ready" flag — written only AFTER setup finishes, so the finale's
# restart reload waits for it. app.py serves it at /api/ready; run-booth.sh clears it.
export READY_FLAG="${READY_FLAG:-/tmp/demosat-attacker-ready.flag}"
# 시나리오 델타: 이 폴더의 scenario.json(페이즈 구성) + extras/(④+ 전용 화면)를 Command
# Builder에 전달. extras/ 가 없으면(scn2) EXTRA_DIR 미설정 → 순수 3-phase 공격.
SCENARIO_CONFIG="${SCENARIO_CONFIG:-$SCN_DIR/scenario.json}"
EXTRA_DIR_ARG=""; [ -d "$SCN_DIR/extras" ] && EXTRA_DIR_ARG="$SCN_DIR/extras"

BUILDER_DIR="packet-generator/webapp"
VENV="$BUILDER_DIR/.venv"

# Python UTF-8 모드 강제. Windows 는 open()·stdout 기본 인코딩이 시스템 로케일(예: 일본어
# cp932)이라 ① UTF-8 JSON 읽기(codec c2protocol.json)와 ② 비ASCII 출력(→,— 등)이
# 'illegal multibyte sequence' 로 죽는다. UTF-8 모드면 둘 다 UTF-8 로 고정돼 roundtrip
# 테스트·app.py 로그가 로케일과 무관하게 동작한다. (POSIX 는 어차피 UTF-8 이라 무해.)
export PYTHONUTF8=1

# ── helpers (start-victim.sh와 동일 디자인) ───────────────────────────────────
say()    { printf "\033[36m▸ %s\033[0m\n" "$*"; }
c_ok()   { printf "\033[32m  ✓ %s\033[0m\n" "$*"; }
c_warn() { printf "\033[33m  ! %s\033[0m\n" "$*"; }
c_err()  { printf "\033[31m  ✗ %s\033[0m\n" "$*"; }
die()    { c_err "$*" >&2; exit 1; }
have()   { command -v "$1" >/dev/null 2>&1; }
open_url() {
  [ "${NO_OPEN:-0}" = "1" ] && return 0
  case "$(uname)" in
    Darwin) open "$1" ;;
    Linux)  xdg-open "$1" >/dev/null 2>&1 || true ;;
    *)      # Windows: URL 의 '&'(쿼리 구분자)를 PowerShell 이 연산자로 오해해 파싱 에러가 난다
            #   (증상: "The ampersand (&) character is not allowed"). → -Command 로 URL 을
            #   작은따옴표 리터럴에 담아 Start-Process 에 통째로 넘긴다(리터럴 안에선 & 도 문자).
            #   URL 내부의 ' 는 '' 로 이스케이프.
            if command -v powershell.exe >/dev/null 2>&1; then
              local u_ps="${1//\'/\'\'}"
              powershell.exe -NoProfile -Command "Start-Process '$u_ps'" >/dev/null 2>&1 || true
            fi ;;
  esac
}

# ── python 해석(Windows 대응) ─────────────────────────────────────────────────
# Windows(Git Bash)의 함정 두 가지를 흡수한다:
#   ① python/python3 이 PATH 에 있어도 'Microsoft Store 실행 앨리어스' 스텁일 수 있다.
#      이 스텁은 코드를 실행하지 않고 exit 49 로 죽어 venv 생성·numpy 가 전부 실패한다
#      (증상: '✗ venv 생성 실패'). → command -v 존재만 믿지 말고 실제 실행(`-c import sys`)
#      으로 검증하고, 안 되면 py 런처(Windows)로 진짜 python.exe 를 찾는다.
#   ② venv 인터프리터 경로가 POSIX 는 bin/python, Windows 는 Scripts/python.exe 로 다르다.

# 실제로 코드를 '실행'하는 시스템 python 을 고른다(venv 생성용). 없으면 빈 문자열+비0.
sys_python() {
  local c exe
  for c in python3 python; do
    have "$c" && "$c" -c "import sys" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  # Windows: py 런처로 실제 python.exe 절대경로를 얻어 bash 경로(/c/...)로 변환해 쓴다.
  if have py && exe="$(py -3 -c 'import sys;print(sys.executable)' 2>/dev/null)" && [ -n "$exe" ]; then
    have cygpath && exe="$(cygpath -u "$exe")"
    echo "$exe"; return 0
  fi
  return 1
}

# venv 안의 python 경로(bin/python ↔ Scripts/python.exe). 없으면 빈 문자열.
venv_py() {
  if   [ -x "$VENV/bin/python" ];         then echo "$VENV/bin/python"
  elif [ -x "$VENV/Scripts/python.exe" ]; then echo "$VENV/Scripts/python.exe"
  fi
}

# numpy 를 가진 python 인터프리터 경로를 고른다 (venv 우선, 없으면 실행 가능한 시스템 python).
pick_python() {
  local v; v="$(venv_py)"
  if [ -n "$v" ]; then echo "$v"; else sys_python; fi
}

# 지정 포트를 잡고 있는 '이전 실행의 좀비 서버'를 정리한다 (데모 전용 포트라 안전).
# 이걸 안 하면 새 서버가 bind 실패(Address already in use)하고, 죽은 옛 서버가 화면을
# 계속 서빙해서 디버깅이 꼬인다(예: /api/mission 이 옛 경로 때문에 500).
# (조회·종료 자체는 proc.sh 의 free_tcp_port 가 OS 별로 처리한다 — macOS·Linux 는 lsof+kill,
#  Windows Git Bash 는 netstat+taskkill //T. 예전엔 lsof 전용이라 Windows 에서 통째로 no-op 이었고,
#  그 결과 이전 실행이 포트를 문 채 남아 다음 실행이 EADDRINUSE 로 죽었다.)
free_port() {
  free_tcp_port "$1" "$2"
}

# gpredict(③ 조준)는 Docker 컨테이너로만 뜨기 때문에 데몬이 꺼져 있으면 화면이 안 열린다.
# 그래서 여기서 데몬을 자동 기동하고 올라올 때까지 기다린다. Docker CLI 자체가 없으면(미설치)
# 조용히 실패(1) → 호출부가 gpredict 없이 진행. 성공 0 / 실패 1. 최대 DOCKER_WAIT(기본 90)초 대기.
ensure_docker() {
  have docker || return 1
  docker info >/dev/null 2>&1 && return 0     # 이미 떠 있으면 끝
  say "Docker 데몬이 꺼져 있음 → 자동 기동 시도 (gpredict ③ 조준용)"
  case "$(uname)" in
    Darwin) open -a Docker >/dev/null 2>&1 || { c_warn "Docker Desktop 실행 실패 — 수동으로 켜세요"; return 1; } ;;
    Linux)
      # Docker Desktop(리눅스) → systemctl --user, 아니면 native dockerd(sudo 필요할 수 있음). 베스트에포트.
      systemctl --user start docker-desktop >/dev/null 2>&1 \
        || sudo -n systemctl start docker >/dev/null 2>&1 \
        || { c_warn "Docker 자동 기동 실패 — 'sudo systemctl start docker' 후 다시 실행"; return 1; } ;;
    *) c_warn "이 OS에선 Docker 자동 기동 미지원 — 수동으로 켜세요"; return 1 ;;
  esac
  local wait="${DOCKER_WAIT:-90}" i
  printf "\033[33m  … Docker 데몬 대기(최대 %ss)\033[0m" "$wait"
  for i in $(seq 1 "$wait"); do
    if docker info >/dev/null 2>&1; then printf "\n"; c_ok "Docker 데몬 준비됨 (${i}s)"; return 0; fi
    printf "."; sleep 1
  done
  printf "\n"; c_warn "Docker 데몬이 ${wait}s 내 안 떴습니다 — gpredict(③) 없이 진행. 데몬 뜬 뒤 './start-attacker.sh up' 재실행."
  return 1
}

# gpredict 는 Docker 컨테이너(noVNC :GP_PORT + 시간제어 :CTRL_PORT)로 뜬다. 이전 실행이
# 비정상 종료(강제 kill·절전·크래시)되면 컨테이너가 남아 포트를 물고, 다음 실행의 컨테이너가
# "Bind for 0.0.0.0:$CTRL_PORT failed: port is already allocated" 로 기동 실패 → ③ gpredict
# 화면이 안 열린다. 그래서 실행 전에 우리 이미지의 잔존 컨테이너 + 해당 포트를 점유 중인
# 컨테이너를 정리한다. (포트 소유자는 docker 데몬이라 free_port 의 lsof-kill 을 쓰면 안 되고 —
# com.docker 를 죽이게 된다 — 반드시 docker stop 으로 내린다.)
free_gpredict() {
  have docker || return 0
  docker info >/dev/null 2>&1 || return 0     # 데몬 꺼져 있으면 정리할 것도 없음
  local ids pport
  ids="$(docker ps -q --filter "ancestor=$GP_IMG" 2>/dev/null)"          # 우리 이미지 잔존 컨테이너
  for pport in "$GP_PORT" "$CTRL_PORT"; do                               # 포트 점유 컨테이너(이미지 재빌드/다른 포트 대비)
    ids="$ids $(docker ps -q --filter "publish=$pport" 2>/dev/null)"
  done
  ids="$(printf '%s\n' $ids | sort -u | sed '/^$/d')"
  [ -z "$ids" ] && return 0
  c_warn "이전 gpredict 컨테이너/포트(:$GP_PORT,:$CTRL_PORT) 점유 정리 → docker stop: $(echo $ids | tr '\n' ' ')"
  echo "$ids" | xargs docker stop >/dev/null 2>&1 || true
}

# ── 시리얼 I/O 는 전부 공용 serial.js 를 거친다 ───────────────────────────────
# 예전엔 여기서 직접 `stty -f` + `exec 3<>/dev/cu.xxx` 로 포트를 다뤘는데, 이건 macOS 전용이라
# Windows(Git Bash)에선 stty 플래그도 장치 경로도 맞지 않아 아두이노가 통째로 죽었다.
# serial.js 가 OS 별 차이(stty ↔ mode.com, /dev/cu.* ↔ COM3, 열기 플래그)를 흡수한다.
SERIAL_JS="$SCN_DIR/../common/arduino/bridge/serial.js"

# 포트 존재 확인. Windows 의 'COM3' 은 파일이 아니라서 `[ -e ]` 가 항상 거짓이다.
port_exists() {
  case "${1:-}" in
    "") return 1 ;;
    [Cc][Oo][Mm][0-9]*) return 0 ;;
    *) [ -e "$1" ] ;;
  esac
}

# 한 시리얼 포트를 열어 WHOAMI 를 보내고 펌웨어가 응답하는 역할(antenna/solar)을 echo 한다.
# motor.sh 와 동일한 방식(펌웨어에 심은 ID 로 보드 식별). 응답 없으면 빈 문자열.
probe_serial_role() {
  local p="$1"
  port_exists "$p" || return 0
  have node || return 0
  node "$SERIAL_JS" whoami "$p" 9600 2>/dev/null | tr -d '\r' | head -1
}

# 연결된 시리얼 보드를 1회 탐지해 역할별 포트를 전역에 저장한다(flash·selftest·bridge 공유).
# ANT_PORT/SOLAR_PORT 로 강제 지정 가능. 미지정 포트는 WHOAMI 로 antenna/solar 분류.
# 포트 열거는 serial.js 가 OS 별로 처리한다(macOS cu.* · Linux ttyACM/USB · Windows COMx).
ANT_DEV=""; SOLAR_DEV=""
detect_boards() {
  ANT_DEV="${ANT_PORT:-}"; SOLAR_DEV="${SOLAR_PORT:-}"
  { [ -n "$ANT_DEV" ] && [ -n "$SOLAR_DEV" ]; } && return 0   # 둘 다 지정 → 탐색 불필요
  have node || return 0
  local p fq role scan; scan="$(node "$SERIAL_JS" boards 2>/dev/null | tr -d '\r')"
  while IFS=$'\t' read -r p fq; do
    port_exists "$p" || continue
    { [ "$p" = "$ANT_DEV" ] || [ "$p" = "$SOLAR_DEV" ]; } && continue
    role="$(probe_serial_role "$p")"
    [ -z "$ANT_DEV" ]   && [ "$role" = "antenna" ] && ANT_DEV="$p"
    [ -z "$SOLAR_DEV" ] && [ "$role" = "solar" ]   && SOLAR_DEV="$p"
  done <<EOF
$scan
EOF
}

# 스케치 자동 업로드(arduino-cli). 안테나=antenna_gimbal, 솔라=solar_panel_uno(또는 PANEL_SPIN
# 시 solar_panel_spin). 실패해도 기존 펌웨어로 계속. NO_FLASH=1 로 생략, FQBN 으로 보드 변경.
flash_boards() {
  [ "${NO_FLASH:-0}" = "1" ] && { c_warn "NO_FLASH=1 → 스케치 업로드 생략(기존 펌웨어 사용)"; return 0; }
  have arduino-cli || { c_warn "arduino-cli 없음 → 스케치 업로드 생략(기존 펌웨어 사용). 설치: macOS brew install arduino-cli · Windows winget install ArduinoSA.CLI"; return 0; }
  local fqbn="${FQBN:-arduino:avr:uno}"
  local solar_sketch; solar_sketch="$([ -n "${PANEL_SPIN:-}" ] && echo solar_panel_spin || echo solar_panel_uno)"
  if [ -z "$ANT_DEV" ] && [ -z "$SOLAR_DEV" ]; then
    c_warn "업로드할 보드 미식별 — 첫 업로드면 펌웨어가 없어 자동식별 불가. ANT_PORT=/dev/cu.xxx (SOLAR_PORT=...) 지정 후 재실행."
    return 0
  fi
  if [ -n "$ANT_DEV" ]; then
    say "안테나 스케치 업로드 → $ANT_DEV ($fqbn)"
    if arduino-cli compile --upload -p "$ANT_DEV" --fqbn "$fqbn" ../arduino/antenna_gimbal >/tmp/demosat-flash-ant.log 2>&1; then
      c_ok "antenna_gimbal 업로드 완료 → $ANT_DEV"
    else
      c_warn "안테나 업로드 실패 — /tmp/demosat-flash-ant.log 확인(코어 미설치면 'arduino-cli core install arduino:avr'). 기존 펌웨어로 계속."
    fi
  fi
  if [ -n "$SOLAR_DEV" ]; then
    say "솔라 스케치($solar_sketch) 업로드 → $SOLAR_DEV ($fqbn)"
    if arduino-cli compile --upload -p "$SOLAR_DEV" --fqbn "$fqbn" "../arduino/$solar_sketch" >/tmp/demosat-flash-solar.log 2>&1; then
      c_ok "$solar_sketch 업로드 완료 → $SOLAR_DEV"
    else
      c_warn "솔라 업로드 실패 — /tmp/demosat-flash-solar.log 확인. 기존 펌웨어로 계속."
    fi
  fi
}

# 안테나 2축 모터 자가진단: az 모터·el 모터를 각각 왕복시켜 동작을 확인한 뒤, 콘솔 ENGAGE 조준각과
# '다른' 준비 자세(READY_AZ/READY_EL, 기본 0°/0°)로 정렬한다. 브리지 기동 前에 직접 시리얼로 수행.
# NO_SELFTEST=1 로 생략. (브리지가 뜨면 피해 GS 지향각을 반영하므로 준비 자세는 시작 확인용이다.)
motor_selftest() {
  [ "${NO_SELFTEST:-0}" = "1" ] && return 0
  local p="$ANT_DEV"
  port_exists "$p" || { c_warn "안테나 보드 없음 → 모터 자가진단 생략"; return 0; }
  have node || { c_warn "node 없음 → 모터 자가진단 생략"; return 0; }
  local raz="${READY_AZ:-0}" rel="${READY_EL:-0}"
  say "안테나 모터 자가진단 — az·el 각각 왕복 후 준비 자세 ${raz}°/${rel}°"
  # 각 인자는 "대기ms:보낼줄" — serial.js 가 한 번 연 포트로 순서대로 흘려보낸다.
  if node "$SERIAL_JS" send "$p" 9600 \
       "2200:"                        `# 스케치 부팅 대기(포트 열림 = Uno 리셋)` \
       "400:TRACK"                    `# 스윕/스핀 해제 → 위치추종 모드` \
       "2500:AZ 300"                  `# ① az 모터 이동` \
       "2500:AZ 60"                   `# ② az 모터 반대로` \
       "2500:EL 80"                   `# ③ el 모터 이동` \
       "2500:EL 10"                   `# ④ el 모터 반대로` \
       "3000:AZEL $raz $rel"          `# ⑤ 준비 자세로 정렬(두 모터 동시)` \
       2>/dev/null; then
    c_ok "모터 자가진단 완료 → 준비 자세 az=${raz}° el=${rel}° (ENGAGE 시 여기서 목표각으로 움직이는 게 보임)"
  else
    c_warn "자가진단: $p 열기/전송 실패 → 생략(브리지는 그대로 시도)"
  fi
}

# Arduino 브리지 기동(best-effort). 피해 GS(:4543) 상태를 폴링해 물리 안테나(AZEL/SWEEP)와
# 솔라 패널 모터를 시리얼로 구동한다. detect_boards 가 찾은 포트를 사용. 보드가 없으면(부스 미연결)
# 경고만 남기고 건너뛴다 — 브리지는 모터 구동 전용이라 나머지 공격 화면과 무관하다.
start_bridge() {
  have node || { c_warn "node 없음 → Arduino 브리지 건너뜀(모터 미구동)"; return 0; }
  if [ -z "$ANT_DEV" ] && [ -z "$SOLAR_DEV" ]; then
    c_warn "시리얼 보드 없음/미식별 → Arduino 브리지 건너뜀(모터 미구동, 화면은 정상). 필요 시 ANT_PORT=/dev/cu.xxx 로 지정."
    return 0
  fi
  ( cd ../arduino/bridge && GS_URL="$GS_URL" ANT_PORT="$ANT_DEV" SOLAR_PORT="$SOLAR_DEV" \
      ${PANEL_SPIN:+PANEL_SPIN="$PANEL_SPIN"} node bridge.js ) >/tmp/demosat-bridge.log 2>&1 &
  pids+=($!)
  c_ok "Arduino 브리지 실행 (ant=${ANT_DEV:-—} solar=${SOLAR_DEV:-—}) → 피해 GS(:4543) 폴링. 로그: /tmp/demosat-bridge.log"
}

# ── 최초 설치 ────────────────────────────────────────────────────────────────
install() {
  say "1/3  최초 설치"
  have node   || die "node 가 없습니다 → https://nodejs.org (LTS) 설치 후 다시 실행"
  have npm    || die "npm 이 없습니다 (Node 설치 시 함께 제공)"
  local SYSPY; SYSPY="$(sys_python)" \
    || die "실행 가능한 Python 3 없음 → python.org 에서 설치(설치 시 'Add to PATH'). Windows 는 설정→앱→'앱 실행 별칭'에서 python/python3(Store 스텁)을 끄거나 py 런처를 두세요."

  # ① Command Builder — Python venv + numpy (전역 오염 방지)
  echo "[1/3] Command Builder Python 의존성 (numpy) → $VENV"
  if [ -z "$(venv_py)" ]; then   # venv 인터프리터가 없으면(미생성/이전 스텁 실패) 새로 만든다
    "$SYSPY" -m venv "$VENV" || die "venv 생성 실패 (Debian이면 'sudo apt install python3-venv')"
  fi
  local VPY; VPY="$(venv_py)"; [ -n "$VPY" ] || die "venv python 을 찾을 수 없음 ($VENV)"
  "$VPY" -m pip install --quiet --upgrade pip \
    && "$VPY" -m pip install --quiet numpy \
    || die "numpy 설치 실패"
  c_ok "numpy 준비됨"

  # ② OpenVSA — Node 의존성 (프로젝트 로컬)
  echo "[2/3] OpenVSA Node 의존성 → openvsa/node_modules (전역 아님)"
  ( cd openvsa && npm install --no-audit --no-fund ) || die "OpenVSA npm install 실패"
  c_ok "OpenVSA 의존성 준비됨"

  # ③ gpredict — Docker 이미지 빌드 (선택; ③ 위성 조준 화면)
  echo "[3/3] gpredict Docker 이미지 빌드 → $GP_IMG (선택)"
  if ensure_docker; then
    ( cd gpredict-web && docker build -t "$GP_IMG" . ) \
      && c_ok "gpredict 이미지 준비됨" \
      || c_warn "gpredict 이미지 빌드 실패 — ③ 조준 화면 없이도 나머지는 동작"
  else
    c_warn "docker 없음 → gpredict(③ 조준) 건너뜀. Command Builder + OpenVSA + 콘솔은 정상."
  fi
  echo "설치 완료."
}

# ── 설치 확인 ────────────────────────────────────────────────────────────────
check() {
  say "2/3  설치 확인"
  local ok=1 py; py="$(pick_python)"

  have node && c_ok "node $(node --version)" || { c_err "node 없음"; ok=0; }

  if "$py" -c "import numpy" 2>/dev/null; then
    c_ok "numpy $("$py" -c 'import numpy;print(numpy.__version__)') ($py)"
  else
    c_err "numpy 임포트 실패 → './start-attacker.sh install' 먼저"; ok=0
  fi

  # 코덱 계약(생성↔디코드 라운드트립) 검증
  if "$py" packet-generator/tests/test_roundtrip.py 2>/dev/null | grep -q "ALL PASSED"; then
    c_ok "roundtrip 테스트 ALL PASSED (코덱 정상)"
  else
    c_err "roundtrip 테스트 실패 (경로/numpy 확인)"; ok=0
  fi

  [ -d openvsa/node_modules ] && c_ok "OpenVSA 의존성 존재" || { c_err "openvsa/node_modules 없음 → install"; ok=0; }

  if have docker; then
    if docker image inspect "$GP_IMG" >/dev/null 2>&1; then
      c_ok "gpredict 이미지 '$GP_IMG' 존재"
    else
      c_warn "gpredict 이미지 미빌드 (선택) — 'install' 재실행 시 빌드"
    fi
  else
    c_warn "docker 없음 (선택) — ③ 조준 화면 비활성"
  fi

  [ "$ok" -eq 1 ] && echo "확인 통과." || die "확인 실패 — 위 항목을 해결한 뒤 다시 실행"
}

# ── attacker 화면 실행 ────────────────────────────────────────────────────────
up() {
  say "3/3  attacker 화면 실행"
  rm -f "$READY_FLAG" 2>/dev/null || true   # not-ready until the full setup finishes
  local py; py="$(pick_python)"
  [ -n "$py" ] || die "python 인터프리터를 찾을 수 없음 → './start-attacker.sh install' 먼저"
  "$py" -c "import numpy" 2>/dev/null || die "numpy 없음 → './start-attacker.sh install' 먼저"
  # 서브셸에서 cd 후에도 안전하도록 파이썬을 절대경로로 고정.
  #   · 경로형(venv 상대경로/변환된 py.exe) → dirname 을 절대경로화
  #   · 명령이름형(python3 등) → command -v 로 절대경로 해석
  local PY_ABS="$py"
  case "$PY_ABS" in
    */*) PY_ABS="$(cd "$(dirname "$PY_ABS")" && pwd)/$(basename "$PY_ABS")" ;;
    *)   PY_ABS="$(command -v "$PY_ABS")" ;;
  esac

  local pids=()
  cleanup() {
    echo; echo "[cleanup] 종료 중…"
    # Windows 는 bash 서브셸을 죽여도 그 아래 node/python 자식이 살아 포트를 계속 문다 →
    # kill_shell_tree 가 WINPID 로 변환해 taskkill //T 로 트리째 내린다(그 외 OS 는 kill 과 동일).
    local _p; for _p in "${pids[@]:-}"; do kill_shell_tree "$_p"; done
    if have docker; then
      docker ps -q --filter "ancestor=$GP_IMG" | xargs -r docker stop >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT INT TERM

  # ── preflight: 이전 실행이 남긴 좀비가 포트를 물고 있으면 정리(bind 실패 사고 예방) ──
  free_port "$BUILDER_PORT" "Command Builder"
  # OpenVSA 백엔드(node server.js)가 물던 포트도 함께 정리한다. 이걸 안 하면 좀비 OpenVSA가
  # WS :4534 를 물고 있어 새 server.js 가 bind 실패로 조용히 죽고 → /vsa 렌더러의 WS 연결이
  # 안 돼 STEP 2 'VIRTUAL ANTENNA UPLINK' 패널이 백지로 남는다(② 위성 조준 화면 안 열림).
  #   :4532 rigctld · :4533 rotctld · :4534 WS(렌더러). (:4553 은 피해 GS 목적지라 바인딩 안 함)
  free_port 4534 "OpenVSA WS"
  free_port 4533 "OpenVSA rotctld"
  free_port 4532 "OpenVSA rigctld"
  local DOCKER_OK=0; ensure_docker && DOCKER_OK=1   # 꺼져 있으면 Docker 데몬 자동 기동+대기(③ gpredict용)
  [ "$DOCKER_OK" = 1 ] && free_gpredict   # 잔존 gpredict 컨테이너가 :GP_PORT/:CTRL_PORT 물면 내림(③ 사고 예방)

  # ① Command Builder (:BUILDER_PORT) — 시나리오 config/extras 를 함께 전달(④+ 페이즈)
  mkdir -p "$UPLINK_OUT_DIR"
  ( cd "$BUILDER_DIR" && UPLINK_OUT_DIR="$UPLINK_OUT_DIR" PORT="$BUILDER_PORT" \
      EXTRA_DIR="$EXTRA_DIR_ARG" SCENARIO_CONFIG="$SCENARIO_CONFIG" "$PY_ABS" app.py ) \
    >/tmp/demosat-builder.log 2>&1 &
  pids+=($!)

  # ③ gpredict web (:GP_PORT) + 시간제어(:CTRL_PORT) — Docker, 선택
  local GP=""
  if [ "$DOCKER_OK" = 1 ]; then
    ( cd gpredict-web && WEB_PORT="$GP_PORT" CTRL_PORT="$CTRL_PORT" IMG="$GP_IMG" ./run.sh ) >/tmp/demosat-gpredict.log 2>&1 &
    pids+=($!)
    GP="http://localhost:$GP_PORT/vnc.html?autoconnect=1&resize=remote"
    # 컨테이너가 포트 바인딩에 실패하면(잔존 컨테이너 등) 로그에 남기고 계속 —
    # 다른 화면(①②③ Virtual Antenna)은 gpredict 없이도 동작.
    for _ in $(seq 1 30); do
      curl -fsS "http://localhost:$GP_PORT/vnc.html" >/dev/null 2>&1 && break
      grep -q "already allocated\|address already in use" /tmp/demosat-gpredict.log 2>/dev/null && {
        c_warn "gpredict 컨테이너가 포트(:$GP_PORT/:$CTRL_PORT) 바인딩 실패 — /tmp/demosat-gpredict.log 확인. free_gpredict 후에도 남으면 'docker ps' 로 점유 컨테이너 확인."
        break; }
      sleep 0.3
    done
  fi

  # ③ OpenVSA 백엔드(rotctld :4533 ← gpredict / rigctld :4532 / WS :4534 → 렌더러 시각화 / forward :4553).
  #   OpenVSA UI(렌더러)는 :8003 이 /vsa 로 서빙한다 — 별도 :8090 프록시·데스크탑 창 없음.
  ( cd openvsa && UPLINK_DEST="$UPLINK_DEST" node server.js ) >/tmp/demosat-openvsa.log 2>&1 &
  pids+=($!)
  # WS :4534 가 실제로 떴는지 확인 — 안 뜨면 STEP 2 'VIRTUAL ANTENNA UPLINK' 가 백지로 남으므로
  # 조용히 넘어가지 않고 원인을 명시한다(대개 포트 잔존·bind 실패).
  local VSA_OK=0
  for _ in $(seq 1 25); do
    [ -n "$(port_pids 4534)" ] && { VSA_OK=1; break; }
    grep -qiE "EADDRINUSE|address already in use" /tmp/demosat-openvsa.log 2>/dev/null && break
    sleep 0.2
  done
  if [ "$VSA_OK" = 1 ]; then
    c_ok "OpenVSA 백엔드 준비됨 (WS :4534) — STEP 2 Virtual Antenna 활성"
  else
    c_err "OpenVSA WS :4534 안 뜸 → STEP 2 'VIRTUAL ANTENNA UPLINK' 백지. /tmp/demosat-openvsa.log 확인(대개 포트 잔존/bind 실패)."
  fi

  # ③ Arduino (scn2 전용) — 보드 감지 → 스케치 업로드 → 모터 자가진단 → 브리지 기동.
  #   피해 GS(:4543) /api/state 를 폴링해 물리 안테나(AZ/EL)·솔라 '모터'를 구동한다.
  #   보드가 USB로 연결돼 있어야 실제로 돈다. 없으면 경고만 하고 건너뜀(화면은 정상).
  if grep -q '"arduinoBridge"[[:space:]]*:[[:space:]]*true' "$SCENARIO_CONFIG" 2>/dev/null; then
    detect_boards      # 시리얼 포트 1회 탐지(WHOAMI 역할 분류) → ANT_DEV/SOLAR_DEV
    flash_boards       # antenna_gimbal / solar 스케치 자동 업로드(arduino-cli)
    motor_selftest     # az·el 모터 왕복 테스트 후 준비 자세 정렬
    start_bridge       # 브리지 기동(이후 피해 GS 지향각·acquire 스윕 반영)
  fi

  # 단일 진입점 = :8003 하나. ① 명령 조립 → ② IQ 생성 → ③ 위성 조준 이 한 앱 안에서 전부.
  #   ③ 조준: 콘솔=:8003 /targeting · OpenVSA=:8003 /vsa · gpredict noVNC=Docker(:GP_PORT) 직접 iframe.
  local BUILDER_URL="http://localhost:$BUILDER_PORT/?gs=$GS_URL&gpport=$GP_PORT&ctrlport=$CTRL_PORT"

  # 빌더(:8003)가 응답할 때까지 대기(최대 ~10초)
  for _ in $(seq 1 50); do
    curl -fsS "http://localhost:$BUILDER_PORT/" >/dev/null 2>&1 && break
    sleep 0.2
  done

  echo "───────────────────────────────────────────────"
  c_ok "공격자 콘솔(단일 앱·단일 포트) → $BUILDER_URL"
  echo "     ① 명령 조립 → ② IQ 생성 → ③ 위성 조준(gpredict+OpenVSA 임베드)"
  echo "     ③ 소스: OpenVSA UI=:$BUILDER_PORT/vsa · gpredict=Docker :$GP_PORT(직접 iframe) · OpenVSA WS=:4534"
  [ -z "$GP" ] && c_warn "gpredict 미실행(docker 없음) → ③ gpredict 창 비활성, 나머지는 정상"
  echo "   ⑤ 피해 지상국은 별도 실행:  ./start-victim.sh  (또는 cd ../common/victim/backend && node server.js)"
  echo "   ℹ️ ③ TRANSMIT은 피해 GS API(/api/inject)로 공격 명령을 발사합니다."
  grep -q '"arduinoBridge"[[:space:]]*:[[:space:]]*true' "$SCENARIO_CONFIG" 2>/dev/null && \
    echo "   🔩 Arduino(보드 연결 시): 스케치 자동 업로드 → 모터 자가진단(왕복+준비자세) → 브리지가 피해 GS(:4543) 지향각/스윕 반영. 로그 /tmp/demosat-{flash-ant,flash-solar,bridge}.log"
  echo "───────────────────────────────────────────────"

  # Setup done → mark attacker ready (the finale's restart reload waits for this).
  : > "$READY_FLAG" 2>/dev/null || true

  open_url "$BUILDER_URL"   # 단일 진입점 (②③ 전부 이 앱 안에서)
  c_ok "브라우저에서 화면 열림  (자동 열기 끄려면 NO_OPEN=1)"

  echo "종료하려면 Ctrl-C"
  wait
}

case "$MODE" in
  install) install ;;
  check)   check ;;
  up)      up ;;
  # 인자 없이 실행(기본) = 설치 → 확인 → 실행(up). up 안에서 모터 스케치 업로드·자가진단·브리지까지
  # 전부 수행하므로 './start-attacker.sh' 만으로 모든 준비자세가 돈다('up' 을 따로 칠 필요 없음).
  # check 는 서브셸로 감싸 실패해도 스크립트가 죽지 않게 한다 — up 이 자체 가드를 갖고 있어,
  # '그냥 실행'이 항상 up(모터 준비)까지 도달하도록 보장한다.
  all)     install; ( check ) || c_warn "확인 단계 경고 있음 — 그래도 실행(up)까지 계속 진행"; up ;;
  *) die "알 수 없는 모드 '$MODE' (사용: install | check | up | all)";;
esac
