#!/usr/bin/env bash
# start-attacker.sh — attacker 쪽 원샷 부트스트랩: 최초 설치 → 설치 확인 → 화면 실행.
# 시나리오 폴더에 두지만 phase 1-3 자원은 전부 공용 ../common/attacker 아래에 있어
# 스스로 그리로 진입한다. 시나리오별 차이는 이 폴더의 scenario.json + extras/ 로만 표현.
#
# 단일 포트(:8003) 하나로 ①②③ 전부. 별도 창/프록시 포트 없음.
#   http://localhost:8003  Command Builder (Python)
#     ├ 페이즈① 명령 조립  ·  페이즈② IQ 생성
#     └ 페이즈③ 위성 조준:  /targeting(콘솔) + /vsa(OpenVSA 렌더러) + gpredict(:6080) 직접 iframe
#
# ※ OpenVSA는 Electron 앱이지만 렌더러는 정적 웹(+WS :4534)이라 :8003이 /vsa 로 서빙한다.
#   gpredict noVNC는 Docker :6080 을 그대로 iframe(프록시 불필요). TRANSMIT은 피해 GS API(/api/inject).
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
#   GP_PORT      gpredict noVNC Docker 포트(프록시 대상). 기본 6080
#   GP_IMG       gpredict Docker 이미지명. 기본 demosat-gpredict
#   UPLINK_OUT_DIR  attack.cf32 출력 폴더. 기본 ~/uplink
#   NO_OPEN      1이면 브라우저 자동 열기 끄기 (기본: 실행 후 ①③ 화면 자동 오픈)
#   ANT_PORT     안테나 아두이노 시리얼 포트 강제 지정(미지정 시 WHOAMI 자동탐지). 예 /dev/cu.usbmodem1101
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
cd "$SCN_DIR/../common/attacker"

MODE="${1:-all}"
GS_URL="${GS_URL:-http://localhost:4543}"
BUILDER_PORT="${BUILDER_PORT:-8003}"
CONSOLE_PORT="${CONSOLE_PORT:-8090}"   # 단일 포트: console(/) + OpenVSA(/vsa) + gpredict(/gpredict)
GP_PORT="${GP_PORT:-6080}"
CTRL_PORT="${CTRL_PORT:-6079}"   # gpredict 시간제어 서버(phase3 → /arm). noVNC(GP_PORT)와 한 쌍.
GP_IMG="${GP_IMG:-demosat-gpredict}"
UPLINK_DEST="${UPLINK_DEST:-ws://localhost:4536}"
UPLINK_OUT_DIR="${UPLINK_OUT_DIR:-$HOME/uplink}"
# 시나리오 델타: 이 폴더의 scenario.json(페이즈 구성) + extras/(④+ 전용 화면)를 Command
# Builder에 전달. extras/ 가 없으면(scn2) EXTRA_DIR 미설정 → 순수 3-phase 공격.
SCENARIO_CONFIG="${SCENARIO_CONFIG:-$SCN_DIR/scenario.json}"
EXTRA_DIR_ARG=""; [ -d "$SCN_DIR/extras" ] && EXTRA_DIR_ARG="$SCN_DIR/extras"

BUILDER_DIR="packet-generator/webapp"
VENV="$BUILDER_DIR/.venv"

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
    *)      command -v powershell >/dev/null 2>&1 && powershell.exe start "$1" || true ;;
  esac
}

# numpy 를 가진 python 인터프리터 경로를 고른다 (venv 우선).
pick_python() {
  if [ -x "$VENV/bin/python" ]; then echo "$VENV/bin/python"; else echo "python3"; fi
}

# 지정 포트를 잡고 있는 '이전 실행의 좀비 서버'를 정리한다 (데모 전용 포트라 안전).
# 이걸 안 하면 새 서버가 bind 실패(Address already in use)하고, 죽은 옛 서버가 화면을
# 계속 서빙해서 디버깅이 꼬인다(예: /api/mission 이 옛 경로 때문에 500).
free_port() {
  local port="$1" name="$2" pids
  have lsof || return 0
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -z "$pids" ] && return 0
  c_warn ":$port 사용 중(${name}) → 이전 인스턴스 정리: $(echo "$pids" | tr '\n' ' ')"
  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -n "$pids" ] && { echo "$pids" | xargs kill -9 2>/dev/null || true; sleep 1; }
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

# 한 시리얼 포트를 열어 WHOAMI 를 보내고 펌웨어가 응답하는 역할(antenna/solar)을 echo 한다.
# motor.sh 와 동일한 방식(펌웨어에 심은 ID 로 보드 식별). 응답 없으면 빈 문자열.
probe_serial_role() {
  local p="$1" line role=""
  [ -e "$p" ] || return 0
  stty -f "$p" 9600 raw -echo -hupcl clocal 2>/dev/null || return 0
  exec 3<>"$p" 2>/dev/null || return 0
  sleep 2.2                                   # Uno 부트로더/USB 리셋 대기
  printf 'WHOAMI\n' >&3
  while IFS= read -r -t 2 line <&3; do
    line="${line%$'\r'}"
    case "$line" in
      *"id=ANTENNA"*|*"ID=ANTENNA"*)          role="antenna"; break;;
      *"ID=SOLAR_PANEL"*|*"SOLAR PANEL"*)      role="solar";   break;;
    esac
  done
  exec 3>&- 2>/dev/null
  printf '%s' "$role"
}

