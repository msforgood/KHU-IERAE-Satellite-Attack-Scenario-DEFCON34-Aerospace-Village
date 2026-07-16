# 운영자 가이드 (한국어), Scenario 4 "Constellation Chaos"

> DEFCON 34 Aerospace Village. 부스를 **운영하는 운영자**를 위한 문서입니다.
> 이 문서는 확인용 한국어판이며, 공식 배포본은 영어 `operator-guide.md`가 기준입니다.
> 참가자가 따라 하는 카드는 `participant-guide.md`(영어) 참고.

데모 메시지: **"위성 하나의 문제가 여러 위성으로 번진다."**
관람객이 정상 궤도 수정 명령을 악용해 업링크하면, DEMOSAT가 궤도를 올려 AURORA
군집위성 링에 진입하고, 한 위성과 충돌하며, 그 잔해가 나머지 위성들까지 위협합니다.
victim 지상국 대시보드가 충돌 경보를 띄우고 잔해 확산 영상을 재생합니다.
실제 RF는 없고, 업링크는 소프트웨어로 시뮬레이션됩니다.

## 1. 토폴로지

랩탑 1대, 모니터 2개. 두 웹앱 모두 같은 머신에서 실행됩니다.

```
[랩탑 1대]
  모니터 1 (랩탑 자체 화면)      공격자 콘솔   http://localhost:8000
    - 궤도 플래너 (AURORA에 충돌하는 추진값 찾기)
    - orbit_maneuver 패킷 제작
    - TRANSMIT (소프트웨어 업링크)
                     │  HTTP POST /api/inject
                     ▼
  모니터 2 (외장 모니터)         victim 지상국   http://localhost:4540
    - 충돌 시뮬레이션 (상단)
    - 지상국 대시보드 + 경보 + 잔해 영상 (하단)

  (선택) OpenVSA / VSA ── WS ──▶ GS :4536   (RF 느낌의 리허설용)
```

소프트웨어 시뮬: 모니터 1의 TRANSMIT가 검증된 IQ 파일을 만들고 자기 프레임을 디코드해
`{command, payload}`를 지상국에 POST합니다. 지상국은 delta-v를 디코드해 시뮬과 동일한
궤도 계산으로 충돌 결과를 산출합니다.

## 2. 사전 준비
- 외장 모니터를 연결한 랩탑 1대 (미러링이 아니라 확장 디스플레이).
- Python 3 + numpy (공격자 콘솔), Node 20 (지상국).
- 최신 브라우저. 모니터마다 창 1개씩 전체화면(F11).
- 이 시나리오에는 HackRF, 안테나, 토이 위성이 필요 없습니다.

## 3. 실행 순서

**1단계, victim 지상국 (먼저 실행), 모니터 2**
```
cd victim/backend
node server.js
#   대시보드    http://localhost:4540   (외장 모니터에서 전체화면)
#   업링크 WS   :4536   (선택: OpenVSA 입력)
#   env:  GS_HTTP_PORT=4540   UPLINK_PORT=4536
```
또는 런처 사용: `./start-victim.sh`.

**2단계, 공격자 콘솔, 모니터 1**
```
cd attacker/packet-generator/webapp
GS_URL=http://localhost:4540 python3 app.py
#   http://localhost:8000   (랩탑 화면, 관람객이 조작)
#   env:  GS_URL (업링크/리셋 대상)   PORT=8000   UPLINK_OUT_DIR (~/uplink)
```
또는 런처 사용: `./start-attacker.sh` (최초 실행 시 venv에 numpy 설치 후 코덱 라운드트립
확인을 거쳐 실행).

관람객은 콘솔에서 두 단계를 거칩니다.
- **1단계, 브리핑:** 개념을 읽고 확인 체크 후 PLAN THE ATTACK 누르기.
- **2단계, 계획 및 제작:** 궤도 플래너에서 **prograde delta-v**를 올려 상태가
  **COLLISION COURSE**(약 15에서 30 m/s)가 되게 한 뒤, 4스텝 업링크 조립(SCID, 명령, 값,
  RF 설정)을 완료하고 GENERATE, TRANSMIT.

관람객이 조립에서 막히면 콘솔 왼쪽 **TARGET INTEL** 도시어를 가리키세요. 모든 필드
(SCID 200, OOK, 100 bps, 24 kSa/s)가 일치해야 합니다.

## 4. 관람객 사이 리셋
한 회차가 끝나면 공격자 콘솔의 **RESET SIMULATION (monitor 2)** 버튼을 누르세요.
시뮬레이션과 대시보드가 모두 정상 상태로 돌아갑니다. 터미널에서는:
```
curl -X POST http://localhost:4540/api/reset
```
콘솔 자체는 상태가 없어 리셋이 필요 없습니다(새로고침은 선택).

