# Command Spec, CCSDS TC over OOK

> Command structure for Scenario 4 "Constellation Chaos". This is the **single source of
> truth** shared by the packet generator (attacker console, monitor 1) and the DEMOSAT
> decoder (`decoder.py`); the two are exact inverses of each other. The victim ground
> station (monitor 2) decodes the same payload again to compute the collision outcome.

## 0. Design principles

- **Frame and packet layers model real CCSDS standards** (Telecommand Transfer Frame plus
  Space Packet).
- **Physical layer stays OOK**, robust for a live booth and simple to decode with envelope
  detection, and it matches OpenVSA's existing demosat physical parameters.
- Teaching simplifications are marked `[SIMPLIFIED]`.

## 1. Physical layer

| Item | Value |
|---|---|
| Modulation | OOK (On-Off Keying), envelope detection |
| Baud rate | 100 bps |
| Sample rate | 24 000 Sa/s (240 samples per bit) |
| IQ format | `cf32`, float32 interleaved I/Q (little-endian) |
| Preamble | `0xAAAA` (16 bits `1010...`, bit sync) |
| Bit order | MSB-first within each byte |
| ON amplitude | 1.0 (I=1, Q=0); OFF = 0.0 |

The decoder slices bits by envelope threshold (max times 0.5), aligns on the preamble,
then reassembles bytes.

## 2. Frame structure (link layer, CCSDS TC Transfer Frame)

Transmission order: `[Preamble 2B] [TC Transfer Frame]`

### 2.1 TC Transfer Frame Primary Header, 5 octets (CCSDS 232.0-B)

| Field | Bits | Notes |
|---|---|---|
| TF Version Number | 2 | `00` |
| Bypass Flag | 1 | `1` = Type-BD (no FARM); demo uses bypass |
| Control Command Flag | 1 | `0` = Type-D (data) |
| Reserved Spare | 2 | `00` |
| Spacecraft ID (SCID) | 10 | `0x0C8` (200), DEMOSAT |
| Virtual Channel ID (VCID) | 6 | `000000` |
| Frame Length | 10 | (total frame length minus 1) octets |
| Frame Sequence Number | 8 | transmit counter |

### 2.2 Transfer Frame Data Field
Encapsulates one CCSDS Space Packet (section 3).

### 2.3 Frame Error Control Field, 2 octets
CRC-16-CCITT (poly `0x1021`, init `0xFFFF`) over the Primary Header plus Data Field.

## 3. Packet structure (application layer, CCSDS Space Packet)

### 3.1 Packet Primary Header, 6 octets (CCSDS 133.0-B)

| Field | Bits | Value |
|---|---|---|
| Packet Version Number | 3 | `000` |
| Packet Type | 1 | `1` = Telecommand |
| Secondary Header Flag | 1 | `0` |
| APID | 11 | subsystem id (section 4) |
| Sequence Flags | 2 | `11` = unsegmented |
| Packet Sequence Count | 14 | counter |
| Packet Data Length | 16 | (Data Field length minus 1) octets |

### 3.2 Packet Data Field (the command)

```
[opcode 1B] [command payload N B]
```

opcode and payload semantics in section 4. `[SIMPLIFIED]` real CCSDS defines a dedicated
command format here; the demo collapses it to a simple opcode plus payload.

## 4. Command set (APID / opcode)

| APID | Subsystem | opcode | Command | Payload | Description |
|---|---|---|---|---|---|
| **0x050** | **PROP** | **`0x50`** | **orbit_maneuver** | **4B: prograde int16 + radial int16 (m/s, BE)** | **Orbit maneuver burn, MAIN SCENARIO** |
| 0x010 | POWER | `0x10` | solar_panel | 1B angle(0-255) | Set solar panel angle |
| 0x020 | ADCS | `0x21` | adcs_torque | 2B int16 torque(mNm), BE | Set reaction-wheel torque |
| 0x020 | ADCS | `0x30` | subsystem_ctrl | 1B bitmask | bit0=stabilization, bit1=transponder |
| 0x030 | COMM | `0x20` | antenna_gimbal | 2B (az,el) | Set antenna pointing |
| 0x030 | COMM | `0x40` | transponder_ctrl | 1B 0/1 | Transponder on/off |
| 0x0E0 | OBC | `0xE0` | auth_change | 32B | Overwrite HMAC-SHA256 key |
| 0x0F0 | OBC | `0xF0` | firmware_upload | 2B offset + data | Write to flash |
| 0x0F0 | OBC | `0xFF` | obc_reboot | 0B | Hard reboot OBC |

