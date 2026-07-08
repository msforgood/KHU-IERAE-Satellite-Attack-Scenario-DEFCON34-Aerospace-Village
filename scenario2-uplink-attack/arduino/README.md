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
| `antenna_gimbal/`  | Arduino (any)   | stepper (28BYJ-48 + ULN2003) | acquire → `SWEEP` (`/api/acquire`); attack → `antenna.az` jitter |
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

### Antenna (28BYJ-48 + ULN2003 driver)
| ULN2003 | To |
|---|---|
| IN1 | **D8** |
| IN2 | **D9** |
| IN3 | **D10** |
| IN4 | **D11** |
| V+ / GND | external **5V** supply, GND tied to Arduino GND |

> **Different stepper?** The built-in `Stepper` library drives 4-wire coils
> directly (28BYJ-48/ULN2003, bipolar via L298N). For a **step/dir driver**
> (A4988, DRV8825, NEMA-17) the library does not apply — see the comment block
> at the top of `antenna_gimbal.ino` for the swap.

---

## 2. Upload

Arduino IDE → open each `.ino` → select board + port → Upload. No extra
libraries needed (`Servo` and `Stepper` ship with the IDE).

Or with `arduino-cli`:
```bash
# solar panel (Uno)
arduino-cli compile -b arduino:avr:uno solar_panel_uno
arduino-cli upload  -b arduino:avr:uno -p /dev/cu.usbmodemXXXX solar_panel_uno

# antenna (adjust FQBN to your board, e.g. arduino:samd:mkrwifi1010)
arduino-cli compile -b arduino:avr:uno antenna_gimbal
arduino-cli upload  -b arduino:avr:uno -p /dev/cu.usbmodemYYYY antenna_gimbal
```

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

**Antenna**
```
AZ 270     → stepper rotates to azimuth 270°
SWEEP      → acquisition gesture: head sweeps left↔right (150°↔210°)
TUMBLE     → attack mode, LED blinks
AZEL 90 30 → azimuth 90° (elevation logged)
TRACK      → nominal (stops a sweep)
PING       → prints  ANT READY az=90
```

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
  -d '{"command":"adcs_torque","payload":["0x03","0xe7"]}'
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

## 6. Port not showing up? (macOS)

Find the port:
```bash
ls /dev/cu.usbmodem*
```
If nothing lists while the board is plugged in:
- The **cable may be charge-only** — swap for a known data cable.
- **Connect directly** to the Mac, not through a USB hub / multiport adapter.
- Confirm the board enumerates: `ioreg -p IOUSB -l -w 0 | grep -i arduino`
- Use the **`cu.`** device (not `tty.`) for uploads and the bridge.
