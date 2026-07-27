# OpenVSA Manual

## Download & Run

```bash
git clone https://github.com/whal-e3/OpenVSA
cd OpenVSA
npm install
npm run electron
```

**Requirements:** Node.js v18+, Python 3 (optional, for uplink decoding)

---

## Adding a Custom Satellite

Adding a satellite requires changes in **4 files** and **1 directory**.

### Step 1 — Signal File

Create or obtain an IQ signal file in **complex float32** format (`.cf32`):
- Interleaved I/Q samples, 32-bit float, little-endian
- Any sample rate (e.g. 48000 Hz, 1000000 Hz)
- Tools like GNU Radio, SDR#, or `rtl_sdr` can produce these

Compute its SHA-256 hash for integrity validation:
```bash
sha256sum mysat1_signal.cf32
```

### Step 2 — Register the Satellite

**`src/data/satellites.js`** — Add RF parameters:
```js
"MYSAT-1": {
  centerFreqMHz: 437.5,         // downlink center frequency
  eirp:          115,            // effective radiated power (VSA units, 110-170 typical)
  iqSampleRate:  48_000,         // sample rate of your .cf32 file in Hz
  polarization:  "linear",       // "linear", "RHCP", or "LHCP"
  // optional uplink:
  uplink: {
    freqMHz:          435.0,     // uplink frequency
    purpose:          "TT&C",    // channel purpose
    rxSensitivityDbm: -115,      // satellite receiver sensitivity
  },
},
```

**`electron/config.js`** — Add Electron-side config:
```js
const SATELLITES = {
  // ...existing...
  "MYSAT-1": {
    centerFreqHz: 437.5e6,
    iqFileHash: "a1b2c3d4e5...",   // SHA-256 hash of your .cf32 file
  },
};
```

If your satellite has an uplink flag, add it to `UPLINK_FLAGS`:
```js
const UPLINK_FLAGS = {
  // ...existing...
  "MYSAT-1": "your_flag_here",
};
```

### Step 3 — Add TLE Data

**`tle.txt`** — Append the satellite's Two-Line Element set:
```
MYSAT-1
1 55555U 24001A   24086.50000000  .00001500  00000-0  70000-4 0  9996
2 55555  51.6000 150.0000 0005000  90.0000 270.0000 15.50000000  1005
```