### Main attack: `orbit_maneuver` (opcode 0x50)

- **Legitimate use**: a normal station-keeping thruster burn that holds the satellite in
  its assigned slot. Payload = a small change in velocity (delta-v), given as two signed
  16-bit values in m/s, big-endian: **prograde** first (along the direction of travel,
  positive raises the orbit), then **radial** (outward from Earth, positive pushes the far
  side of the orbit up). A safe burn is only a couple of m/s.
- **Abuse**: a delta-v of tens of m/s raises DEMOSAT's orbit until its high point
  (apoapsis) reaches the neighbouring **AURORA constellation ring** (560 km). Because the
  ring is dense (45 satellites), DEMOSAT crosses into it and **collides** with a member.
  The impact throws off a debris cloud that keeps orbiting and threatens the rest of the
  fleet, so **one satellite's problem cascades to many**.
- Safe threshold: `|delta-v| > 2 m/s` is treated as beyond a normal station-keeping burn
  (`safeAbsMax` in `c2protocol.json`, tunable). A useful collision course is roughly
  15 to 30 m/s prograde; smaller falls short of the ring, larger overshoots above it.
- The outcome is computed deterministically from the same orbital math on both monitors
  (`satellite-sim/kepler.js`), so the predicted result on monitor 1 always matches what
  plays out on monitor 2.

### Payload encoding, worked example

`orbit_maneuver` with prograde = 22 m/s, radial = 0 m/s:

```
prograde  22  -> int16 BE -> 0x00 0x16
radial     0  -> int16 BE -> 0x00 0x00
payload = 00 16 00 00
```

Negative values use two's complement, for example prograde = -10 m/s becomes `0xFF 0xF6`.

## 5. Roundtrip contract

The `.cf32` produced by `generate.py` decoded by `decoder.py` prints this JSON to stdout
on success:
```json
{ "success": true, "command": "orbit_maneuver", "opcode": "0x50", "apid": "0x050",
  "payload": ["0x00", "0x16", "0x00", "0x00"], "message": "Command accepted: orbit_maneuver" }
```

In the booth, the attacker console does not shell out to OpenVSA. **TRANSMIT** builds the
validated `attack.cf32`, reads the same `{command, payload}` out of its own frame
breakdown, and POSTs it to the victim ground station (`/api/inject`). The ground station
decodes the 4-byte payload back into (prograde, radial), computes the collision outcome,
and broadcasts a `maneuver` event to the dashboard. This is the software-simulated uplink,
no real RF. See section 6 for the optional OpenVSA path.

## 6. Deployment

### 6.1 Software uplink (default, no OpenVSA)

The whole scenario runs on one laptop with two monitors. Nothing needs to be dropped into
OpenVSA. TRANSMIT on monitor 1 forwards the decoded command straight to the ground station
on monitor 2:

```
[monitor 1] TRANSMIT -> HTTP POST http://<GS>:4540/api/inject
            { type:"uplink-command", satellite:"DEMOSAT",
              command:"orbit_maneuver", payload:["0x00","0x16",...],
              frequency:450.1, params:{prograde,radial} }
```

### 6.2 OpenVSA path (optional, RF-flavored rehearsal)

To rehearse with the real VSA, reuse the existing **DEMOSAT slot** so OpenVSA's core
(`src/data/satellites.js`) stays untouched. Drop the `openvsa-plugin/` contents in:
- `openvsa-plugin/demosat/*` into `OpenVSA/satellites/demosat/`
- `openvsa-plugin/hardware-effects.json` into `OpenVSA/satellites/hardware-effects.json`

DEMOSAT's uplink parameters (450.1 MHz, rxSensitivity per `hardware.json`) are used as-is.
Run OpenVSA as `UPLINK_DEST=ws://<GS>:4536 node server.js`; the ground station listens for
`uplink-command` on port 4536 and treats it exactly like an `/api/inject` message.

## 7. Open items

- Final tuning of the safe delta-v threshold and the collision course band (`courseLo` /
  `courseHi` in `satellite-sim/scenario.js`) for booth pacing.
- The `satellite-sim/` placeholder is a 2D canvas stand-in; the 3D port from
  `satellite-tracker` drops in behind the same public API without changing this spec.
