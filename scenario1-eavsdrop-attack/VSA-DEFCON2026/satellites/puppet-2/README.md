# PUPPET-2 — Scenario 2 (Uplink Command Injection)

Fictional LEO toy cubesat used by the booth's **Command Injection** demo.
PUPPET-2 exposes a UHF telecommand (TT&C) uplink that **authenticates nothing** —
any packet with a valid preamble, length, known opcode, and correct CRC-8 is
executed. A visitor crafts a malicious command, encodes it as an OOK IQ file, and
transmits it through VSA when PUPPET-2 is overhead. VSA validates the link
geometry, demodulates the command, and applies it to the satellite state engine.
The winning attack causes **sustained communication loss**; when the downlink
drops, VSA reveals the flag.

Named for what it is on the air: a puppet on the strings of whoever transmits —
it obeys the shape of a command and never asks who is pulling them.

## RF spec

| Parameter          | Value                                          |
|--------------------|------------------------------------------------|
| Downlink beacon    | 401.500 MHz (UHF, housekeeping — for tracking) |
| **Uplink (TT&C)**  | **449.500 MHz (UHF)**                          |
| Uplink modulation  | OOK (on-off keying), 100 baud                  |
| Uplink sample rate | 24 000 Hz                                      |
| Rx sensitivity     | −110 dBm                                       |
| Polarization       | linear                                          |
| Authentication     | **none** — no signature / HMAC / seq counter   |

## Command protocol (C2)

OOK packet, MSB-first, 100 baud. Multiple packets may be concatenated in one file
and are executed in order.

```
[ 0xAA 0xAA ][ length 1B ][ opcode 1B ][ payload 0-N B ][ CRC-8 1B ]
  preamble     = opcode+payload len       poly 0x07, over preamble..payload
```

| Opcode | Command      | Payload | Effect                                                     |
|--------|--------------|---------|------------------------------------------------------------|
| `0x01` | ping         | 0 B     | link check (no effect)                                     |
| `0x04` | obc_reboot   | 0 B     | reboot OBC (comm REBOOTING, recovers) — temporary          |
| `0x14` | adcs_mode    | 1 B     | 0x00 idle, 0x01 sun-track, **0x02 manual** (disables sun-track) |
| `0x15` | adcs_target  | 4 B     | yaw(i16)+pitch(i16); needs manual mode; large slew → **tumble** |
| `0x18` | transponder  | 1 B     | **0x00 off = downlink blackout**, 0x01 on                  |

## Attacks that cause comm loss (→ flag)

- **Tumble** (2-command combo): `adcs_mode`=manual (`0x14 02`) then `adcs_target`
  with a large yaw/pitch (`0x15 ..`) — saturates the reaction wheels, the body
  tumbles, the antenna drifts off the ground station → comm degrades/drops.
- **Transponder off** (single command): `transponder`=off (`0x18 00`) — the
  downlink transponder is disabled → immediate blackout.

Both trip VSA's built-in operator overlay, which reveals
`UPLINK_FLAGS["PUPPET-2"]` from `electron/config.js` once comm is lost.

## Orbit

LEO, ~500 km, inclination 51.64°, period ~94.7 min, 15.2 rev/day.
NORAD ID 90002 — distinct orbit from ENIGMA-1 (90001), so the scenarios are
independent.

## Files

- `hardware.json` — subsystem defaults/specs + opcode→command portMap (with adcs_mode resolve)
- `panel.json` — telemetry panel layout
- `c2protocol.json` — command/packet format + opcodes
- `decoder.py` — OOK demodulator, multi-command (VSA calls this; returns JSON `commands[]`)

Full challenge (signal-info, leaked C2 doc, pre-made signals, TX flowgraph, writeup):
[`vsa4lv-challenges/scenario-2/`](../../../vsa4lv-challenges/scenario-2/).
