#!/usr/bin/env bash
# start-attacker.sh — attacker 쪽 원샷 부트스트랩: 최초 설치 → 설치 확인 → 화면 실행.
# 시나리오 폴더에 두지만 phase 1-3 자원은 전부 공용 ../common/attacker 아래에 있어
# 스스로 그리로 진입한다. 시나리오별 차이는 이 폴더의 scenario.json + extras/ 로만 표현.
#
# 단일 포트(:8002) 하나로 ①②③ 전부. 별도 창/프록시 포트 없음.
#   http://localhost:8002  Command Builder (Python)
#     ├ 페이즈① 명령 조립  ·  페이즈② IQ 생성
#     └ 페이즈③ 위성 조준:  /targeting(콘솔) + /vsa(OpenVSA 렌더러) + gpredict(:6082) 직접 iframe
#
# ※ OpenVSA는 Electron 앱이지만 렌더러는 정적 웹(+WS :4534)이라 :8002이 /vsa 로 서빙한다.
#   gpredict noVNC는 Docker :6082 을 그대로 iframe(프록시 불필요). TRANSMIT은 피해 GS API(/api/inject).
#
# 사용법 (시나리오 폴더에서):
#   ./start-attacker.sh            # 설치 + 확인 + 실행 (전체)
#   ./start-attacker.sh install    # 설치만 (최초 1회)
#   ./start-attacker.sh check      # 설치 확인만
#   ./start-attacker.sh up         # 화면 실행만 (설치가 끝난 뒤)
#
# 환경변수(선택):
#   GS_URL       피해 지상국 base (ACQUIRE/RESET·forward 대상). 기본 http://localhost:4542
#   BUILDER_PORT ① Command Builder 포트. 기본 8002
#   CONSOLE_PORT ③ 조준 콘솔 단일 포트(console+vsa+gpredict). 기본 8090
#   GP_PORT      gpredict noVNC Docker 포트(프록시 대상). 기본 6082
#   GP_IMG       gpredict Docker 이미지명. 기본 demosat-gpredict
#   UPLINK_OUT_DIR  attack.cf32 출력 폴더. 기본 ~/uplink
#   NO_OPEN      1이면 브라우저 자동 열기 끄기 (기본: 실행 후 ①③ 화면 자동 오픈)
#   ANT_PORT     안테나 아두이노 시리얼 포트 강제 지정(미지정 시 WHOAMI 자동탐지).
#                예 macOS /dev/cu.usbmodem1101 · Linux /dev/ttyACM0 · Windows COM3
#   SOLAR_PORT   솔라 패널 아두이노 시리얼 포트 강제 지정(미지정 시 WHOAMI 자동탐지).
#   PANEL_SPIN   1이면 솔라 패널을 연속회전 서보로 취급(공격 시 SPIN). bridge.js 로 전달.
#   ── Arduino(scn2 전용, scenario.json 의 "arduinoBridge": true 일 때만) ──
#   FQBN         업로드 보드 타입. 미지정 시 안테나는 arduino-cli 자동감지 FQBN(예 MKR WiFi
#                1010 → arduino:samd:mkrwifi1010), 솔라는 arduino:avr:uno. 강제 지정도 가능.
#   NO_FLASH     1이면 스케치 자동 업로드 + 코어/라이브러리 자동 설치 생략(기존 펌웨어 사용)
#                ※ 업로드 전 필요한 코어(SAMD/AVR)와 Stepper 라이브러리를 arduino-cli 로 자동 설치.
#                  업로드 후엔 WHOAMI 재프로브로 안테나·솔라 '연결신호'를 확인·요약 출력한다.
#   NO_SELFTEST  1이면 모터 자가진단(왕복+준비자세) 생략
#   READY_AZ     자가진단 후 준비 자세 방위각. 기본 180 (보드 부팅 가정값과 같게 — 케이블 꼬임 방지)
#   READY_EL     자가진단 후 준비 자세 앙각. 기본 50 (조준 시 10°로 크게 틸트하도록 합의)
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
GS_URL="${GS_URL:-http://localhost:4542}"
BUILDER_PORT="${BUILDER_PORT:-8002}"
CONSOLE_PORT="${CONSOLE_PORT:-8090}"   # 단일 포트: console(/) + OpenVSA(/vsa) + gpredict(/gpredict)
GP_PORT="${GP_PORT:-6082}"
CTRL_PORT="${CTRL_PORT:-6072}"   # gpredict 시간제어 서버(phase3 → /arm). noVNC(GP_PORT)와 한 쌍.
GP_IMG="${GP_IMG:-demosat-gpredict}"
UPLINK_DEST="${UPLINK_DEST:-ws://localhost:4552}"
UPLINK_OUT_DIR="${UPLINK_OUT_DIR:-$HOME/uplink}"
# "attacker fully ready" flag — written only AFTER the antenna/solar setup finishes, so
# the finale's restart reload waits for the hardware (not just the web builder). app.py
# serves it at /api/ready; run-booth.sh clears it on restart.
export READY_FLAG="${READY_FLAG:-/tmp/demosat-attacker-ready.flag}"
# 하드웨어 프로비저닝 캐시 — 최초(mode=all) 1회에 감지한 보드 포트/FQBN 을 적어두고,
# 재시작(mode=up)엔 이 파일이 있으면 포트감지·펌웨어 업로드·모터 자가진단을 건너뛴다
# (다음 참가자 리셋을 빠르게). 부스 전체를 새로 켜면 mode=all 이라 캐시와 무관하게 다시
# 프로비저닝한다. 보드를 바꿔 꽂았거나 강제 재감지하려면 이 파일을 지우면 된다.
export HW_CACHE="${HW_CACHE:-/tmp/demosat-attacker-hw.env}"
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

