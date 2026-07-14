# ENIGMA-1 Downlink Decoder — 웹 인터페이스 (Scenario 1)

시나리오 2(scn2)의 webapp 패턴(단일 Python stdlib 서버 + templates/static)을 따르고,
UI 는 scenario2 packet-generator webapp 스타일로 작성한 **6단계 참가자 웹 가이드**.
GPredict 와 VSA 를 브라우저 안에서 함께 띄운다.

```
PHASE 1 MISSION   수신이 목적 — 안테나 트랙킹 / RF 동기화 / 신호 복조 설명
PHASE 2 TARGET    수신 대상 ENIGMA-1 제원 (VSA 에서 확인한 값)
PHASE 3 TRACK     SAT info(상단) · Reset + Remaining time · GPredict(좌) / VSA(우)
PHASE 4 PUZZLE    enigma1_decoder.grc 블록 퍼즐 (정답 배치 · 힌트 버튼)
PHASE 5 FLOWGRAPH 실물 GNU Radio(noVNC) 로 정답 flowgraph 실행
PHASE 6 RESULT    복원된 이미지 확인
```

## 구성 요소
- `web/server.py` — 렌더링 + 정적 마운트 서버(:8080). VSA 를 `/vsa/` 로 마운트하고
  electronAPI shim 을 주입해 일반 브라우저에서도 **ENIGMA-1 자동선택 + `enigma34_downlink.cf32` 자동로드**.
- `web/templates/index.html`, `web/static/{style.css,app.js}` — 6단계 SPA.
- `web/static/vendor/satellite.min.js` — Remaining-time 계산용 SGP4 (오프라인 동작).
- `gpredict-web/` — 실물 gpredict + noVNC + libfaketime + control.py(:6079). (기존 scenario1 그대로)
- `gnuradio-web/` — 실물 GNU Radio Companion + noVNC(:6081), 정답 flowgraph 열림.
- `gpredict-config/` — `defcon.qth`(GS 36.12881986648643, -115.15156849623858),
  `enigma1.tle`(ENIGMA-1 만 등록), `OpenVSA.rot/.rig`.

## 실행
```bash
# 1) (선택) 실물 GPredict — Docker + noVNC (ENIGMA-1 자동 등록/추적)
./gpredict-web/run.sh
#    → http://localhost:6080/vnc.html?autoconnect=1&resize=remote   (control :6079)

# 2) (선택) 실물 GNU Radio — Docker + noVNC (정답 flowgraph 열림, ▶ Run 시 이미지 복원)
./gnuradio-web/run.sh
#    → http://localhost:6081/vnc.html?autoconnect=1&resize=remote

# 3) 웹 인터페이스
GPREDICT_URL='http://localhost:6080/vnc.html?autoconnect=1&resize=remote' \
GNURADIO_URL='http://localhost:6081/vnc.html?autoconnect=1&resize=remote' \
  python3 web/server.py
#    → http://localhost:8080
```

- `GPREDICT_URL` 미지정 시 PHASE 3 GPredict 자리는 **폴라 추적 프리뷰(canvas)** 로 대체.
- `GNURADIO_URL` 미지정 시 PHASE 5 는 **정적 정답 flowgraph** 렌더로 대체.
- **Remaining time for communication with SAT** 는 GS 좌표 + ENIGMA-1 TLE + gpredict
  faketime 오프셋(`/api/offset`)으로 브라우저에서 SGP4 계산(패스 중 → LOS 카운트다운,
  패스 밖 → 다음 AOS 카운트다운). Docker 미기동 시 실시간 기준으로 동작.
- **Reset** 버튼은 gpredict-web control(:6079)에 요청해 gpredict 시간을 다음 패스 최대고도
  직전으로 점프시킨다(`/api/reset-pass`).

## 환경변수
| 변수 | 기본 | 설명 |
|---|---|---|
| `PORT` | 8080 | 웹 인터페이스 포트 |
| `GPREDICT_URL` | (없음) | GPredict noVNC iframe URL |
| `GNURADIO_URL` | (없음) | GNU Radio noVNC iframe URL |
| `VSA_URL` | `/vsa/index.html` | VSA 임베드 URL(기본: 이 서버가 정적 제공) |
| `GPREDICT_CONTROL_URL` | `http://localhost:6079` | reset-pass/offset 프록시 대상 |
