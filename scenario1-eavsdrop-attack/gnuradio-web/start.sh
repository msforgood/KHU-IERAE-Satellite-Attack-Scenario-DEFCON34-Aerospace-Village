#!/bin/sh
# In-container: run GNU Radio Companion with a RUNNABLE copy of the answer
# flowgraph open, streamed over noVNC. The user can hit ▶ Run to actually decode.
#
# The shipped .grc is authored for a 50 kSps capture, but the provided recording
# (enigma34_downlink.cf32) is 96 kSps (= the ENIGMA-1 SDR spec, 9600 baud x 10 sps),
# so we patch samp_rate 0.05e6 -> 0.096e6 in the opened copy. The File Source path
# and the image out_path are satisfied by bind-mounts (see run.sh), so Run writes the
# recovered PNG to the host ./gnuradio-out/ directory.
set -e
export HOME=/root DISPLAY=:99
SRC="${GRC_FILE:-/grc/enigma1_decoder.grc}"
RUN_GRC=/root/enigma1_decoder.grc
# Runnable copy: (1) samp_rate 0.05e6 -> $SAMP_RATE to match the mounted File Source
#     (run.sh passes 96000 for the built-in 96 kSps recording, or e.g. 50000 for a
#      PHASE-4-uploaded VSA capture), (2) enable the QT GUI Waterfall Sink (shipped
#     disabled) so ▶ Run shows a live spectrum window while it decodes.
SR="${SAMP_RATE:-96000}"
sed "s/value: 0.05e6/value: ${SR}/; s/state: disabled/state: enabled/" "$SRC" > "$RUN_GRC" 2>/dev/null || cp "$SRC" "$RUN_GRC"

# File Source(마운트된 녹음)·solution(출력) 컨테이너 경로 — run.sh 의 -v 마운트 타깃과 동일.
SIG="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/signal/ENIGMA-1_433_506MHz_2026-07-08T02-25-04.cf32"
SOL="/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution"
mkdir -p "$SOL"