# 이전 실행이 남긴 Arduino 브리지(node bridge.js)를 정리한다. TCP 가 아니라 시리얼 포트를 물기
# 때문에 free_port 로는 안 잡힌다. 안 죽이면 그 좀비 브리지가 포트를 계속 쥐고 있어:
#   ① 새 브리지와 '동시에 같은 시리얼에 write' → 명령이 바이트 단위로 뒤섞여(MODE/ANG 깨짐)
#      서보·모터가 제대로 안 돈다.  ② flash 업로드가 'Resource busy' 로 실패한다.
# 그래서 detect/flash/selftest/새 브리지 이전에 반드시 정리한다. 데모 전용이라 bridge.js 매칭 안전.
free_serial_bridge() {
  local victims; victims="$(pids_by_pattern 'bridge\.js')"
  [ -z "$victims" ] && return 0
  c_warn "이전 Arduino 브리지 정리(시리얼 중복 write 방지) → kill: $(echo $victims | tr '\n' ' ')"
  kill_by_pattern 'bridge\.js'
  sleep 1
  [ -n "$(pids_by_pattern 'bridge\.js')" ] && { kill_by_pattern 'bridge\.js'; sleep 1; }
  return 0
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

# 종료(Ctrl+C 등) 시 모터를 정지시킨다. 스케치는 공격(mode 1)이면 스스로 계속 왕복하므로,
# 브리지를 죽이는 것만으로는 안 멈춘다 — 보드에 MODE 0(정지)을 직접 보내야 한다.
# (브리지 SIGTERM 핸들러도 MODE 0 을 보내지만, 브리지가 이미 죽었을 때를 대비한 안전빵.)
stop_motors() {
  local dev
  have node || return 0
  for dev in "$SOLAR_DEV" "$ANT_DEV"; do
    port_exists "$dev" || continue
    # 포트를 여는 순간 Uno 는 리셋된다 → 부팅을 기다렸다가 MODE 0 을 보내야 먹는다.
    # (MKR 같은 네이티브 USB 보드는 리셋되지 않으므로 이 MODE 0 이 유일한 정지 수단이다.)
    node "$SERIAL_JS" send "$dev" 9600 "1800:" "300:MODE 0" >/dev/null 2>&1 || true
  done
}

# gpredict(③ 조준)는 Docker 컨테이너로만 뜨기 때문에 데몬이 꺼져 있으면 화면이 안 열린다.
# 그래서 여기서 데몬을 자동 기동하고 올라올 때까지 기다린다. Docker CLI 자체가 없으면(미설치)
# 조용히 실패(1) → 호출부가 gpredict 없이 진행. 성공 0 / 실패 1. 최대 DOCKER_WAIT(기본 90)초 대기.
ensure_docker() {
  if ! have docker; then
    # 미설치 → 자동 설치 시도(gpredict ③ 조준 전용, 선택). Docker Desktop 은 대용량이고 최초
    # 실행에 WSL2/재부팅·라이선스 동의가 필요할 수 있어 '이번 세션'에서 바로 못 쓸 수 있다 →
    # 설치만 걸고 안내한다. 실패해도 나머지(①②③ Virtual Antenna·모터)는 정상.
    if [ "${IS_WINDOWS:-0}" = 1 ] && have winget; then
      say "docker 미설치 → Docker Desktop 자동 설치 시도(gpredict ③ 조준용, 선택)"
      winget install --id Docker.DockerDesktop -e --silent \
        --accept-package-agreements --accept-source-agreements >/tmp/demosat-docker-install.log 2>&1 || true
      hash -r 2>/dev/null || true
    fi
    have docker || { c_warn "docker 없음 — Docker Desktop 설치/실행 후 '새 터미널'에서 재실행하면 gpredict ③ 이 켜집니다(선택). 나머지는 지금도 정상. 로그: /tmp/demosat-docker-install.log"; return 1; }
  fi
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

# 한 시리얼 포트를 열어 WHOAMI 를 보내고 펌웨어가 응답하는 역할(antenna/solar)을 echo 한다.
# motor.sh 와 동일한 방식(펌웨어에 심은 ID 로 보드 식별). 응답 없으면 빈 문자열.
# 실제 시리얼 열기·보율 설정·타임아웃 읽기는 serial.js 가 OS 별로 처리한다
# (Windows 는 .NET SerialPort 를 써서 ReadTimeout 이 정확히 지켜지도록 한다).
probe_serial_role() {
  local p="$1"
  port_exists "$p" || return 0
  have node || return 0
  node "$SERIAL_JS" whoami "$p" 9600 2>/dev/null | tr -d '\r' | head -1
}

# 연결된 USB 시리얼 포트를 스캔해 "포트<TAB>추정FQBN" 행으로 출력한다. arduino-cli 가 있으면
# board list 로 칩 종류와 무관하게(정품 Uno·CH340/CP210x 클론 등) 포트를 잡고, 정품 보드는 FQBN
# 까지 얻는다. 블루투스/디버그 포트(properties 없음·이름 불일치)는 제외. arduino-cli 가 없으면
# OS 별 포트 열거로 폴백(macOS cu.* · Linux ttyACM/ttyUSB · Windows COMx).
#   ※ 예전엔 이 JSON 을 python3 로 팠는데 Windows 엔 'python3' 이름이 없는 설치가 흔해 조용히
#     폴백으로 떨어졌고, 그 폴백마저 /dev/cu.* glob 이라 Windows 에선 결과가 늘 비었다.
#     이제 파싱까지 serial.js(node) 가 맡는다 — node 는 어차피 필수 의존성이다.
list_serial_ports() {
  have node || return 0
  node "$SERIAL_JS" boards 2>/dev/null | tr -d '\r'
}

# 연결된 보드를 1회 탐지해 역할별 포트를 전역에 저장한다(flash·selftest·bridge 공유).
# ANT_PORT/SOLAR_PORT 로 강제 지정 가능. 미지정 포트는 WHOAMI 로 antenna/solar 분류하고,
# 펌웨어가 아직 없어(첫 업로드) WHOAMI 무응답인 USB 시리얼이 정확히 1개면 안테나로 가정한다.
ANT_DEV=""; SOLAR_DEV=""; ANT_ASSUMED=0; ANT_FQBN=""
detect_boards() {
  ANT_DEV="${ANT_PORT:-}"; SOLAR_DEV="${SOLAR_PORT:-}"
  { [ -n "$ANT_DEV" ] && [ -n "$SOLAR_DEV" ]; } && return 0   # 둘 다 지정 → 탐색 불필요
  local scan; scan="$(list_serial_ports)"
  local p fq role
  local unknown=()
  while IFS=$'\t' read -r p fq; do
    port_exists "$p" || continue
    { [ "$p" = "$ANT_DEV" ] || [ "$p" = "$SOLAR_DEV" ]; } && continue
    role="$(probe_serial_role "$p")"
    if   [ "$role" = "antenna" ] && [ -z "$ANT_DEV" ];   then ANT_DEV="$p"; [ -z "$ANT_FQBN" ] && ANT_FQBN="$fq"
    elif [ "$role" = "solar" ]   && [ -z "$SOLAR_DEV" ]; then SOLAR_DEV="$p"
    elif [ -z "$role" ];                                 then unknown+=("$p"$'\t'"$fq")   # 펌웨어 미탑재(첫 업로드) 후보
    fi
  done <<EOF
$scan
EOF
  # WHOAMI 무응답만 남음 = 첫 업로드로 펌웨어가 아직 없음. 안테나가 주 보드이므로 미분류 후보가
  # 정확히 1개면 안테나로 가정해 업로드한다(업로드 후에는 WHOAMI 로 정상 식별). 2개 이상이면 특정 불가.
  if [ -z "$ANT_DEV" ] && [ "${#unknown[@]}" -ge 1 ]; then
    if [ "${#unknown[@]}" -eq 1 ]; then
      IFS=$'\t' read -r ANT_DEV ANT_FQBN <<<"${unknown[0]}"
      ANT_ASSUMED=1
      c_warn "WHOAMI 무응답 USB 시리얼 1개($ANT_DEV) → 첫 업로드로 보고 안테나로 가정해 업로드합니다(아니면 ANT_PORT 로 지정)."
    else
      c_warn "WHOAMI 무응답 USB 시리얼이 여러 개 → 어느 게 안테나인지 특정 불가. ANT_PORT=/dev/cu.xxx (SOLAR_PORT=...) 지정 후 재실행:"
      local u; for u in "${unknown[@]}"; do c_warn "   • ${u%%$'\t'*}"; done
    fi
  fi
}

# arduino-cli 자체 자동 설치 — 이게 없으면 스케치(antenna_gimbal·solar)가 한 번도 업로드되지
# 않아 보드가 빈/옛 펌웨어로 남고 → WHOAMI 무응답 + 모터가 전혀 안 움직인다. 그래서 flash 전에
# arduino-cli 부재 시 자동 설치한다. Windows=winget(ArduinoSA.CLI)·macOS=brew·Linux=공식 install.sh.
# ※ winget 은 shim 을 '새 셸'부터 PATH 에 넣으므로, 이번 세션에서 바로 쓰도록 설치 경로를 찾아
#   PATH 앞에 붙인다(안 그러면 방금 깔고도 have arduino-cli 가 거짓이라 또 스킵된다). best-effort.
ensure_arduino_cli() {
  have arduino-cli && return 0
  say "arduino-cli 미설치 → 자동 설치 시도(모터 펌웨어 업로드에 필수)"
  local log=/tmp/demosat-arduino-cli-install.log
  case "$(uname)" in
    Darwin)
      have brew && brew install arduino-cli >"$log" 2>&1 \
        || c_warn "brew 로 arduino-cli 설치 실패 — 'brew install arduino-cli' 수동 실행" ;;
    Linux)
      if have curl; then
        curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
          | BINDIR="$HOME/.local/bin" sh >"$log" 2>&1 || true
        [ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH"
      else
        c_warn "curl 없음 — arduino-cli 수동 설치 필요"
      fi ;;
    *)  # Windows (Git Bash)
      if have winget; then
        winget install --id ArduinoSA.CLI -e --silent \
          --accept-package-agreements --accept-source-agreements >"$log" 2>&1 || true
        # winget/MSI 설치물은 '새 셸'부터 PATH 에 잡힌다 → 이번 세션에서 바로 쓰도록 설치 위치를
        # 직접 찾아 PATH 앞에 붙인다. 설치 형태별로 위치가 다르다:
        #   · MSI(ArduinoSA.CLI 1.5+) → "C:\Program Files\Arduino CLI\arduino-cli.exe"
        #   · 포터블/구버전       → winget Links shim 또는 Packages 폴더
        local la; la="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null)"; [ -z "$la" ] && la="$HOME/AppData/Local"
        local pf; pf="$(cygpath -u "${ProgramFiles:-}" 2>/dev/null)"; [ -z "$pf" ] && pf="/c/Program Files"
        local d
        for d in "$pf/Arduino CLI" "/c/Program Files/Arduino CLI" "/c/Program Files (x86)/Arduino CLI" \
                 "$la/Microsoft/WinGet/Links"; do
          [ -x "$d/arduino-cli.exe" ] && { PATH="$d:$PATH"; break; }
        done
        if ! command -v arduino-cli >/dev/null 2>&1; then
          local exe
          exe="$(find "$pf" "/c/Program Files (x86)" "$la/Microsoft/WinGet/Packages" \
                   -maxdepth 4 -iname 'arduino-cli.exe' 2>/dev/null | head -1)"
          [ -n "$exe" ] && PATH="$(dirname "$exe"):$PATH"
        fi
      else
        c_warn "winget 없음 — arduino-cli 수동 설치: winget install ArduinoSA.CLI"
      fi ;;
  esac
  hash -r 2>/dev/null || true
  if have arduino-cli; then
    c_ok "arduino-cli 준비됨 ($(arduino-cli version 2>/dev/null | head -1))"
    return 0
  fi
  c_warn "arduino-cli 가 이번 세션 PATH 에 아직 안 잡힘 — 부스를 '새 터미널'에서 다시 실행하면 잡힙니다. 로그: $log"
  return 1
}

