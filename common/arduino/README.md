# Arduino actuators — Scenario 2 Uplink Attack

Physical hardware that mirrors the satellite state engine — live, driven straight
from the victim dashboard state. During **pointing** the antenna sweeps to
acquire the target; on **attack** the solar panel spins (or swings off-sun) and the
antenna loses its beam.

```
GS :4540 /api/state ──poll──▶ bridge.js ──serial──▶ ① solar_panel_uno   (servo)
                                        └─serial──▶ ② antenna_gimbal    (stepper)
```

| Piece | Board | Motor | Behavior |
|---|---|---|---|
| `solar_panel_uno/` | Arduino **Uno** | servo — continuous-rotation (FS90R) for endless spin, or standard SG90 for off-sun swing | attack → `SPIN` (`PANEL_SPIN=1`) or `solar_panel.angle` 90°→0° |
| `antenna_gimbal/`  | Arduino **MKR WiFi 1010** | **2× stepper** (28BYJ-48 + ULN2003) — AZ=A0~A3 · EL=D2~D5 | acquire → `SWEEP` (`/api/acquire`); attack → `antenna.az`/`el` jitter |
| `bridge/bridge.js` | — (host, Node)  | — | polls GS, writes serial |

The existing victim JS is **not modified** — the bridge glues on via the
public `/api/state` endpoint.

---

## 1. Wiring

### Solar panel (Uno + SG90 servo)
| Servo wire | To |
|---|---|
| Signal (orange) | **D9** |
| V+ (red) | external **5V** supply (not the Uno 5V pin under load) |
| GND (brown) | common GND — tie Uno GND **and** supply GND together |

Status LED = on-board **D13** (solid = nominal, blinking = attack).

### Antenna — TWO 28BYJ-48 steppers (MKR WiFi 1010 + ULN2003 ×2)

The antenna gimbal has **two independent motors**. Identify them by which
ULN2003 they are wired to (this is the authoritative record — the sketch
`antenna_gimbal.ino` uses exactly these pins):

| Motor (role) | Axis | ULN2003 IN1 · IN2 · IN3 · IN4 → board pins |
|---|---|---|
| **AZ 모터** (azimuth · 수평 팬) | 좌우 회전 / `SWEEP` / `SPIN` | **A0 · A1 · A2 · A3** |
| **EL 모터** (elevation · 상하 틸트) | 위아래 틸트만 | **D2 · D3 · D4 · D5** |

| Power | To |
|---|---|
| V+ / GND (each ULN2003) | external **5–6V** supply, GND tied to board GND (공통 GND 필수) |

Status LED = on-board `LED_BUILTIN` (solid = nominal · fast blink = tumbling ·
slow blink = sweep · blink = spin).

- **어느 모터가 AZ/EL인지 확인하려면**: `AZ 300` 을 보내면 **A0~A3** 에 물린 모터만
  돌고(EL 정지), `EL 90` 을 보내면 **D2~D5** 에 물린 모터만 틸트한다(AZ 정지).
- Drive: `AccelStepper` HALF4WIRE(type 8), 코일순서 IN1,IN3,IN2,IN4, 4096 step/rev.
  검증된 `antenna_selftest.ino`(scn1 booth_antenna) 와 동일한 배선·구동 방식이다.

> **Different stepper?** For a **step/dir driver** (A4988, DRV8825, NEMA-17)
> `AccelStepper` uses `DRIVER`(type 1) with STEP/DIR pins instead — see the
> comment block at the top of `antenna_gimbal.ino`.

---

## 2. Upload

Arduino IDE → open each `.ino` → select board + port → Upload. `Servo` (solar)
ships with the IDE; the antenna needs **`AccelStepper`** (Library Manager →
install "AccelStepper", or `arduino-cli lib install AccelStepper`).

Or with `arduino-cli`:
```bash
# solar panel (Uno / CH340 clone)
arduino-cli compile -b arduino:avr:uno solar_panel_uno
arduino-cli upload  -b arduino:avr:uno -p /dev/cu.usbmodemXXXX solar_panel_uno

# antenna (MKR WiFi 1010) — needs the SAMD core + AccelStepper library
arduino-cli core install arduino:samd
arduino-cli lib  install AccelStepper
arduino-cli compile -b arduino:samd:mkrwifi1010 antenna_gimbal
arduino-cli upload  -b arduino:samd:mkrwifi1010 -p /dev/cu.usbmodemYYYY antenna_gimbal
```
> `start-attacker.sh` (scn2) 는 이 코어/라이브러리 설치 + 업로드 + WHOAMI 연결확인을 자동으로 한다.

---

## 3. Test each board alone (no bridge, no port-discovery needed)

Open the **Serial Monitor @ 9600 baud** and type:

**Solar panel**
```
OFFSUN     → servo swings to 0° (off-sun), LED blinks
SUN        → servo returns to 90° (sun-track), LED solid
ANG 45     → servo to 45°
SPIN       → continuous rotation (continuous-rotation servo only), LED blinks
STOP       → halt spin (neutral 1500µs), hold position
PING       → prints  SOLAR READY angle=45 mode=0
```

