#!/usr/bin/env python3
"""
ccsds_ook.py — CCSDS TC + OOK codec (single source of truth)

Canonical shared codec for Scenario 2. Ships inside the OpenVSA plugin so that
decoder.py can run self-contained, and is imported by the packet-generator
(CLI + web UI). Encoder and decoder are exact inverses; the roundtrip test in
packet-generator/tests/ enforces it.

Spec: docs/command-spec.md   ·   Opcode table: c2protocol.json (same dir)

Layers (encode top→bottom, decode bottom→top):
  command (opcode+payload)
    → CCSDS Space Packet   (6B primary header + data field)
    → CCSDS TC Transfer Frame (5B primary header + data + 2B CRC-16 FECF)
    → preamble + bitstream (MSB-first)
    → OOK modulation → cf32 (float32 interleaved I/Q)
"""
import os
import json
import struct
import numpy as np

# ── Defaults (mirrored from c2protocol.json) ───────────────────────────────
BAUD_RATE       = 100
SAMPLE_RATE     = 24000
PREAMBLE        = b"\xAA\xAA"
LEADIN_BITS     = 8          # integer bit-cells of silence (keeps decode grid aligned)
LEADOUT_BITS    = 4
ON_AMPLITUDE    = 1.0

SPACECRAFT_ID   = 200        # DEMOSAT
VIRTUAL_CHANNEL = 0

_PROTOCOL_CACHE = None


def load_protocol(path=None):
    """Load c2protocol.json (opcode table etc.). Cached."""
    global _PROTOCOL_CACHE
    if _PROTOCOL_CACHE is not None and path is None:
        return _PROTOCOL_CACHE
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "c2protocol.json")
    with open(path) as f:
        proto = json.load(f)
    if path is None or _PROTOCOL_CACHE is None:
        _PROTOCOL_CACHE = proto
    return proto


def opcode_table(proto=None):
    """{opcode_int: {name, apid, payloadSize, ...}}"""
    proto = proto or load_protocol()
    return {int(k, 16): {**v, "opcode": int(k, 16)} for k, v in proto["opcodes"].items()}


def name_to_opcode(proto=None):
    return {v["name"]: k for k, v in opcode_table(proto).items()}


# ── CRC-16-CCITT (poly 0x1021, init 0xFFFF) — CCSDS FECF ────────────────────
def crc16_ccitt(data, init=0xFFFF):
    crc = init
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc & 0xFFFF


# ── Payload encoders (named fields → bytes) ────────────────────────────────
def build_payload(command, params):
    """Encode a command's payload from human params. Returns (bytes, sub_fields)."""
    p = params or {}
    if command == "adcs_torque":
        torque = int(p.get("torque", 0))
        torque = max(-32768, min(32767, torque))
        return struct.pack(">h", torque), [{"name": "torque", "value": torque, "unit": "mNm"}]
    if command == "solar_panel":
        angle = int(p.get("angle", 90)) & 0xFF
        return bytes([angle]), [{"name": "angle", "value": angle, "unit": "deg"}]
    if command == "antenna_gimbal":
        az = int(p.get("az", 0)) & 0xFF
        el = int(p.get("el", 0)) & 0xFF
        return bytes([az, el]), [{"name": "az", "value": az}, {"name": "el", "value": el}]
    if command == "subsystem_ctrl":
        mask = int(p.get("bitmask", 0)) & 0xFF
        return bytes([mask]), [{"name": "bitmask", "value": f"0b{mask:08b}"}]
    if command == "transponder_ctrl":
        on = 1 if p.get("on", False) else 0
        return bytes([on]), [{"name": "state", "value": "ON" if on else "OFF"}]
    if command == "obc_reboot":
        return b"", []
    # generic: raw hex payload
    raw = p.get("raw", b"")
    if isinstance(raw, str):
        raw = bytes.fromhex(raw) if raw else b""
    return bytes(raw), [{"name": "raw", "value": raw.hex()}]


# ── CCSDS Space Packet (6B primary header + data field) ─────────────────────
def build_space_packet(opcode, payload, apid, seq_count=0):
    data_field = bytes([opcode]) + payload
    data_len_field = len(data_field) - 1                 # CCSDS: (octets - 1)
    b0 = (0 << 5) | (1 << 4) | (0 << 3) | ((apid >> 8) & 0x07)   # ver=0,type=1(TC),sec=0,APID hi
    b1 = apid & 0xFF
    b2 = (0b11 << 6) | ((seq_count >> 8) & 0x3F)         # seq flags=11 (unsegmented)
    b3 = seq_count & 0xFF
    header = bytes([b0, b1, b2, b3, (data_len_field >> 8) & 0xFF, data_len_field & 0xFF])
    return header, data_field