# B2 기울기 구동값: 녹음의 중심주파수 오프셋(normalized, 진폭가중 평균 순간주파수)을 측정.
# 재조립 블록이 solution/offset.txt 를 읽어 사선 정도를 정한다 — 입력 파일마다 달라짐(중심 맞으면 ~0).
cat > /tmp/measure_offset.py <<'PYOFF'
import sys, numpy as np
raw = np.fromfile(sys.argv[1], dtype=np.float32, count=12000000)
n = (raw.size // 2) * 2
iq = raw[:n].view(np.complex64)
d = iq[1:] * np.conj(iq[:-1])
w = np.abs(iq[1:]) ** 2
print("%.6f" % float(np.sum(w * np.angle(d)) / (np.sum(w) + 1e-12) / (2 * np.pi)))
PYOFF

# GRC's default xterm (x-terminal-emulator) is absent → warning on start / can
# break Run. Point it at the installed xterm.
mkdir -p /root/.gnuradio
printf '[grc]\nxterm_executable = /usr/bin/xterm\n' > /root/.gnuradio/config.conf

# 창 배치는 아래 wmctrl 로 직접 한다(GRC 플로우 창=전체화면 / 워터폴 실행 창=적당한 크기).
# openbox 자동 최대화는 켜지 않는다.
mkdir -p /root/.config/openbox
cp -f /etc/xdg/openbox/rc.xml /root/.config/openbox/rc.xml 2>/dev/null || true

Xvfb :99 -screen 0 "${GEOM:-1600x1000x24}" >/dev/null 2>&1 &
sleep 1
openbox >/dev/null 2>&1 &

# 'gnu radio 플로우 창' = GRC 편집기(플로우그래프). 이것을 전체화면으로 띄운다.
dbus-run-session -- gnuradio-companion "$RUN_GRC" >/dev/null 2>&1 &

# 창 배치 루프: GRC(플로우) 전체화면 / 워터폴(실행) 창은 적당한 크기(전체화면 아님).
# 워치독으로 flow 가 재시작되면 워터폴 창이 새로 뜨므로 주기적으로 재적용한다.
( set +e   # wmctrl 실패(창이 잠깐 없음 등)로 배치 루프가 죽지 않게 한다
  while true; do
    sleep 2
    wmctrl -r "enigma1_decoder.grc" -b add,maximized_vert,maximized_horz 2>/dev/null   # GRC 플로우 창=전체화면
    wmctrl -r "ENIGMA-1 Decoder" -b remove,maximized_vert,maximized_horz 2>/dev/null    # 워터폴=전체화면 해제
    wmctrl -r "ENIGMA-1 Decoder" -e 0,340,220,920,560 2>/dev/null                       # 워터폴=적당한 크기(중앙)
  done ) &

# PHASE 5 진입 즉시 복조가 돌도록 flow 를 자동 실행(수동 ▶Run 불필요).
# 오프셋 측정 → offset.txt, grcc 로 .py 생성 후 헤드리스 실행 → QT GUI 워터폴(최대화=전체화면)이 뜨고
# 재조립 이미지가 solution/ 에 실시간 기록된다. File Source repeat=True 라 계속 순환하며 반복 복조
# → 웹이 이어서 실시간으로 갱신 표시. (백그라운드로 두어 noVNC 기동을 막지 않음)
(
  set +e   # 서브셸 내 개별 명령 실패(워치독 조건식 등)로 supervisor 가 죽지 않게 한다
  rm -f "$SOL/persist.raw"   # 컨테이너 새 기동(=새 파일)마다 지속 이미지 초기화. 워치독 재시작은 내부라 유지됨
  python3 /tmp/measure_offset.py "$SIG" > "$SOL/offset.txt" 2>/dev/null || echo 0 > "$SOL/offset.txt"
  grcc -o /root "$RUN_GRC" >/tmp/grcc.log 2>&1 || true
  # 중심주파수 보정은 하지 않는다(freq_offset 그대로 0). 어긋난 입력은 복조가 그대로 실패/부분복원되어
  # '안 만들어지면 안 만들어지는 대로' 정직하게 표시된다. (offset.txt 는 재조립의 사선(B2) 시각화용으로만 사용)
  # 정지 감지 워치독: 진행도 파일 mtime 이 ~12초 동안 안 바뀌면(DSP 멈춤인데 QT 프로세스만 생존) flow 를
  # 죽여 재시작한다. 잘 돌 땐 안 끊고, 멈추면 빠르게 자가치유 → 실시간 복조가 영구 정지하지 않는다.
  # (timeout 150s 는 만일의 하드 백스톱)
  while true; do
    if [ -f /root/enigma1_decoder.py ]; then
      timeout -k 5 150 python3 /root/enigma1_decoder.py >/tmp/flow.log 2>&1 &
      FPID=$!
      LAST=""; STALL=0
      while kill -0 "$FPID" 2>/dev/null; do
        sleep 4
        MT=$(stat -c %Y "$SOL"/*_progress.txt 2>/dev/null | sort -n | tail -1)
        if [ -n "$MT" ] && [ "$MT" = "$LAST" ]; then STALL=$((STALL+1)); else STALL=0; fi
        LAST="$MT"
        if [ "$STALL" -ge 15 ]; then pkill -9 -f enigma1_decoder.py 2>/dev/null; break; fi   # ~60s 정지 시에만 재시작(창 흔들림 최소화; persist 로 이미지는 유지됨)
      done
    fi
    sleep 2
  done
) &
x11vnc -display :99 -forever -shared -nopw -rfbport "${VNC_PORT:-5900}" -quiet >/dev/null 2>&1 &
exec websockify --web=/usr/share/novnc "${WEB_PORT:-6081}" localhost:"${VNC_PORT:-5900}"
