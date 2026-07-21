# GPredict (web) — 실물 GPredict를 브라우저로 (Scenario 1 · ENIGMA-1)

scn2 `attacker/gpredict-web/` 를 ENIGMA-1 수신 시나리오로 이식한 것. **재구현이 아니라
진짜 gpredict GTK 앱을 Docker 안에서 돌려 noVNC 로 브라우저에 스트리밍**한다. web-guide 의
TRACK 단계는 이 noVNC URL 을 `GPREDICT_URL` 로 받아 iframe 으로 띄운다.

```
Docker 컨테이너
  Xvfb :99  ─ 가상 X 디스플레이
  openbox   ─ 창 관리자
  gpredict  ─ 실제 GTK 앱 (ENIGMA-1 TLE 추적, rotctld :4533 구동)
  x11vnc    ─ :99 화면을 VNC :5900 로 export
  websockify(noVNC) ─ VNC 를 웹 :6080 으로 → 브라우저에서 보임
        │
        └─ web-guide TRACK iframe ◀ http://localhost:6080/vnc.html?autoconnect=1&resize=remote
```

## 실행

```bash
# 0) (선택) 시나리오1 Virtual Antenna 를 먼저 띄우면 gpredict 로테이터가 붙는다
#    cd ../VSA-DEFCON2026 && node server.js         # rotctld :4533 / rigctld :4532 / ws :4534

# 1) gpredict 를 Docker+noVNC 로 (호스트에 아무것도 설치 안 됨)
./run.sh
#    → http://localhost:6080/vnc.html?autoconnect=1&resize=remote

# 2) web-guide 를 그 URL 로 연동해 실행 → TRACK 단계에 실물 gpredict 가 iframe 으로 뜬다
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
  python3 ../web-guide/server.py
```

`GPREDICT_URL` 을 주지 않으면 web-guide 는 자체 폴라 추적 프리뷰(canvas)로 대체 표시한다
(Docker 없이도 화면이 비지 않도록). Docker 데몬이 꺼져 있으면 `run.sh` 가 명확히 안내한다.

## 구성
- `Dockerfile` — debian-slim + `gpredict xvfb x11vnc novnc websockify openbox`
- `start.sh` — 컨테이너 내부: TLE/QTH/로테이터 설정 주입 → Xvfb → gpredict → x11vnc → websockify
- `run.sh` — 이미지 빌드 + 실행 (`../gpredict-config` 를 `/config` 로 마운트)
- `../gpredict-config/` — `enigma1.tle`, `OpenVSA.rot`(rotctld :4533), `defcon.qth`

## TLE 등록 (로컬 파일) · ENIGMA-1 열기

`../gpredict-config/enigma1.tle` 를 컨테이너의 `/config` 로 마운트하고, start.sh 가 이를
gpredict 위성 DB(`satdata/90001.sat`)와 모듈(`modules/ENIGMA-1.mod`)로 **자동 등록**한다.
따라서 gpredict 안에서 ENIGMA-1(catalog 90001)이 위성 목록에 이미 잡혀 있다.

- **ENIGMA-1 열기**: gpredict 상단 **File ▸ (module 목록에서) ENIGMA-1** 을 열거나,
  새 모듈을 만들 때 위성 목록에서 ENIGMA-1 을 선택 → **Antenna Control** 에서 Rotator `OpenVSA`(host:4533) 로 추적.
  (gpredict 첫 실행은 빈 창으로 뜨는 게 정상 — 모듈을 한 번 열면 이후 자동 복원된다.)
- **다른 로컬 TLE 등록**: 호스트의 `../gpredict-config/` 에 `*.tle` 파일을 넣고,
  gpredict 에서 **Edit ▸ Update TLE data ▸ From local files…** → 폴더 `/config` 선택 → 임포트.
- **안테나 추적(Antenna Control)**: 모듈 ≡ 메뉴 ▸ **Antenna Control** → 로테이터 `OpenVSA`(host:4533) 로드,
  **Track** 로 ENIGMA-1 자동추적, **Engage** 로 Virtual Antenna rotctld 연결(Virtual Antenna `node server.js` 가 켜져 있어야 함).
  ※ 로테이터 설정 파일은 gpredict 형식(`[Rotator]` 그룹 + `Host/Port/AzType…` CamelCase 키)이어야 한다 —
  형식이 틀리면 Antenna Control 이 "Failed to load rotator configuration" 으로 검은 창이 된다.

즉 TLE 소스가 로컬 파일이며(네트워크 불필요), 파일을 바꿔 넣으면 그대로 재등록된다.

## 라디오(Radio Control) · Doppler
`../gpredict-config/OpenVSA.rig`(gpredict 형식 `[Radio]` 그룹)를 host 의 Virtual Antenna rigctld(:4532)에 연결하도록
자동 등록. 모듈 ≡ 메뉴 ▸ **Radio Control** ▸ Device `OpenVSA` ▸ Engage → gpredict 가 궤도에서 계산한
**Doppler 보정 주파수를 Virtual Antenna rigctld 로 전송**(다운링크 RX 튜닝). Virtual Antenna `node server.js` 필요.

## 패스 직전으로 리셋 (control 서버 :6079)
gpredict 를 **libfaketime** 하에서 실행하고, control 서버(`control.py`, :6079)가 요청 시
`pyephem` 으로 ENIGMA-1 의 **다음 AOS**(QTH 상공 통과)를 계산 → libfaketime 오프셋을 `AOS − PASS_LEAD(120s)`
로 설정 → gpredict 재시작(supervisor 재오픈) → **패스 직전으로 점프**. web-guide 의 **⟳ 패스 직전으로 리셋**
버튼이 `/api/reset-pass`(→ :6079 프록시)로 호출. 직접: `curl localhost:6079/reset-pass` (복귀 `/realtime`).

## 환경변수
| 변수 | 기본 | 설명 |
|---|---|---|
| `WEB_PORT` | 6080 | noVNC 웹 포트 |
| `CTRL_PORT` | 6079 | 시간-control 서버 포트 |
| `PASS_LEAD` | 120 | AOS 몇 초 전으로 리셋할지 |
| `ROTCTLD_HOST` | host.docker.internal | 호스트의 Virtual Antenna rotctld(:4533)/rigctld(:4532) 주소 |
| `IMG` | enigma1-gpredict | Docker 이미지 태그 |

## 정리
`docker rmi enigma1-gpredict` — 이미지 삭제. 호스트에는 아무것도 남지 않는다.