def parse_space_packet(sp):
    if len(sp) < 7:
        raise ValueError("Space packet too short")
    apid = ((sp[0] & 0x07) << 8) | sp[1]
    data_len = ((sp[4] << 8) | sp[5]) + 1
    data_field = sp[6:6 + data_len]
    if len(data_field) < 1:
        raise ValueError("Empty space packet data field")
    opcode = data_field[0]
    payload = data_field[1:]
    return {"apid": apid, "opcode": opcode, "payload": payload}


# ── CCSDS TC Transfer Frame (5B primary header + data + 2B CRC FECF) ─────────
def build_tc_frame(space_packet, scid=SPACECRAFT_ID, vcid=VIRTUAL_CHANNEL, frame_seq=0):
    total_len = 5 + len(space_packet) + 2                # header + data + FECF
    frame_len_field = total_len - 1                      # CCSDS: (octets - 1)
    o0 = (0 << 6) | (1 << 5) | (0 << 4) | (0 << 2) | ((scid >> 8) & 0x03)  # ver,bypass=1,ctrl=0,spare,SCID hi(2)
    o1 = scid & 0xFF
    o2 = ((vcid & 0x3F) << 2) | ((frame_len_field >> 8) & 0x03)
    o3 = frame_len_field & 0xFF
    o4 = frame_seq & 0xFF
    header = bytes([o0, o1, o2, o3, o4])
    body = header + space_packet
    fecf = crc16_ccitt(body)
    return header, bytes([(fecf >> 8) & 0xFF, fecf & 0xFF])


def parse_tc_frame(frame):
    if len(frame) < 5 + 7 + 2:
        raise ValueError("TC frame too short")
    scid = ((frame[0] & 0x03) << 8) | frame[1]
    frame_len = (((frame[2] & 0x03) << 8) | frame[3]) + 1
    frame = frame[:frame_len]                            # trim to declared length
    if len(frame) < frame_len:
        raise ValueError("TC frame truncated vs declared length")
    body, fecf = frame[:-2], frame[-2:]
    recv_crc = (fecf[0] << 8) | fecf[1]
    calc_crc = crc16_ccitt(body)
    if recv_crc != calc_crc:
        raise ValueError(f"Frame CRC mismatch — recv 0x{recv_crc:04x}, calc 0x{calc_crc:04x}")
    space_packet = body[5:]
    return {"scid": scid, "space_packet": space_packet}


# ── OOK modulation / demodulation ──────────────────────────────────────────
def bytes_to_bits(data):
    bits = []
    for byte in data:
        for k in range(7, -1, -1):
            bits.append((byte >> k) & 1)
    return bits


def bits_to_bytes(bits):
    out = []
    for j in range(0, len(bits) - 7, 8):
        byte = 0
        for k in range(8):
            byte = (byte << 1) | bits[j + k]
        out.append(byte)
    return bytes(out)


def modulate_ook(frame_full, sample_rate=SAMPLE_RATE, baud=BAUD_RATE,
                 preamble=PREAMBLE, leadin_bits=LEADIN_BITS, leadout_bits=LEADOUT_BITS):
    spb = sample_rate // baud
    bits = [0] * leadin_bits + bytes_to_bits(preamble + frame_full) + [0] * leadout_bits
    iq = np.zeros(len(bits) * spb, dtype=np.complex64)
    for i, bit in enumerate(bits):
        if bit:
            iq[i * spb:(i + 1) * spb] = ON_AMPLITUDE
    # interleave I/Q as float32
    out = np.empty(iq.size * 2, dtype=np.float32)
    out[0::2] = iq.real
    out[1::2] = iq.imag
    return out