**Antenna** (Serial Monitor @ **9600**)
```
AZ 270     → AZ 모터(A0~A3)만 방위각 270°로 회전 (EL 정지)
EL 90      → EL 모터(D2~D5)만 앙각 90°로 틸트 (AZ 정지)
AZEL 90 30 → 두 모터: 방위각 90° · 앙각 30°
SWEEP      → AZ 헤드가 좌↔우 스윕 (150°↔210°)
SPIN/STOP  → AZ 연속 회전 / 정지
TUMBLE     → attack mode, LED 빠른 점멸
TRACK      → nominal (스윕/스핀 해제)
WHOAMI     → prints  ID=ANTENNA
PING       → prints  ANT READY id=ANTENNA az=90 el=30 mode=0
```
> `AZ nnn` 만 보냈을 때 도는 모터가 AZ, `EL nnn` 만 보냈을 때 도는 모터가 EL 이다.

---

## 4. Line protocol (9600 baud, `\n`-terminated)

| Board | Command | Meaning |
|---|---|---|
| solar | `ANG <0-180>` | target servo angle |
| solar | `MODE <0\|1>` | 0 nominal / 1 attack |
| solar | `SUN` / `OFFSUN` | shortcuts (90+nominal / 0+attack) |
| solar | `SPIN [us]` | continuous rotation (1000–2000µs, 1500=stop); needs a continuous-rotation servo |
| solar | `STOP` | halt spin (neutral pulse), hold position |
| solar | `PING` | status reply |
| antenna | `AZEL <az> <el>` | set azimuth (elevation logged) |
| antenna | `AZ <az>` | set azimuth only |
| antenna | `MODE <0\|1>` | 0 nominal / 1 tumbling |
| antenna | `SWEEP` / `ACQUIRE` | acquisition sweep, head left↔right |
| antenna | `TRACK` / `TUMBLE` | shortcuts |
| antenna | `PING` | status reply |

---

## 5. End-to-end with the ground station

```bash
# terminal 1 — victim ground station
cd ../victim/backend && node server.js          # http://localhost:4540

# terminal 2 — serial bridge (fill in your actual ports)
#   PANEL_SPIN=1 → solar panel is a continuous-rotation servo (spins on attack)
cd ../arduino/bridge
SOLAR_PORT=/dev/cu.usbmodemXXXX ANT_PORT=/dev/cu.usbmodemYYYY PANEL_SPIN=1 node bridge.js

# terminal 3 — pointing: fire the antenna acquisition sweep (gpredict lock)
curl -X POST localhost:4540/api/acquire

# terminal 3 — transmit/attack (real demo uses OpenVSA TRANSMIT → :4536 forward;
#              this inject is a GS-only self-test, not the demo path)
curl -X POST localhost:4540/api/inject -H 'Content-Type: application/json' \
  -d '{"command":"spin_control","payload":["0x03","0xe7"]}'
```

Expected: on `/api/acquire` the antenna sweeps left↔right; then after
`ATTACK_DELAY_MS` (~4 s) the solar panel spins (or swings off-sun without
`PANEL_SPIN`) and the antenna jitters, in sync with the dashboard alarm.

Reset:
```bash
curl -X POST localhost:4540/api/reset
```

Run the bridge with **no** env vars to list candidate ports:
```bash
node bridge.js
```
Either port may be omitted — the bridge drives whichever board is present.

---

## 6. Port not showing up?

포트 이름은 OS 마다 다르다 — **macOS `/dev/cu.usbmodemXXXX` · Linux `/dev/ttyACM0` ·
Windows `COM3`**. 어느 OS든 아래 한 줄로 후보를 뽑을 수 있다(설치 필요 없음):

```bash
node bridge/serial.js list      # 후보 포트
node bridge/serial.js boards    # "포트<TAB>FQBN" (arduino-cli 가 있으면 FQBN 까지)
```

`PORT`/`ANT_PORT`/`SOLAR_PORT` 에는 이 이름을 그대로 넣으면 된다:
```bash
PORT=/dev/cu.usbmodem1101 ./motor.sh antenna ping    # macOS
PORT=COM3 ./motor.sh antenna ping                    # Windows
```

플러그를 꽂았는데 아무것도 안 잡히면:
- **충전 전용 케이블**일 수 있다 — 데이터 되는 케이블로 교체.
- USB 허브/멀티포트 어댑터 말고 **본체에 직접** 연결.
- macOS: 보드 인식 확인 `ioreg -p IOUSB -l -w 0 | grep -i arduino`, 업로드·브리지는
  **`cu.`** 장치를 쓴다(`tty.` 아님).
- Windows: 장치 관리자 → **포트(COM & LPT)** 에 보이는지 확인. 안 보이면 CH340/CP210x
  **드라이버 미설치**인 경우가 많다(정품 Uno·MKR 은 드라이버 불필요).
- Windows: `COM10` 이상도 그대로 쓰면 된다 — serial.js 가 내부적으로 `\\.\COM10` 으로 연다.
