# Command Spec — CCSDS TC over OOK

> Command structure for Scenario 2 "Uplink Attack". This is the **single source of
> truth** shared by the Python packet generator (①) and OpenVSA's satellite decoder
> (`decoder.py`); the two are exact inverses of each other.

## 0. Design principles

- **Frame / packet layers model real CCSDS standards** (Telecommand Transfer Frame +
  Space Packet).
- **Physical layer stays OOK** — robust for a live booth and simple to decode with
  envelope detection; matches OpenVSA's existing demosat physical parameters.
- Teaching simplifications are marked `[SIMPLIFIED]`.

## 1. Physical layer

| Item | Value |
|---|---|
| Modulation | OOK (On-Off Keying), envelope detection |
| Baud rate | 100 bps |
| Sample rate | 24 000 Sa/s (→ 240 samples/bit) |
| IQ format | `cf32` = float32 interleaved I/Q (little-endian) |
| Preamble | `0xAAAA` (16 bits `1010…`, bit sync) |
| Bit order | MSB-first within each byte |
| ON amplitude | 1.0 (I=1, Q=0); OFF = 0.0 |

The decoder slices bits by envelope threshold (max × 0.5), aligns on the preamble,
then reassembles bytes.

## 2. Frame structure (link layer — CCSDS TC Transfer Frame)

Transmission order: `[Preamble 2B] [TC Transfer Frame]`

### 2.1 TC Transfer Frame Primary Header — 5 octets (CCSDS 232.0-B)

| Field | Bits | Notes |
|---|---|---|
| TF Version Number | 2 | `00` |
| Bypass Flag | 1 | `1` = Type-BD (no FARM); demo uses bypass |
| Control Command Flag | 1 | `0` = Type-D (data) |
| Reserved Spare | 2 | `00` |
| Spacecraft ID (SCID) | 10 | `0x0C8` (200) — DEMOSAT |
| Virtual Channel ID (VCID) | 6 | `000000` |
| Frame Length | 10 | (total frame length − 1) octets |
| Frame Sequence Number | 8 | transmit counter |

### 2.2 Transfer Frame Data Field
→ encapsulates one CCSDS Space Packet (§3).

### 2.3 Frame Error Control Field — 2 octets
CRC-16-CCITT (poly `0x1021`, init `0xFFFF`) over the Primary Header + Data Field.

## 3. Packet structure (application layer — CCSDS Space Packet)

### 3.1 Packet Primary Header — 6 octets (CCSDS 133.0-B)

| Field | Bits | Value |
|---|---|---|
| Packet Version Number | 3 | `000` |
| Packet Type | 1 | `1` = Telecommand |
| Secondary Header Flag | 1 | `0` |
| APID | 11 | subsystem id (§4) |
| Sequence Flags | 2 | `11` = unsegmented |
| Packet Sequence Count | 14 | counter |
| Packet Data Length | 16 | (Data Field length − 1) octets |

### 3.2 Packet Data Field (= the command)

```
[opcode 1B] [command payload N B]
```

opcode/payload semantics in §4. `[SIMPLIFIED]` real CCSDS defines a dedicated command
format here; the demo collapses it to a simple opcode+payload.

## 4. Command set (APID / opcode)

| APID | Subsystem | opcode | Command | Payload | Description |
|---|---|---|---|---|---|
| 0x010 | POWER | `0x10` | solar_panel | 1B angle(0-255) | Set solar panel angle |
| **0x020** | **ADCS** | **`0x21`** | **adcs_torque** | **2B int16 torque(mNm), BE** | **Set reaction-wheel torque ★ MAIN SCENARIO** |
| 0x020 | ADCS | `0x30` | subsystem_ctrl | 1B bitmask | bit0=stabilization, bit1=transponder |
| 0x030 | COMM | `0x20` | antenna_gimbal | 2B (az,el) | Set antenna pointing |
| 0x030 | COMM | `0x40` | transponder_ctrl | 1B 0/1 | Transponder on/off |
| 0x0E0 | OBC | `0xE0` | auth_change | 32B | Overwrite HMAC-SHA256 key |
| 0x0F0 | OBC | `0xF0` | firmware_upload | 2B offset + data | Write to flash |
| 0x0F0 | OBC | `0xFF` | obc_reboot | 0B | Hard reboot OBC |

### ★ Main attack: `adcs_torque` (opcode 0x21)

- **Legitimate use**: a normal reaction-wheel torque command for attitude control.
  Payload = target torque (mNm, int16).
- **Abuse**: a torque beyond the safe range → the satellite spins out of control
  (tumbling) → the solar panel loses sun-track → **power generation collapses (energy
  supply failure)** → battery drains → the ground station alarms.
- Safe threshold (example): `|torque| > 500 mNm` → treated as an attack (tunable).
- The effect chain is defined in `hardware-effects.json` (`adcs_torque`, reusing the
  shared `adcs_target` tumbling physics).

## 5. Roundtrip contract

The `.cf32` produced by `generate.py` → `decoder.py` prints this JSON to stdout on
success:
```json
{ "success": true, "command": "adcs_torque", "opcode": "0x21",
  "payload": ["0x03", "0xe7"], "message": "Command accepted: adcs_torque" }
```
→ OpenVSA turns `command` into an `uplink-transmit` event and, once the uplink
validates, forwards `uplink-command` to the GS (:4536).

## 6. Deployment — OpenVSA core untouched

Reuse the existing **DEMOSAT slot** to avoid editing core (`src/data/satellites.js`).
Drop the `openvsa-plugin/` contents into OpenVSA:
- `openvsa-plugin/demosat/*` → `OpenVSA/satellites/demosat/`
- `openvsa-plugin/hardware-effects.json` → `OpenVSA/satellites/hardware-effects.json`

DEMOSAT's uplink parameters (449.5 MHz, rxSensitivity −110 dBm) are used as-is.

## 7. Open items
- Final tuning of the safe torque threshold / scaling (Phase 5).
- Whether OpenVSA's forward should include opcode/payload (to show the torque value
  on the dashboard) — a small patch if desired.