def demodulate_ook(iq_f32, sample_rate=SAMPLE_RATE, baud=BAUD_RATE, preamble=PREAMBLE):
    data = np.asarray(iq_f32, dtype=np.float32)
    iq = data[0::2] + 1j * data[1::2]
    spb = sample_rate // baud
    envelope = np.abs(iq)
    max_env = float(np.max(envelope)) if envelope.size else 0.0
    if max_env < 0.01:
        raise ValueError("No signal detected — file appears to be silence")
    threshold = max_env * 0.5
    num_bits = len(envelope) // spb
    bits = []
    for i in range(num_bits):
        s = i * spb + spb // 4
        e = i * spb + 3 * spb // 4
        bits.append(1 if np.mean(envelope[s:e] > threshold) > 0.5 else 0)
    pre_bits = bytes_to_bits(preamble)
    for i in range(len(bits) - len(pre_bits)):
        if bits[i:i + len(pre_bits)] == pre_bits:
            frame_bits = bits[i + len(pre_bits):]
            return bits_to_bytes(frame_bits)
    raise ValueError("No preamble found — check modulation (OOK, 100 baud) and preamble")


# ── High level ─────────────────────────────────────────────────────────────
def build_iq(command, params=None, seq=0, proto=None, sample_rate=SAMPLE_RATE):
    """command name + params → (iq_float32, breakdown dict for UI)."""
    proto = proto or load_protocol()
    n2o = name_to_opcode(proto)
    if command not in n2o:
        raise ValueError(f"Unknown command: {command}")
    opcode = n2o[command]
    apid = int(proto["opcodes"][f"0x{opcode:02X}"]["apid"], 16)
    payload, sub = build_payload(command, params)

    sp_header, sp_data = build_space_packet(opcode, payload, apid, seq_count=seq)
    space_packet = sp_header + sp_data
    tc_header, fecf = build_tc_frame(space_packet, frame_seq=seq)
    frame_full = tc_header + space_packet + fecf
    iq = modulate_ook(frame_full, sample_rate=sample_rate)

    segments = [
        {"field": "preamble",  "label": "Preamble (bit sync)",        "bytes": list(PREAMBLE)},
        {"field": "tc_header", "label": "CCSDS TC Frame Header (5B)",  "bytes": list(tc_header),
         "sub": [{"name": "SCID", "value": SPACECRAFT_ID}, {"name": "VCID", "value": VIRTUAL_CHANNEL},
                 {"name": "FrameSeq", "value": seq}]},
        {"field": "sp_header", "label": "CCSDS Space Packet Header (6B)", "bytes": list(sp_header),
         "sub": [{"name": "APID", "value": f"0x{apid:03X}"}, {"name": "Type", "value": "TC"}]},
        {"field": "opcode",    "label": "Opcode",                      "bytes": [opcode],
         "sub": [{"name": "command", "value": command}]},
        {"field": "payload",   "label": "Payload",                    "bytes": list(payload), "sub": sub},
        {"field": "crc",       "label": "Frame CRC-16 (FECF)",        "bytes": list(fecf)},
    ]
    breakdown = {
        "command": command, "opcode": f"0x{opcode:02X}", "apid": f"0x{apid:03X}",
        "segments": segments,
        "frameBytes": list(PREAMBLE + frame_full),
        "sampleCount": iq.size // 2,
        "durationSec": round((iq.size // 2) / sample_rate, 3),
    }
    return iq, breakdown


def write_cf32(path, iq_f32):
    np.asarray(iq_f32, dtype=np.float32).tofile(path)


def read_cf32(path):
    return np.fromfile(path, dtype=np.float32)


def decode_iq(source, sample_rate=SAMPLE_RATE, proto=None):
    """source: cf32 path or float32 array → result dict (docs/command-spec.md §5)."""
    proto = proto or load_protocol()
    o2meta = opcode_table(proto)
    try:
        data = read_cf32(source) if isinstance(source, str) else np.asarray(source, dtype=np.float32)
        if data.size < 100:
            return {"success": False, "error": "File too short — not enough samples"}
        frame = demodulate_ook(data, sample_rate=sample_rate)
        tc = parse_tc_frame(frame)
        sp = parse_space_packet(tc["space_packet"])
        opcode = sp["opcode"]
        if opcode not in o2meta:
            return {"success": False, "error": f"Unknown opcode 0x{opcode:02x}"}
        command = o2meta[opcode]["name"]
        return {
            "success": True,
            "command": command,
            "opcode": f"0x{opcode:02x}",
            "apid": f"0x{sp['apid']:03x}",
            "payload": [f"0x{b:02x}" for b in sp["payload"]],
            "message": f"Command accepted: {command}",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
