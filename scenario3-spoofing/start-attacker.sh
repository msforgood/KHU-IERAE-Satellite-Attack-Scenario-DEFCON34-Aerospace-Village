#!/usr/bin/env bash
# start-attacker.sh — attacker 쪽 원샷 부트스트랩: 최초 설치 → 설치 확인 → 화면 실행.
# 시나리오 폴더에 두지만 phase 1-3 자원은 전부 공용 ../common/attacker 아래에 있어
# 스스로 그리로 진입한다. 시나리오별 차이는 이 폴더의 scenario.json + extras/ 로만 표현.
#
# 단일 포트(:8000) 하나로 ①②③ 전부. 별도 창/프록시 포트 없음.
#   http://localhost:8000  Command Builder (Python)
#     ├ 페이즈① 명령 조립  ·  페이즈② IQ 생성
#     └ 페이즈③ 위성 조준:  /targeting(콘솔) + /vsa(OpenVSA 렌더러) + gpredict(:6080) 직접 iframe
#
# ※ OpenVSA는 Electron 앱이지만 렌더러는 정적 웹(+WS :4534)이라 :8000이 /vsa 로 서빙한다.
#   gpredict noVNC는 Docker :6080 을 그대로 iframe(프록시 불필요). TRANSMIT은 피해 GS API(/api/inject).
#
# 사용법 (시나리오 폴더에서):
#   ./start-attacker.sh            # 설치 + 확인 + 실행 (전체)
#   ./start-attacker.sh install    # 설치만 (최초 1회)
#   ./start-attacker.sh check      # 설치 확인만
#   ./start-attacker.sh up         # 화면 실행만 (설치가 끝난 뒤)
#
# 환경변수(선택):
#   GS_URL       피해 지상국 base (ACQUIRE/RESET·forward 대상). 기본 http://localhost:4540
#   BUILDER_PORT ① Command Builder 포트. 기본 8000
#   CONSOLE_PORT ③ 조준 콘솔 단일 포트(console+vsa+gpredict). 기본 8090
#   GP_PORT      gpredict noVNC Docker 포트(프록시 대상). 기본 6080
#   GP_IMG       gpredict Docker 이미지명. 기본 demosat-gpredict
#   UPLINK_OUT_DIR  attack.cf32 출력 폴더. 기본 ~/uplink
#   NO_OPEN      1이면 브라우저 자동 열기 끄기 (기본: 실행 후 ①③ 화면 자동 오픈)
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
GS_URL="${GS_URL:-http://localhost:4540}"
BUILDER_PORT="${BUILDER_PORT:-8000}"
CONSOLE_PORT="${CONSOLE_PORT:-8090}"   # 단일 포트: console(/) + OpenVSA(/vsa) + gpredict(/gpredict)
GP_PORT="${GP_PORT:-6080}"
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
  if have docker; then
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

  # ① Command Builder (:BUILDER_PORT) — 시나리오 config/extras 를 함께 전달(④+ 페이즈)
  mkdir -p "$UPLINK_OUT_DIR"
  ( cd "$BUILDER_DIR" && UPLINK_OUT_DIR="$UPLINK_OUT_DIR" PORT="$BUILDER_PORT" \
      EXTRA_DIR="$EXTRA_DIR_ARG" SCENARIO_CONFIG="$SCENARIO_CONFIG" "$PY_ABS" app.py ) \
    >/tmp/demosat-builder.log 2>&1 &
  pids+=($!)

  # ③ gpredict web (:GP_PORT) — Docker, 선택
  local GP=""
  if have docker; then
    ( cd gpredict-web && WEB_PORT="$GP_PORT" IMG="$GP_IMG" ./run.sh ) >/tmp/demosat-gpredict.log 2>&1 &
    pids+=($!)
    GP="http://localhost:$GP_PORT/vnc.html?autoconnect=1&resize=remote"
  fi

  # ③ OpenVSA 백엔드(rotctld :4533 ← gpredict / rigctld :4532 / WS :4534 → 렌더러 시각화 / forward :4536).
  #   OpenVSA UI(렌더러)는 :8000 이 /vsa 로 서빙한다 — 별도 :8090 프록시·데스크탑 창 없음.
  ( cd openvsa && UPLINK_DEST="$UPLINK_DEST" node server.js ) >/tmp/demosat-openvsa.log 2>&1 &
  pids+=($!)

  # 단일 진입점 = :8000 하나. ① 명령 조립 → ② IQ 생성 → ③ 위성 조준 이 한 앱 안에서 전부.
  #   ③ 조준: 콘솔=:8000 /targeting · OpenVSA=:8000 /vsa · gpredict noVNC=Docker(:GP_PORT) 직접 iframe.
  local BUILDER_URL="http://localhost:$BUILDER_PORT/?gs=$GS_URL&gpport=$GP_PORT"

  # 빌더(:8000)가 응답할 때까지 대기(최대 ~10초)
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
  all)     install; check; up ;;
  *) die "알 수 없는 모드 '$MODE' (사용: install | check | up | all)";;
esac