Get real TLEs from [CelesTrak](https://celestrak.org/) or [Space-Track](https://www.space-track.org/).

### Step 4 — Satellite Config Directory

Create `satellites/mysat-1/` with these files:

#### `hardware.json`

Defines subsystems and initial telemetry:
```json
{
  "solar_panel": { "status": "nominal", "power_w": 8, "degradation": 0 },
  "battery":     { "status": "nominal", "charge_pct": 85, "voltage_v": 7.4, "capacity_wh": 30 },
  "antenna":     { "status": "nominal", "type": "dipole", "beamwidth_deg": 360, "gain_dbi": 2 },
  "comm":        { "status": "nominal", "frequency_mhz": 437.5, "tx_power_dbm": 27, "modulation": "GMSK" },
  "transponder": { "status": "nominal", "bandwidth_khz": 25 },
  "adcs":        { "status": "nominal", "mode": "nadir", "type": "magnetorquer", "pointing_accuracy_deg": 5 },
  "obc":         { "status": "nominal", "uptime_s": 0, "cpu": "ARM Cortex-M4", "firmware": "v1.0" },
  "auth":        { "hmac_key": "default_key_hex", "seq_counter": 0 }
}
```

#### `panel.json`

Telemetry display layout:
```json
{
  "sections": [
    {
      "title": "POWER",
      "fields": [
        { "key": "solar_panel.power_w",     "label": "Solar Power",  "unit": "W" },
        { "key": "battery.charge_pct",      "label": "Battery",      "unit": "%" },
        { "key": "battery.voltage_v",       "label": "Voltage",      "unit": "V" }
      ]
    },
    {
      "title": "COMM",
      "fields": [
        { "key": "comm.frequency_mhz",     "label": "Frequency",    "unit": "MHz" },
        { "key": "comm.tx_power_dbm",      "label": "TX Power",     "unit": "dBm" },
        { "key": "transponder.status",     "label": "Transponder" }
      ]
    },
    {
      "title": "ADCS",
      "fields": [
        { "key": "adcs.mode",              "label": "Mode" },
        { "key": "adcs.pointing_accuracy_deg", "label": "Pointing", "unit": "deg" }
      ]
    },
    {
      "title": "OBC",
      "fields": [
        { "key": "obc.firmware",           "label": "Firmware" },
        { "key": "obc.uptime_s",           "label": "Uptime",       "unit": "s" }
      ]
    }
  ]
}
```

#### `c2protocol.json`

Command & control packet format:
```json
{
  "protocol": "custom",
  "modulation": "OOK",
  "baud_rate": 100,
  "packet_format": {
    "preamble": "0xAA 0xAA 0xAA",
    "sync_word": "0xD3 0x91",
    "fields": ["opcode (1 byte)", "payload (N bytes)", "crc8"]
  },
  "opcodes": {
    "0x01": { "name": "ping",            "payloadSize": 0  },
    "0x10": { "name": "set_tx_power",    "payloadSize": 1  },
    "0x20": { "name": "repoint_antenna", "payloadSize": 8  },
    "0xF0": { "name": "reboot",          "payloadSize": 0  }
  }
}
```

#### `decoder.py`

Uplink IQ command decoder (called by Electron when transmitting):
```python
#!/usr/bin/env python3
"""Decode uplink command IQ file for MYSAT-1."""
import sys, json, numpy as np

def decode(filepath, sample_rate):
    iq = np.fromfile(filepath, dtype=np.complex64)
    # Your demodulation logic here (OOK, FSK, LoRa, etc.)
    # Return JSON with success/command/opcode/payload
    return {"success": True, "command": "ping", "opcode": "0x01", "payload": ""}

if __name__ == "__main__":
    result = decode(sys.argv[1], int(sys.argv[2]))
    print(json.dumps(result))
```

### Step 5 — Verify

```bash
npm run electron
```

Select your satellite from the dropdown, load the `.cf32` file, and the signal should appear on the waterfall.

---

## File Reference

| File | Purpose |
|------|---------|
| `src/data/satellites.js` | RF parameters (frequency, EIRP, sample rate, polarization, uplink) |
| `electron/config.js` | Electron config (frequency Hz, file hash, uplink flags) |
| `tle.txt` | Orbital elements for SGP4 tracking |
| `satellites/<name>/hardware.json` | Subsystem definitions and initial telemetry values |
| `satellites/<name>/panel.json` | Telemetry panel UI layout |
| `satellites/<name>/c2protocol.json` | Command protocol definition |
| `satellites/<name>/decoder.py` | Uplink IQ demodulator (Python) |

## Antenna Types

| Type | Beamwidth | Gain | Polarization | Best for |
|------|-----------|------|-------------|----------|
| Yagi | 25 deg | +6 dB | Linear | VHF/UHF LEO passes |
| Dish (0.75m) | 3 deg | +24 dB | Linear | L/S/Ku-band (feed-dependent) |
| Dipole | 360 deg | -8 dB | Linear | Omnidirectional monitoring |
| Helix | 40 deg | +5 dB | RHCP | Circularly polarized satellites |

## Dish Feed Types

The dish antenna supports three interchangeable feeds:

| Feed | Frequency Range | Use case |
|------|----------------|----------|
| L-band | 1.5 - 1.8 GHz | HRPT weather, GPS |
| S-band | 2.0 - 2.5 GHz | Deep space, telemetry |
| Ku-band | 10.7 - 12.7 GHz | GEO TV, broadband (requires LNB) |

## GPredict Integration

1. Set **Rotator** host to `localhost`, port `4533`
2. Set **Radio** host to `localhost`, port `4532`
3. OpenVSA auto-syncs antenna azimuth/elevation and radio frequency
4. Ground station location is read from GPredict `.qth` files automatically

## Polarization

OpenVSA models polarization mismatch between satellite and antenna:

| Satellite | Antenna | Loss |
|-----------|---------|------|
| Linear | Linear | 0 dB |
| RHCP | RHCP | 0 dB |
| RHCP | Linear | -3 dB |
| Linear | RHCP | -3 dB |
| RHCP | LHCP | -60 dB (blocked) |
