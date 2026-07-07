# 운영자 가이드 (한국어) — Scenario 2 "Uplink Attack"

> DEFCON 34 Aerospace Village. 부스를 **운영하는 운영자**를 위한 문서입니다.
> 이 문서는 확인용 한국어판이며, 공식/배포본은 영어 `operator-guide.md`입니다.
> 참가자가 따라 하는 카드는 `participant-guide.md`(영어) 참고.

데모 메시지: **"정상 명령도 악용되면 공격이 된다."**
관람객이 리액션휠 토크 명령을 위조해 업링크하면, victim 지상국 대시보드가
**ENERGY SUPPLY CRITICAL**로 전환되고 물리 태양광 패널이 폭주 회전합니다.
실제 RF는 없고, 업링크는 소프트웨어로 시뮬레이션됩니다.

## 1. 토폴로지

```
[공격자 랩탑]                                     [Victim 윈도우 PC]
  · Command Builder 웹 UI  http://localhost:8000    · GS 대시보드  http://GS:4540
  · OpenVSA (VSA)                                    · GS 백엔드  :4536 (업링크 수신)
      rotctld :4533 / rigctld :4532 / ws :4534             │
      forward → ws://GS:4536 ──────────────────────────────┘
                                                            └→ Arduino 솔라패널 (트리거 훅, TBD)
```

소프트웨어 시뮬: OpenVSA가 업링크를 검증(안테나 정렬·주파수·링크 마진)한 뒤
디코드된 명령을 WebSocket으로 GS에 forward. `GS` = victim PC의 LAN IP.

## 2. 사전 준비
- 두 머신 같은 LAN. victim PC의 IP를 확인(`GS`로 표기).
- 공격자 랩탑: Python 3 + numpy, Node 20.
- Victim PC: Node 20. 브라우저 전체화면(F11).
- (선택) Arduino가 HTTP로 접근 가능해야 물리 패널 트리거 가능.

## 3. 실행 순서

**① Victim 지상국 (먼저 실행)**
```
cd ground-station/backend
node server.js
#   대시보드  http://localhost:4540    ·    업링크 수신  :4536
#   선택:  ATTACK_DELAY_MS=2500  ARDUINO_URL=http://<arduino>/trigger
```
관객용 모니터에서 `http://localhost:4540`을 전체화면으로.

**② OpenVSA (공격자 VSA)** — 플러그인 먼저 드롭인:
```
cp -r openvsa-plugin/demosat/*             <OpenVSA>/satellites/demosat/
cp    openvsa-plugin/hardware-effects.json <OpenVSA>/satellites/hardware-effects.json
cd <OpenVSA>
UPLINK_DEST=ws://<GS>:4536 node server.js      # forward 대상 = victim GS
npm start                                        # Electron VSA UI (별도 프로세스)
```
주의: `satellites/demosat/`에 `ccsds_ook.py`가 함께 있어야 함(디코더가 import).

**③ Command Builder 콘솔 (공격자)**
```
cd packet-generator/webapp
UPLINK_OUT_DIR=~/uplink python3 app.py
#   http://localhost:8000  — 관람객이 조작
#   GENERATE → ~/uplink/attack.cf32 (OpenVSA에서 이 파일 로드)
```

## 4. 관람객 사이 리셋
```
curl -X POST http://localhost:4540/api/reset      # 지상국을 정상 상태로 복귀
```
Command Builder는 상태가 없음 — 리셋 불필요(새로고침은 선택).

## 5. 튜닝 노브
| 목적 | 위치 | 값 |
|---|---|---|
| 텔레메트리 반응 지연 | GS env `ATTACK_DELAY_MS` | 기본 4000 ms (부스: 1500–3000) |
| 안전 토크 임계값 | `openvsa-plugin/demosat/c2protocol.json` opcode `0x21` → `safeAbsMax` | 500 |
| 배터리 방전 / 태양추적 이탈 속도 | `ground-station/backend/satellite-state.js` → `adcs_torque_magnitude` (drainRate / swingSpeed) | 토크 크기에 비례 |
| Arduino 트리거 | GS env `ARDUINO_URL` (공격 순간 POST) | 미설정 시 로그만 |

## 6. "정상 동작" 기준
- 정상: 녹색 배너, SUN-TRACKING / STABLE / CONNECTED, 배터리 100%.
- 업링크 도달 후(~ATTACK_DELAY_MS 뒤): 빨간 **ENERGY SUPPLY CRITICAL** 배너,
  **SUN-TRACK LOST**, Power Gen이 0 W로 붕괴(낮게 지속), 배터리 방전, **TUMBLING**,
  Comm **LOST**. 전체화면 경보가 ~5초 플래시 후 사라지고 라이브 텔레메트리가 보임.
- 참고 스크린샷: `screenshots/gs-nominal.png`, `gs-alarm-flash.png`,
  `gs-energy-critical.png`, `generator-command-builder.png`.

## 7. 트러블슈팅
| 증상 | 확인 |
|---|---|
| 대시보드가 "CONNECTING…"에서 멈춤 | GS 백엔드(:4540) 미실행 또는 방화벽 |
| 업링크가 GS에 안 옴 | OpenVSA `UPLINK_DEST`가 올바른 `GS` IP인지; :4536 개방; 업링크가 OpenVSA 검증(안테나 정렬, 449.5 MHz) 통과했는지 |
| OpenVSA에서 cf32 디코드 실패 | `satellites/demosat/`에 `ccsds_ook.py`가 `decoder.py`와 함께 복사됐는지 |
| 경보 안 뜸 | 명령이 `adcs_torque`이고 토크가 안전 임계값 초과인지 |

## 8. 미해결 항목
- **Arduino 솔라패널**: 현재 트리거 **훅**만(공격 순간 로그/HTTP POST). 실제 펌웨어 +
  모터 배선은 TBD(Google Drive 코드 확인 후). GS는 `ARDUINO_URL`로 신호 방출 준비 완료.
- **OpenVSA end-to-end** 리허설(위 절차 기준) 미완 — 검증 필요.

---
※ 한국어판 유지보수: 영어 `operator-guide.md`가 기준(source of truth)이며, 내용 변경 시
   양쪽을 함께 갱신해야 합니다.
