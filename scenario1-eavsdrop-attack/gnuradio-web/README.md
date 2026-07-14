# GNU Radio (web) — 실물 GNU Radio Companion을 브라우저로 (Scenario 1)

`gpredict-web/` 과 **동일한 방식**. 재구현이 아니라 **진짜 GNU Radio Companion(GRC)을 Docker
안에서 돌려 noVNC 로 브라우저에 스트리밍**하고, 정답 flowgraph `enigma1_decoder.grc` 를 열어둔다.
web-guide 의 FLOWGRAPH(PHASE 5) 단계가 이 noVNC URL 을 `GNURADIO_URL` 로 받아 iframe 으로 띄운다.

```
Docker 컨테이너
  Xvfb :99  ─ 가상 X 디스플레이
  openbox   ─ 창 관리자
  gnuradio-companion enigma1_decoder.grc  ─ 실제 GRC (정답 flowgraph 열림)
    └ gr-satellites: FSK Demodulator / AX.25 Deframer 블록 제공
  x11vnc    ─ :99 화면을 VNC :5900 로 export
  websockify(noVNC) ─ VNC 를 웹 :6081 으로 → 브라우저에서 보임
        │
        └─ web-guide FLOWGRAPH iframe ◀ http://localhost:6081/vnc.html?autoconnect=1&resize=remote
```

## 실행

```bash
# 1) GNU Radio 를 Docker+noVNC 로 (호스트에 아무것도 설치 안 됨)
./run.sh
#    → http://localhost:6081/vnc.html?autoconnect=1&resize=remote

# 2) web-guide 를 그 URL 로 연동 → FLOWGRAPH 단계에 실물 GRC 가 iframe 으로 뜬다
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

## 실제 실행 (▶ Run) → 이미지 복원

`run.sh` 는 제공된 녹음(`../enigma34_downlink.cf32`)을 File Source 경로에 마운트하고,
출력 폴더(`../gnuradio-out/`)를 이미지 out_path 에 마운트한다. 그래서 GRC 에서 **▶ Run** 을
누르면 flowgraph 가 실제로 돌아 다운링크를 복조·디프레임하고 **복원 이미지가
`../gnuradio-out/enigma1_recovered0708.png` 로 저장**된다(레퍼런스와 byte-identical 검증됨).

start.sh 의 실행 사본은 shipped 상태에서 disabled 인 **QT GUI Waterfall Sink 를 enable** 하므로,
▶ Run 하면 "ENIGMA-1 433.5 MHz" 워터폴 창이 떠서 FSK 신호가 실시간으로 보인다(실행 중이라는 시각적 증거).
xterm 경고는 `~/.gnuradio/config.conf` 에 `xterm_executable = /usr/bin/xterm` 을 써서 없앤다.

> ⚠ 샘플레이트: 제공된 녹음은 **96 kSps**(ENIGMA-1 SDR 스펙 0.096 MSps, 9600 baud × 10 sps)라
> `.grc` 의 `samp_rate 0.05e6` 로는 디코드가 안 된다. start.sh 가 여는 실행 사본은
> `0.096e6` 으로 자동 패치한다(원본 `.grc` 는 그대로 둠). 정본 `.grc` 도 96k 로 맞추고 싶으면
> `postProcess/enigma1_decoder.grc` 의 `value: 0.05e6` → `0.096e6` 로 바꾸면 된다.

gpredict-web 과 함께 쓰려면 두 URL 을 같이 넘긴다:
```bash
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

`GNURADIO_URL` 미설정 시 web-guide 는 정답 flowgraph 를 canvas 정적 렌더로 대체 표시한다
(Docker 없이도 화면이 비지 않도록).

## 구성
- `Dockerfile` — debian-slim + `gnuradio` + `gr-satellites`(pip) + `xvfb x11vnc novnc websockify openbox`
- `start.sh` — 컨테이너 내부: Xvfb → openbox → `gnuradio-companion /grc/enigma1_decoder.grc` → x11vnc → websockify
- `run.sh` — 이미지 빌드 + 실행 (`../postProcess` 를 `/grc` 로 마운트해 .grc 제공)

## 환경변수
| 변수 | 기본 | 설명 |
|---|---|---|
| `WEB_PORT` | 6081 | noVNC 웹 포트 (gpredict-web 6080 과 겹치지 않게 분리) |
| `GRC_FILE` | /grc/enigma1_decoder.grc | GRC 로 열 flowgraph 경로(컨테이너 내부) |
| `IMG` | enigma1-gnuradio | Docker 이미지 태그 |

## 참고
- 베이스는 **ubuntu:24.04**(GNU Radio 3.10.9.2 · gr-satellites 5.5). Debian bookworm(GR 3.10.5)은
  `.grc`(3.10.7 작성)의 `blocks_throttle2` 를 몰라 "Missing Block" 으로 떠서 ubuntu 로 올렸다.
- GRC 는 GTK3 GUI 라 `gir1.2-gtk-3.0`+`python3-gi` 가 **반드시** 필요하다. 없으면
  `Namespace Gtk not available` 로 창이 안 뜨고 noVNC 가 **검은 화면**만 보인다(이 이미지엔 포함됨).
  또 `GtkApplication` 이 세션 버스를 원해 `dbus-run-session` 으로 감싸 실행한다(start.sh).
- flowgraph 의 File Source 절대경로/출력경로는 컨테이너에 없어도 된다 — **표시 목적**이므로 GRC 는 그대로 열린다(실행은 하지 않음).
- 최초 `docker build` 는 apt 설치로 시간이 걸릴 수 있다. 정리: `docker rmi enigma1-gnuradio`.