# arduino-cli 코어/라이브러리 자동 설치 — 자동 업로드(flash_boards)가 '첫 실행부터' 성공하도록.
# 안테나 스케치(antenna_gimbal)는 Stepper 라이브러리를 쓰는데, 이게 없으면 compile 이
# 'Stepper.h: No such file or directory' 로 실패한다. 또 보드 코어(MKR=arduino:samd,
# Uno=arduino:avr)가 없으면 업로드가 실패한다. 감지된 FQBN 의 코어 + Stepper 를 미리 깐다.
# 이미 있으면 no-op. arduino-cli 없거나 NO_FLASH=1 이면 건너뜀. best-effort(실패해도 계속).
ensure_arduino_deps() {
  [ "${NO_FLASH:-0}" = "1" ] && return 0
  have arduino-cli || return 0
  # ① 스케치 의존 라이브러리:
  #    · antenna_gimbal              → AccelStepper
  #    · solar_panel_uno/_spin       → Servo
  #   ⚠ 최신 arduino-cli(1.5+)/AVR 코어는 Servo 가 '코어 번들'이 아니라 별도 라이브러리다.
  #     없으면 솔라 컴파일이 'Servo.h: No such file or directory' 로 실패 → 솔라 모터가 flash
  #     안 돼 안 움직인다. 그래서 AccelStepper 와 Servo 를 둘 다 확인·설치한다.
  : >/tmp/demosat-ard-deps.log
  local lib
  for lib in AccelStepper Servo; do
    if ! arduino-cli lib list 2>/dev/null | grep -qi "^$lib[[:space:]]"; then
      say "arduino-cli: $lib 라이브러리 설치(스케치 의존)"
      if arduino-cli lib install "$lib" >>/tmp/demosat-ard-deps.log 2>&1; then
        c_ok "$lib 라이브러리 준비됨"
      else
        c_warn "$lib 설치 실패 — /tmp/demosat-ard-deps.log (해당 스케치 컴파일이 실패할 수 있음)"
      fi
    fi
  done
  # ② 감지된 보드 FQBN 의 코어 설치. FQBN 'vendor:arch:board' 에서 'vendor:arch' 만 추출.
  #    예) arduino:samd:mkrwifi1010 → arduino:samd,  arduino:avr:uno → arduino:avr.
  local fqbn core seen=""
  for fqbn in "${FQBN:-}" "${ANT_FQBN:-}" "arduino:avr:uno"; do
    [ -n "$fqbn" ] || continue
    core="$(printf '%s' "$fqbn" | cut -d: -f1-2)"
    [ -n "$core" ] || continue
    case " $seen " in *" $core "*) continue;; esac; seen="$seen $core"
    arduino-cli core list 2>/dev/null | grep -q "^$core[[:space:]]" && continue
    say "arduino-cli: 보드 코어 설치 $core"
    if arduino-cli core install "$core" >>/tmp/demosat-ard-deps.log 2>&1; then
      c_ok "코어 $core 준비됨"
    else
      c_warn "코어 $core 설치 실패 — /tmp/demosat-ard-deps.log"
    fi
  done
}