# 연결된 시리얼 보드를 1회 탐지해 역할별 포트를 전역에 저장한다(flash·selftest·bridge 공유).
# ANT_PORT/SOLAR_PORT 로 강제 지정 가능. 미지정 포트는 WHOAMI 로 antenna/solar 분류.
ANT_DEV=""; SOLAR_DEV=""
detect_boards() {
  ANT_DEV="${ANT_PORT:-}"; SOLAR_DEV="${SOLAR_PORT:-}"
  { [ -n "$ANT_DEV" ] && [ -n "$SOLAR_DEV" ]; } && return 0   # 둘 다 지정 → 탐색 불필요
  local p role
  for p in /dev/cu.usbmodem* /dev/cu.usbserial-*; do
    [ -e "$p" ] || continue
    { [ "$p" = "$ANT_DEV" ] || [ "$p" = "$SOLAR_DEV" ]; } && continue
    role="$(probe_serial_role "$p")"
    [ -z "$ANT_DEV" ]   && [ "$role" = "antenna" ] && ANT_DEV="$p"
    [ -z "$SOLAR_DEV" ] && [ "$role" = "solar" ]   && SOLAR_DEV="$p"
  done
}

# 스케치 자동 업로드(arduino-cli). 안테나=antenna_gimbal, 솔라=solar_panel_uno(또는 PANEL_SPIN
# 시 solar_panel_spin). 실패해도 기존 펌웨어로 계속. NO_FLASH=1 로 생략, FQBN 으로 보드 변경.
flash_boards() {
  [ "${NO_FLASH:-0}" = "1" ] && { c_warn "NO_FLASH=1 → 스케치 업로드 생략(기존 펌웨어 사용)"; return 0; }
  have arduino-cli || { c_warn "arduino-cli 없음 → 스케치 업로드 생략(기존 펌웨어 사용). 설치: brew install arduino-cli"; return 0; }
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
  [ -n "$p" ] && [ -e "$p" ] || { c_warn "안테나 보드 없음 → 모터 자가진단 생략"; return 0; }
  local raz="${READY_AZ:-0}" rel="${READY_EL:-0}"
  stty -f "$p" 9600 raw -echo -hupcl clocal 2>/dev/null || { c_warn "자가진단: $p stty 실패 → 생략"; return 0; }
  exec 3<>"$p" 2>/dev/null || { c_warn "자가진단: $p 열기 실패 → 생략"; return 0; }
  sleep 2.2                                   # 스케치 부팅 대기(포트 열림 = Uno 리셋)
  say "안테나 모터 자가진단 — az·el 각각 왕복 후 준비 자세 ${raz}°/${rel}°"
  printf 'TRACK\n'          >&3; sleep 0.4    # 스윕/스핀 해제 → 위치추종 모드
  printf 'AZ 300\n'         >&3; sleep 2.5    # ① az 모터 이동
  printf 'AZ 60\n'          >&3; sleep 2.5    # ② az 모터 반대로
  printf 'EL 80\n'          >&3; sleep 2.5    # ③ el 모터 이동
  printf 'EL 10\n'          >&3; sleep 2.5    # ④ el 모터 반대로
  printf 'AZEL %d %d\n' "$raz" "$rel" >&3; sleep 3.0   # ⑤ 준비 자세로 정렬(두 모터 동시)
  exec 3>&- 2>/dev/null
  c_ok "모터 자가진단 완료 → 준비 자세 az=${raz}° el=${rel}° (ENGAGE 시 여기서 목표각으로 움직이는 게 보임)"
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
  have python3|| die "python3 가 없습니다"

  # ① Command Builder — Python venv + numpy (전역 오염 방지)
  echo "[1/3] Command Builder Python 의존성 (numpy) → $VENV"
  if [ ! -d "$VENV" ]; then
    python3 -m venv "$VENV" || die "venv 생성 실패 (Debian이면 'sudo apt install python3-venv')"
  fi
  "$VENV/bin/python" -m pip install --quiet --upgrade pip \
    && "$VENV/bin/python" -m pip install --quiet numpy \
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
  local py; py="$(pick_python)"
  "$py" -c "import numpy" 2>/dev/null || die "numpy 없음 → './start-attacker.sh install' 먼저"
  # 서브셸에서 cd 후에도 안전하도록 파이썬을 절대경로로 고정
  local PY_ABS
  if [ -x "$VENV/bin/python" ]; then PY_ABS="$(cd "$VENV/bin" && pwd)/python"; else PY_ABS="$(command -v python3)"; fi

  local pids=()
  cleanup() {
    echo; echo "[cleanup] 종료 중…"
    [ "${#pids[@]}" -gt 0 ] && kill "${pids[@]}" 2>/dev/null || true
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
  #   :4532 rigctld · :4533 rotctld · :4534 WS(렌더러). (:4536 은 피해 GS 목적지라 바인딩 안 함)
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

  # ③ OpenVSA 백엔드(rotctld :4533 ← gpredict / rigctld :4532 / WS :4534 → 렌더러 시각화 / forward :4536).
  #   OpenVSA UI(렌더러)는 :8003 이 /vsa 로 서빙한다 — 별도 :8090 프록시·데스크탑 창 없음.
  ( cd openvsa && UPLINK_DEST="$UPLINK_DEST" node server.js ) >/tmp/demosat-openvsa.log 2>&1 &
  pids+=($!)
  # WS :4534 가 실제로 떴는지 확인 — 안 뜨면 STEP 2 'VIRTUAL ANTENNA UPLINK' 가 백지로 남으므로
  # 조용히 넘어가지 않고 원인을 명시한다(대개 포트 잔존·bind 실패).
  local VSA_OK=0
  for _ in $(seq 1 25); do
    lsof -tiTCP:4534 -sTCP:LISTEN >/dev/null 2>&1 && { VSA_OK=1; break; }
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
  local BUILDER_URL="http://localhost:$BUILDER_PORT/?gs=$GS_URL&gpport=$GP_PORT"

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
