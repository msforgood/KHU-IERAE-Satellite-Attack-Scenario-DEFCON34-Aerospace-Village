#!/usr/bin/env bash
# start-attacker.sh — attacker 쪽 원샷 부트스트랩: 최초 설치 → 설치 확인 → 화면 실행.
# scn2 루트에 두지만, 실제 자원은 전부 attacker/ 아래에 있어 스스로 그리로 진입한다.
#
#   ① Command Builder   attacker/packet-generator/webapp (Python) → http://localhost:8000
#   ③ 위성 조준 콘솔      attacker/console + OpenVSA(+gpredict web)  → http://localhost:8090
#   (③에 임베드) gpredict  Docker + noVNC                          → http://localhost:6080
#
# 사용법 (scn2 루트에서):
#   ./start-attacker.sh            # 설치 + 확인 + 실행 (전체)
#   ./start-attacker.sh install    # 설치만 (최초 1회)
#   ./start-attacker.sh check      # 설치 확인만
#   ./start-attacker.sh up         # 화면 실행만 (설치가 끝난 뒤)
#
# 환경변수(선택):
#   GS_URL       피해 지상국 base (ACQUIRE/RESET·forward 대상). 기본 http://localhost:4540
#   BUILDER_PORT ① Command Builder 포트. 기본 8000
#   GP_PORT      gpredict noVNC 포트. 기본 6080
#   GP_IMG       gpredict Docker 이미지명. 기본 demosat-gpredict
#   UPLINK_OUT_DIR  attack.cf32 출력 폴더. 기본 ~/uplink
#
# ⚠️ 이 스크립트는 '공격자 쪽'만 띄웁니다. 피해 지상국(⑤)은 별도로 실행하세요:
#     cd victim/backend && node server.js

set -uo pipefail
# 스크립트는 scn2 루트에 있지만 모든 자원은 attacker/ 아래 → 그리로 진입해
# 이하 상대경로(packet-generator·openvsa·gpredict-web·launch.sh)를 그대로 쓴다.
cd "$(dirname "$0")/attacker"

MODE="${1:-all}"
GS_URL="${GS_URL:-http://localhost:4540}"
BUILDER_PORT="${BUILDER_PORT:-8000}"
GP_PORT="${GP_PORT:-6080}"
GP_IMG="${GP_IMG:-demosat-gpredict}"
UPLINK_OUT_DIR="${UPLINK_OUT_DIR:-$HOME/uplink}"

BUILDER_DIR="packet-generator/webapp"
VENV="$BUILDER_DIR/.venv"

# ── helpers ──────────────────────────────────────────────────────────────────
c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
c_warn() { printf '  \033[33m![warn]\033[0m %s\n' "$*"; }
c_err()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()    { c_err "$*"; exit 1; }
have()   { command -v "$1" >/dev/null 2>&1; }

# numpy 를 가진 python 인터프리터 경로를 고른다 (venv 우선).
pick_python() {
  if [ -x "$VENV/bin/python" ]; then echo "$VENV/bin/python"; else echo "python3"; fi
}

# ── 최초 설치 ────────────────────────────────────────────────────────────────
install() {
  echo "════════ [1] 최초 설치 ════════"
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
  echo "════════ [2] 설치 확인 ════════"
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
  echo "════════ [3] attacker 화면 실행 ════════"
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

  # ① Command Builder (:BUILDER_PORT)
  mkdir -p "$UPLINK_OUT_DIR"
  ( cd "$BUILDER_DIR" && UPLINK_OUT_DIR="$UPLINK_OUT_DIR" PORT="$BUILDER_PORT" "$PY_ABS" app.py ) \
    >/tmp/demosat-builder.log 2>&1 &
  pids+=($!)

  # ③ gpredict web (:GP_PORT) — Docker, 선택
  local GP=""
  if have docker; then
    ( cd gpredict-web && WEB_PORT="$GP_PORT" IMG="$GP_IMG" ./run.sh ) >/tmp/demosat-gpredict.log 2>&1 &
    pids+=($!)
    GP="http://localhost:$GP_PORT/vnc.html?autoconnect=1&resize=remote"
  fi

  sleep 2
  echo "───────────────────────────────────────────────"
  c_ok "① Command Builder → http://localhost:$BUILDER_PORT   (로그: /tmp/demosat-builder.log)"
  [ -n "$GP" ] && c_ok "   gpredict(web)   → $GP   (로그: /tmp/demosat-gpredict.log, 최초 기동 수십초)"
  echo "   ③ 위성 조준 콘솔은 아래 OpenVSA 기동 후 URL이 출력됩니다."
  echo "   ⑤ 피해 지상국은 별도 실행 필요:  (다른 터미널) cd victim/backend && node server.js"
  echo "───────────────────────────────────────────────"

  # ③ OpenVSA + 콘솔 (포그라운드, Ctrl-C 로 전체 종료). 기존 launch.sh 재사용.
  GS_URL="$GS_URL" GPREDICT_WEB_URL="$GP" ./launch.sh
}

case "$MODE" in
  install) install ;;
  check)   check ;;
  up)      up ;;
  all)     install; check; up ;;
  *) die "알 수 없는 모드 '$MODE' (사용: install | check | up | all)";;
esac