# 스케치 자동 업로드(arduino-cli). 안테나=antenna_gimbal, 솔라=solar_panel_uno(또는 PANEL_SPIN
# 시 solar_panel_spin). 실패해도 기존 펌웨어로 계속. NO_FLASH=1 로 생략, FQBN 으로 보드 변경.
flash_boards() {
  [ "${NO_FLASH:-0}" = "1" ] && { c_warn "NO_FLASH=1 → 스케치 업로드 생략(기존 펌웨어 사용)"; return 0; }
  have arduino-cli || { c_warn "arduino-cli 없음 → 스케치 업로드 생략(기존 펌웨어 사용). 설치: macOS brew install arduino-cli · Windows winget install ArduinoSA.CLI"; return 0; }
  local fqbn="${FQBN:-arduino:avr:uno}"
  local ant_fqbn="${FQBN:-${ANT_FQBN:-arduino:avr:uno}}"   # 정품 보드면 스캔에서 얻은 FQBN, 아니면 Uno(28BYJ-48+ULN2003 기본)
  local solar_sketch; solar_sketch="$([ -n "${PANEL_SPIN:-}" ] && echo solar_panel_spin || echo solar_panel_uno)"
  if [ -z "$ANT_DEV" ] && [ -z "$SOLAR_DEV" ]; then
    c_warn "업로드할 USB 시리얼 보드가 하나도 안 잡힘 — 케이블/전원 확인. 그래도 안 잡히면 ANT_PORT=/dev/cu.xxx (SOLAR_PORT=...) 지정 후 재실행."
    return 0
  fi
  if [ -n "$ANT_DEV" ]; then
    [ "${ANT_ASSUMED:-0}" = "1" ] && say "안테나 포트 자동 추정: $ANT_DEV (WHOAMI 무응답=첫 업로드로 판단)"
    say "안테나 스케치 업로드 → $ANT_DEV ($ant_fqbn)"
    if arduino-cli compile --upload -p "$ANT_DEV" --fqbn "$ant_fqbn" ../arduino/antenna_gimbal >/tmp/demosat-flash-ant.log 2>&1; then
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
# 준비 자세(READY_AZ/READY_EL, 기본 az 180°/el 50°)로 정렬한다. 브리지 기동 前에 직접 시리얼로 수행.
# NO_SELFTEST=1 로 생략. (브리지가 뜨면 피해 GS 지향각을 반영하므로 준비 자세는 시작 확인용이다.)
motor_selftest() {
  [ "${NO_SELFTEST:-0}" = "1" ] && return 0
  local p="$ANT_DEV"
  port_exists "$p" || { c_warn "안테나 보드 없음 → 모터 자가진단 생략"; return 0; }
  have node || { c_warn "node 없음 → 모터 자가진단 생략"; return 0; }
  # 준비자세 방위각은 보드 부팅 가정값(180°)과 '같게' 둔다 — 다르게 두면(예 0°) 셋업 때
  # 180°→0° 로 반바퀴 돌아 선이 꼬인다. az 는 180° 부근에서만 움직인다.
  local raz="${READY_AZ:-180}" rel="${READY_EL:-50}"   # 준비자세 az 180°(부팅값)·el 50°(합의값). 조준 시 el 10°로 틸트.
  say "안테나 모터 자가진단 — az·el 각각 왕복 후 준비 자세 ${raz}°/${rel}°"
  # 각 인자는 "대기ms:보낼줄" — serial.js 가 한 번 연 포트로 순서대로 흘려보낸다.
  # ⚠ 케이블 꼬임 방지 — AZ 는 보드 부팅 가정값(180°) 부근 ±30° 안에서만 살짝 왕복.
  #    (절대 0° 같은 먼 각을 주면 반바퀴 돌아 선이 꼬인다.) EL 은 절대 90° 초과 금지.
  if node "$SERIAL_JS" send "$p" 9600 \
       "2200:"                        `# 스케치 부팅 대기(포트 열림 = Uno 리셋)` \
       "400:TRACK"                    `# 스윕/스핀 해제 → 위치추종 모드` \
       "1600:AZ 210"                  `# ① az 모터 확인 (180→210°, +30°만)` \
       "1600:AZ 180"                  `# ② az 모터 원위치(부팅값)` \
       "2000:EL 80"                   `# ③ el 모터 확인 (→80°, 90° 미만)` \
       "2000:EL 20"                   `# ④ el 모터 반대로 (→20°)` \
       "3000:AZEL $raz $rel"          `# ⑤ 준비 자세로 정렬(az 180°·el 50°)` \
       2>/dev/null; then
    c_ok "모터 자가진단 완료 → 준비 자세 az=${raz}° el=${rel}° (ENGAGE 시 여기서 목표각으로 움직이는 게 보임)"
  else
    c_warn "자가진단: $p 열기/전송 실패 → 생략(브리지는 그대로 시도)"
  fi
}

# 준비 자세로만 '빠르게' 이동(왕복 자가진단 생략) — 재시작(다음 참가자) 전용.
# 최초 1회는 motor_selftest 로 az·el 왕복까지 확인하지만, 재시작마다 ~12초 왕복을 반복하면
# 리셋이 느리다. 여기선 포트 열림(=Uno 리셋) 대기 후 준비 자세 한 번만 보낸다(~4초).
motor_ready() {
  local p="$ANT_DEV"
  port_exists "$p" || { c_warn "안테나 보드 없음 → 준비자세 이동 생략"; return 0; }
  have node || { c_warn "node 없음 → 준비자세 이동 생략"; return 0; }
  local raz="${READY_AZ:-180}" rel="${READY_EL:-50}"
  say "안테나 준비 자세로 이동 ${raz}°/${rel}° (자가진단 생략 · 빠른 리셋)"
  if node "$SERIAL_JS" send "$p" 9600 \
       "2200:"                 `# 포트 열림=Uno 리셋 → 부팅 대기` \
       "400:TRACK"             `# 스윕/스핀 해제 → 위치추종` \
       "1500:AZEL $raz $rel"   `# 준비 자세 1회 정렬` \
       2>/dev/null; then
    c_ok "준비 자세 정렬 완료 az=${raz}° el=${rel}°"
  else
    c_warn "$p 열기/전송 실패 → 생략(브리지는 그대로 시도)"
  fi
}

# 연결신호 최종 확인 — 업로드가 끝난 뒤 두 보드가 실제로 WHOAMI 에 응답하는지 재프로브해 요약한다.
# detect_boards 는 부팅 시 '어느 포트가 무엇인지' 1회 분류만 한다. 여기서는 flash 후 펌웨어가
# 정상 응답하는지(=연결신호 확인) 최종 점검하고 ✓/! 로 사람이 한눈에 보게 출력한다.
# 시리얼을 잠깐 열었다 닫으므로 반드시 start_bridge(포트를 상시 점유) '전에' 호출한다.
verify_boards() {
  say "안테나·솔라 연결신호 확인(WHOAMI 재프로브)"
  local any=0
  if port_exists "$ANT_DEV"; then
    any=1
    if [ "$(probe_serial_role "$ANT_DEV")" = "antenna" ]; then
      c_ok "안테나 연결신호 확인 (WHOAMI=ANTENNA) → $ANT_DEV"
    else
      c_warn "안테나 WHOAMI 무응답 → $ANT_DEV — 펌웨어 업로드 실패? /tmp/demosat-flash-ant.log 확인(엉뚱한 펌웨어면 재플래시 필요)"
    fi
  fi
  if port_exists "$SOLAR_DEV"; then
    any=1
    if [ "$(probe_serial_role "$SOLAR_DEV")" = "solar" ]; then
      c_ok "솔라패널 연결신호 확인 (WHOAMI=SOLAR_PANEL) → $SOLAR_DEV"
    else
      c_warn "솔라패널 WHOAMI 무응답 → $SOLAR_DEV — /tmp/demosat-flash-solar.log 확인"
    fi
  fi
  [ "$any" = 1 ] || c_warn "확인할 보드가 없음 — USB 케이블/전원 확인(필요 시 ANT_PORT=/dev/cu.xxx SOLAR_PORT=/dev/cu.yyy 로 강제 지정)"
}

# Arduino 브리지 기동(best-effort). 피해 GS(:4542) 상태를 폴링해 물리 안테나(AZEL/SWEEP)와
# 솔라 패널 모터를 시리얼로 구동한다. detect_boards 가 찾은 포트를 사용. 보드가 없으면(부스 미연결)
# 경고만 남기고 건너뛴다 — 브리지는 모터 구동 전용이라 나머지 공격 화면과 무관하다.
start_bridge() {
  have node || { c_warn "node 없음 → Arduino 브리지 건너뜀(모터 미구동)"; return 0; }
  if [ -z "$ANT_DEV" ] && [ -z "$SOLAR_DEV" ]; then
    c_warn "시리얼 보드 없음/미식별 → Arduino 브리지 건너뜀(모터 미구동, 화면은 정상). 필요 시 ANT_PORT=/dev/cu.xxx 로 지정."
    return 0
  fi
  free_serial_bridge   # 진입 시 재확인: 어떤 좀비 브리지도 없이 '단 하나'의 브리지만 뜨게 보장
  # 데모는 항상 nominal 에서 시작해야 한다(transmit 전엔 솔라 정지, transmit 해야 회전).
  # 이전 실행의 tumbling/solarAttacked 가 GS 에 latch 돼 있으면 브리지가 켜지자마자 MODE 1 을
  # 보내 솔라가 상시 회전한다. 그래서 브리지 기동 직전에 피해 GS 를 nominal 로 되돌린다(best-effort).
  if have curl; then
    if curl -fsS -X POST "$GS_URL/api/reset" -o /dev/null 2>/dev/null; then
      say "피해 GS reset → nominal (transmit 전 솔라 정지 보장)"
    else
      c_warn "GS reset 실패($GS_URL/api/reset) — GS 미기동일 수 있음. 남은 공격상태면 솔라가 바로 돌 수 있으니 수동 reset 권장."
    fi
  fi
  ( cd ../arduino/bridge && GS_URL="$GS_URL" ANT_PORT="$ANT_DEV" SOLAR_PORT="$SOLAR_DEV" \
      ${PANEL_SPIN:+PANEL_SPIN="$PANEL_SPIN"} node bridge.js ) >/tmp/demosat-bridge.log 2>&1 &
  pids+=($!)
  c_ok "Arduino 브리지 실행 (ant=${ANT_DEV:-—} solar=${SOLAR_DEV:-—}) → 피해 GS(:4542) 폴링. 로그: /tmp/demosat-bridge.log"
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
  rm -f "$READY_FLAG" 2>/dev/null || true   # not-ready until the full setup (incl. Arduino) finishes
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
    free_serial_bridge   # 브리지(node) 확실히 종료 → 그 SIGTERM 핸들러가 보드에 MODE 0 전송(모터 정지)
    stop_motors          # 안전빵: 보드에 MODE 0 직접 전송(브리지가 못 보냈을 경우)
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
  #   :4532 rigctld · :4533 rotctld · :4534 WS(렌더러). (:4552 은 피해 GS 목적지라 바인딩 안 함)
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

  # ③ OpenVSA 백엔드(rotctld :4533 ← gpredict / rigctld :4532 / WS :4534 → 렌더러 시각화 / forward :4552).
  #   OpenVSA UI(렌더러)는 :8002 이 /vsa 로 서빙한다 — 별도 :8090 프록시·데스크탑 창 없음.
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
  #   피해 GS(:4542) /api/state 를 폴링해 물리 안테나(AZ/EL)·솔라 '모터'를 구동한다.
  #   보드가 USB로 연결돼 있어야 실제로 돈다. 없으면 경고만 하고 건너뜀(화면은 정상).
  if grep -q '"arduinoBridge"[[:space:]]*:[[:space:]]*true' "$SCENARIO_CONFIG" 2>/dev/null; then
    free_serial_bridge # 이전 실행의 좀비 브리지 정리(포트 해제) → 업로드/자가진단/새 브리지 충돌 방지
    # 최초 부팅(mode=all)에만 '무거운' 하드웨어 프로비저닝을 하고 감지한 보드 포트를 HW_CACHE 에
    # 적어둔다. 다음 참가자 리셋(mode=up)엔 캐시가 있으면 포트감지·코어/라이브러리 설치·스케치
    # 업로드·WHOAMI 확인·왕복 자가진단을 전부 건너뛰고, 안테나를 준비 각도로 옮기는 것만 한다.
    if [ "$MODE" = up ] && [ -f "$HW_CACHE" ]; then
      . "$HW_CACHE"    # 캐시된 ANT_DEV/SOLAR_DEV/ANT_FQBN 로드(감지 생략)
      c_ok "재시작 빠른 경로 — 포트감지·펌웨어 업로드·모터 자가진단 생략(캐시 $HW_CACHE) · ant=${ANT_DEV:-—} solar=${SOLAR_DEV:-—}"
      motor_ready      # 준비 각도로만 이동(왕복 자가진단 없이 빠르게)
    else
      ensure_arduino_cli # arduino-cli 자체가 없으면 자동 설치(없으면 스케치 미업로드 → 모터 미동작)
      detect_boards      # 시리얼 포트 1회 탐지(WHOAMI 역할 분류) → ANT_DEV/SOLAR_DEV
      ensure_arduino_deps # 코어(MKR SAMD·Uno AVR) + Stepper 라이브러리 자동 설치 → flash 첫 실행부터 성공
      flash_boards       # antenna_gimbal / solar 스케치 자동 업로드(arduino-cli)
      verify_boards      # WHOAMI 재프로브 → 안테나·솔라 '연결신호 확인' 요약(start_bridge 전에)
      motor_selftest     # az·el 모터 왕복 테스트 후 준비 자세 정렬(최초 1회)
      # 감지된 포트를 캐시에 저장 → 다음 참가자부턴 위 빠른 경로로 진입
      printf 'ANT_DEV=%q\nSOLAR_DEV=%q\nANT_FQBN=%q\n' "${ANT_DEV:-}" "${SOLAR_DEV:-}" "${ANT_FQBN:-}" > "$HW_CACHE" 2>/dev/null || true
    fi
    start_bridge       # 브리지 기동(이후 피해 GS 지향각·acquire 스윕 반영) — 매번
  fi

  # 단일 진입점 = :8002 하나. ① 명령 조립 → ② IQ 생성 → ③ 위성 조준 이 한 앱 안에서 전부.
  #   ③ 조준: 콘솔=:8002 /targeting · OpenVSA=:8002 /vsa · gpredict noVNC=Docker(:GP_PORT) 직접 iframe.
  local BUILDER_URL="http://localhost:$BUILDER_PORT/?gs=$GS_URL&gpport=$GP_PORT&ctrlport=$CTRL_PORT"

  # 빌더(:8002)가 응답할 때까지 대기(최대 ~10초)
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
    echo "   🔩 Arduino(보드 연결 시): 스케치 자동 업로드 → 모터 자가진단(왕복+준비자세) → 브리지가 피해 GS(:4542) 지향각/스윕 반영. 로그 /tmp/demosat-{flash-ant,flash-solar,bridge}.log"
  echo "───────────────────────────────────────────────"

  # Setup (builder + OpenVSA + Arduino self-test/ready) is done → mark attacker ready.
  # The finale's restart reload (console → /api/ready) waits for exactly this moment.
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
