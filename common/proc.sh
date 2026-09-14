#!/usr/bin/env bash
# proc.sh — 포트/프로세스 정리 헬퍼 (macOS · Linux · Windows Git Bash 공용).
#
# 왜 필요한가:
#   부스 스크립트는 "다음 실행이 이전 실행의 포트를 스스로 되찾는다"는 계약으로 돌아간다.
#   그런데 그 정리 코드가 전부 lsof / pkill / pgrep 기반이었고, Windows Git Bash(MSYS)에는
#   이 셋이 아예 없다. 그래서 `have lsof || return 0` 가드에 걸려 정리가 조용히 no-op 이 되고,
#   이전 실행의 node.exe 가 포트를 계속 물고 있어 다음 실행이 이렇게 죽었다:
#       Error: listen EADDRINUSE: address already in use 0.0.0.0:4553
#   더구나 Windows 에선 bash 서브셸을 kill 해도 그 아래 node.exe 는 살아남는다(신호 전파 없음).
#   → 포트 조회는 netstat, 종료는 taskkill /T(프로세스 트리)로 대체한다.
#
# 제공 함수:
#   port_pids <port>          해당 TCP 포트를 LISTEN 중인 PID 목록 (Windows 는 Windows PID)
#   pid_cmdline <pid>         PID 의 커맨드라인 문자열 (없으면 빈 문자열)
#   kill_tree <pid> [force]   PID + 자식까지 종료 (Windows: taskkill //T //F)
#   kill_by_pattern <regex>   커맨드라인 정규식으로 매칭되는 프로세스 종료 (pkill -f 대체)
#   pids_by_pattern <regex>   위와 같은 매칭의 PID 목록만 출력
#   win_pid <pid>             bash(MSYS) PID → Windows PID (그 외 OS 는 입력 그대로)
#   free_tcp_port <port> <설명>   포트 점유 프로세스를 TERM → (남으면) KILL 로 정리
#
# 사용: 각 스크립트 상단에서  . "<repo>/common/proc.sh"

IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

_p_have() { command -v "$1" >/dev/null 2>&1; }

# PowerShell 실행 파일 이름(Git Bash 는 System32 의 powershell.exe 가 PATH 에 있다).
_p_pwsh() {
  if   _p_have powershell.exe; then echo powershell.exe
  elif _p_have powershell;     then echo powershell
  elif _p_have pwsh;           then echo pwsh
  fi
}