## 5. 튜닝 노브
| 목적 | 위치 | 값 |
|---|---|---|
| 안전 station-keeping 임계값 | `attacker/openvsa-plugin/demosat/c2protocol.json` opcode `0x50` -> `safeAbsMax` | 2 (m/s) |
| 관람객에게 보이는 권장 추진값 | `satellite-sim/scenario.js` -> `aimHintDv` | 22 (m/s) |
| 충돌 코스 밴드 (충돌 허용 범위) | `satellite-sim/scenario.js` -> `simOpts.courseLo` / `courseHi` | 링 반지름 -25 km에서 +65 km |
| 재생 속도 (화면상 궤도 상승 시간) | `satellite-sim/scenario.js` -> `simOpts.impactTargetSec` / `playbackSpeed` | 20초 / 320배 |
| 군집 규모 / 링 고도 | `satellite-sim/scenario.js` -> 링 루프, `RING_ALT_KM` | 45기, 560 km |

## 6. "정상 동작" 기준
- **정상 (TRANSMIT 전):** 녹색 배너 "NOMINAL, all satellites separated and
  station-keeping". DEMOSAT 원지점/근지점 모두 500 km, 링 560 km, 궤도 태그
  STATION-KEEPING, AURORA 45 of 45 operational, 위협 NONE.
- **기동 중 (TRANSMIT 직후):** 주황 배너 "MANEUVER IN PROGRESS", 궤도 태그 MANEUVERING,
  시뮬에서 DEMOSAT 궤도가 링을 향해 상승. 모니터 1 플래너와 모니터 2 시뮬의 결과가 일치.
- **충돌 (충돌 코스로 악용한 경우):** 빨간 배너 "COLLISION, DEMOSAT struck AURORA-xx",
  궤도 태그 DESTROYED, 위협 DEBRIS CASCADE(깜빡임), 최근접 "0 km, IMPACT". 전체화면 경보가
  약 5초 플래시 후 사라지고(라이브 텔레메트리 유지), 잔해 영상 오버레이가 재생되며,
  운용 대수가 45 of 45 아래로 떨어짐.
- **미스 (추진값이 너무 작거나 큼):** 주황 배너 "Maneuver complete, DEMOSAT missed the
  constellation (no collision). Awaiting reset.", 궤도 태그 OFF-NOMINAL ORBIT. RESET을
  누르고 관람객에게 각도를 다시 계산하도록 안내.
- 참고 스크린샷: `screenshots/` (시나리오 4용으로 재촬영 필요, 8절 참고).

## 7. 트러블슈팅
| 증상 | 확인 |
|---|---|
| 대시보드가 "CONNECTING..."에서 멈춤 | GS 백엔드(:4540) 미실행 |
| TRANSMIT가 "ground station unreachable" | 콘솔의 `GS_URL`이 실행 중인 GS를 가리키는지(기본 `http://localhost:4540`); GS가 켜져 있는지 |
| GENERATE가 잠긴 채로 있음 | 4스텝이 모두 정답인지: SCID 200, 명령 orbit_maneuver, 값 확정, RF = OOK / 100 bps / 24 kSa/s |
| 항상 빗나감 | prograde가 너무 작거나(링에 못 미침) 너무 큼(링 위로 넘어감); 원지점이 560 km에 닿도록 약 15에서 30 m/s |
| 잔해 영상 안 나옴 | `assets/orbit_demo.mp4` 존재; 브라우저가 무음 자동재생 허용(영상은 muted) |
| 두 모니터가 같은 화면 | OS 디스플레이를 미러링이 아니라 확장으로 설정 |

## 8. 미해결 항목
- **스크린샷:** `docs/screenshots/`에 아직 시나리오 2 캡처(지상국 에너지 경보)가 있음.
  시나리오 4 상태로 재촬영 필요: 정상 대시보드, 기동 중, 잔해 영상 포함 충돌, 그리고
  COLLISION COURSE를 표시하는 공격자 콘솔 플래너.
- **3D 시뮬레이션:** `satellite-sim/` 뷰는 2D 플레이스홀더이며, 추후 `satellite-tracker`
  3D 포팅이 동일 API 뒤로 들어옴.
- **잔해 영상:** `assets/orbit_demo.mp4`는 플레이스홀더 클립; 최종 잔해 확산 영상이
  준비되면 교체.
- **OpenVSA 리허설:** 선택적 RF 경로(:4536 forward)는 가능하지만 부스에는 불필요.

---
※ 한국어판 유지보수: 영어 `operator-guide.md`가 기준(source of truth)이며, 내용 변경 시
   양쪽을 함께 갱신해야 합니다.
