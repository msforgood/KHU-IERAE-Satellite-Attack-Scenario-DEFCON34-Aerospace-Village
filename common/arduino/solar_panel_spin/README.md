# 솔라 패널 모터 — 돌리기 / 멈추기

아주 간단합니다. 이 폴더(`solar_panel_spin/`)에서 아래 명령만 쓰면 됩니다.

## ▶️ 돌리기 / ⏹️ 멈추기

```bash
./solar_panel.sh spin      # 회전 시작
./solar_panel.sh stop      # 멈춤 (소리 없이 조용히)
```

> 전원(USB)을 꽂으면 **자동으로 돌기 시작**합니다. 멈추려면 `stop`.

## 🔧 속도 조절 / 상태 확인

```bash
./solar_panel.sh speed 1   # 속도 1~30 (숫자가 작을수록 느리고 조용함)
./solar_panel.sh ping      # 지금 도는 중인지 확인
```

> 여러 보드를 꽂아도 됩니다. 스크립트가 매번 각 포트에 신호를 보내
> **"SOLAR PANEL"이라 응답하는 포트(=솔라 패널 보드)를 알아서 찾습니다.**

## ❓ 안 될 때

- **"SOLAR PANEL 펌웨어가 응답하는 포트를 못 찾음"** → 보드 USB·전원 확인. 포트를 직접 지정하려면:
  ```bash
  PORT=/dev/cu.usbserial-1140 ./solar_panel.sh spin
  ```
- **명령 후 2초쯤 돌다가 적용됨** → 정상입니다(보드가 연결 때 한 번 리셋됨).
- **모터가 부들거리거나 시끄러움** → `./solar_panel.sh speed 1` 로 가장 느리게.
  그래도 심하면 서보 전원(외부 5V)과 **공통 GND** 연결을 확인하세요.

---

계속 켜두고 여러 번 시작/정지하려면 (리셋 없이 실시간 제어):

```bash
screen /dev/cu.usbserial-140 9600
```
창에 `spin` / `stop` / `speed 1` 을 직접 입력. 종료: `Ctrl-A` → `K` → `y`.