# ── 포트 → PID ────────────────────────────────────────────────────────────────
# Windows: netstat -ano 의 TCP 행 중 로컬주소가 ':<port>' 로 끝나는 LISTEN 소켓의 PID(5번째 열).
#   · ':4553' 접미사 비교라 45530 같은 포트에 오탐되지 않는다. 0/4(System)은 제외.
#   · 상태 문자열이 로케일에 따라 다를 가능성에 대비해, 'LISTEN' 이거나 상대주소가 0:0
#     (= 연결 안 된 리스닝 소켓의 표식)이면 리스닝으로 본다.
# 그 외:   lsof.
port_pids() {
  local port="$1" ps_exe
  [ -n "$port" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    if _p_have netstat; then
      netstat -ano 2>/dev/null | tr -d '\r' \
        | awk -v suf=":$port" '
            $1 == "TCP" && NF >= 5 {
              la = $2; fa = $3; st = $4; pid = $5
              if (length(la) < length(suf)) next
              if (substr(la, length(la) - length(suf) + 1) != suf) next
              if (st ~ /LISTEN/ || fa == "0.0.0.0:0" || fa == "[::]:0")
                if (pid != "0" && pid != "4") print pid
            }' \
        | sort -u
      return 0
    fi
    ps_exe="$(_p_pwsh)"   # netstat 이 없는 드문 환경 폴백 (PowerShell 3+ / Win8+)
    [ -n "$ps_exe" ] || return 0
    "$ps_exe" -NoProfile -NonInteractive -Command \
      "Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object { \$_.OwningProcess }" \
      2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' | sort -u
  else
    _p_have lsof || return 0
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
  fi
  return 0
}

# ── PID → 커맨드라인 ──────────────────────────────────────────────────────────
pid_cmdline() {
  local pid="$1" ps_exe cmd
  [ -n "$pid" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    # wmic 은 최신 Windows 11 에서 제거될 수 있어 PowerShell 로 폴백한다.
    # ※ '//format:list' 의 슬래시 두 개는 오타가 아니다 — MSYS 는 '/format:list' 를 경로로 착각해
    #   'C:/Program Files/Git/format:list' 로 바꿔 넘긴다. '//x' 로 써야 wmic 에 '/x' 로 도착한다.
    if _p_have wmic; then
      cmd="$(wmic process where "ProcessId=$pid" get CommandLine //format:list 2>/dev/null \
        | tr -d '\r' | sed -n 's/^CommandLine=//p' | head -1)"
      [ -n "$cmd" ] && { printf '%s' "$cmd"; return 0; }
    fi
    ps_exe="$(_p_pwsh)"
    [ -n "$ps_exe" ] || return 0
    "$ps_exe" -NoProfile -NonInteractive -Command \
      "(Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\").CommandLine" 2>/dev/null \
      | tr -d '\r' | head -1
  else
    ps -p "$pid" -o command= 2>/dev/null | head -1
  fi
  return 0
}

# ── bash(MSYS) PID → Windows PID ─────────────────────────────────────────────
# MSYS 의 ps 는 'PID PPID PGID WINPID …' 컬럼을 낸다. taskkill 은 WINPID 를 요구한다.
win_pid() {
  local pid="$1" w=""
  [ -n "$pid" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    w="$(ps -W 2>/dev/null | tr -d '\r' | awk -v p="$pid" '$1==p {print $4; exit}')"
    [ -z "$w" ] && w="$(ps 2>/dev/null | tr -d '\r' | awk -v p="$pid" '$1==p {print $4; exit}')"
  fi
  printf '%s' "${w:-$pid}"
  return 0
}

# ── 프로세스(+자식) 종료 ──────────────────────────────────────────────────────
# Windows 는 //T 로 자식까지 함께 내린다 — bash 서브셸만 죽이면 그 아래 node.exe 가 남아
# 포트를 계속 물기 때문. (인자의 '//' 는 MSYS 가 '/' 로 변환해 taskkill 에 전달한다.)
#
# kill_tree       … 네이티브 PID 용. Windows 에선 'Windows PID'(netstat/tasklist 가 주는 값).
# kill_shell_tree … bash 가 준 PID($! 등) 용. Windows 에선 WINPID 로 변환한 뒤 트리 종료.
# 둘을 나눈 이유: MSYS 의 bash PID 와 Windows PID 는 서로 다른 번호 공간이라, 한쪽을
# 다른 쪽으로 착각해 taskkill 하면 엉뚱한 프로세스를 죽일 수 있다.
kill_tree() {
  local pid="$1" force="${2:-0}"
  [ -n "$pid" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
  elif [ "$force" = 1 ]; then
    kill -9 "$pid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
  fi
  return 0
}

kill_shell_tree() {
  local pid="$1" force="${2:-0}"
  [ -n "$pid" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    kill_tree "$(win_pid "$pid")"
  else
    kill_tree "$pid" "$force"
  fi
  return 0
}

# ── 커맨드라인 패턴 매칭 ──────────────────────────────────────────────────────
pids_by_pattern() {
  local pat="$1" ps_exe
  [ -n "$pat" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    ps_exe="$(_p_pwsh)"
    [ -n "$ps_exe" ] || return 0
    "$ps_exe" -NoProfile -NonInteractive -Command \
      "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match '$pat' } | ForEach-Object { \$_.ProcessId }" \
      2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
  else
    _p_have pgrep || return 0
    pgrep -f "$pat" 2>/dev/null || true
  fi
  return 0
}

kill_by_pattern() {
  local pat="$1" pid
  [ -n "$pat" ] || return 0
  if [ "$IS_WINDOWS" = 1 ]; then
    for pid in $(pids_by_pattern "$pat"); do
      taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true   # 여긴 이미 Windows PID
    done
  else
    _p_have pkill && { pkill -f "$pat" 2>/dev/null || true; }
  fi
  return 0
}

# ── 크로스 런타임 플래그 파일 경로 ────────────────────────────────────────────
# READY_FLAG/RESTART_FLAG 는 bash(MSYS)가 쓰고 node.exe·python.exe(네이티브 Win32)가 읽거나
# 그 반대로 동작한다(예: server.js 가 쓰고 run-booth.sh 가 읽음, start-attacker.sh 가 쓰고
# app.py 가 읽음). POSIX 식 '/tmp/...' 는 MSYS 안에서만 유효한 매핑이고, 네이티브 바이너리는
# 이를 '현재 드라이브 루트의 \tmp\...' 로 다르게 해석해 전혀 다른 파일을 보게 된다 → 신호가
# 영원히 전달되지 않는다(리셋 안 됨·"준비완료" 대기가 안 풀림). 두 세계 모두 이해하는
# 드라이브 문자 경로(C:/...)로 통일한다.
flag_path() {
  local name="$1" base
  if [ "$IS_WINDOWS" = 1 ]; then
    base="${TEMP:-${TMP:-/tmp}}"
    _p_have cygpath && base="$(cygpath -m "$base" 2>/dev/null || echo "$base")"
    printf '%s/%s' "$base" "$name"
  else
    printf '/tmp/%s' "$name"
  fi
}

# ── 포트 회수 ─────────────────────────────────────────────────────────────────
# 데모 전용 포트라 점유자를 정리해도 안전하다. TERM → 1초 → 남아 있으면 KILL.
# 반환: 항상 0 (set -e 아래에서도 안전).
free_tcp_port() {
  local port="$1" name="${2:-}" pids pid
  pids="$(port_pids "$port")"
  [ -z "$pids" ] && return 0
  printf "\033[33m  ! :%s 사용 중(%s) → 이전 인스턴스 정리: %s\033[0m\n" \
    "$port" "$name" "$(echo $pids | tr '\n' ' ')"
  for pid in $pids; do kill_tree "$pid"; done
  sleep 1
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    for pid in $pids; do kill_tree "$pid" 1; done
    sleep 1
  fi
  return 0
}
