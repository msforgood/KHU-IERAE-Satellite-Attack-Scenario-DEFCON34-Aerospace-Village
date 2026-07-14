#!/usr/bin/env python3
"""
PUPPET-2 Uplink Command Decoder

OOK envelope demodulator + C2 packet parser. Called by VSA's Electron main
process (decode-uplink). Outputs JSON to stdout.

PUPPET-2 authenticates nothing: any packet with a valid preamble, length, known
opcode, and correct CRC-8 is accepted and executed. A single IQ file may carry
several packets back-to-back (e.g. adcs_mode=manual then adcs_target); every one
is decoded and returned in `commands`, executed in order by VSA.

Packet:  [0xAA 0xAA][length][opcode][payload][CRC-8]   (OOK, 100 baud, 24 kSps)
Usage:   python3 decoder.py <input.cf32> [sample_rate]
"""

import sys
import json
import numpy as np

BAUD_RATE = 100
PREAMBLE = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]  # 0xAA 0xAA


def crc8(data, poly=0x07, init=0x00):
    crc = init
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def resolve_command(opcode, payload):
    """Map opcode (+payload) to the effect name VSA's state engine expects."""
    if opcode == 0x01:
        return "ping"
    if opcode == 0x04:
        return "obc_reboot"
    if opcode == 0x14:  # adcs_mode
        return "adcs_idle" if (payload and payload[0] == 0x00) else "adcs_manual"
    if opcode == 0x15:
        return "adcs_target"
    if opcode == 0x18:
        return "transponder_ctrl"
    return None


def result(success, **kwargs):
    print(json.dumps({"success": success, **kwargs}))
    sys.exit(0)


def ook_to_bits(iq, samp_rate):
    spb = samp_rate // BAUD_RATE
    env = np.abs(iq)
    if env.max() < 0.01:
        return []
    thr = env.max() * 0.3
    raw = (env > thr).astype(int)
    n = len(raw) // spb
    bits = []
    for i in range(n):
        s = i * spb + spb // 4
        e = i * spb + 3 * spb // 4
        bits.append(1 if raw[s:e].mean() > 0.5 else 0)
    return bits


def parse_packet_at(bits, start):
    """Parse a packet whose preamble begins at bit `start`.
    Returns (command_dict, next_bit_index) or (None, start+1)."""
    nbytes = (len(bits) - start) // 8
    by = []
    for j in range(nbytes):
        v = 0
        for k in range(8):
            v = (v << 1) | bits[start + j * 8 + k]
        by.append(v)
    if len(by) < 4 or by[0] != 0xAA or by[1] != 0xAA:
        return None, start + 1
    length = by[2]
    if 3 + length + 1 > len(by):
        return None, start + 1
    body = by[3:3 + length]
    rx_crc = by[3 + length]
    if crc8(by[0:3 + length]) != rx_crc:
        return None, start + 1
    if length < 1:
        return None, start + 1
    opcode = body[0]
    payload = body[1:]
    cmd = resolve_command(opcode, payload)
    if cmd is None:
        return None, start + 1
    packet_bits = (3 + length + 1) * 8
    return ({
        "command": cmd,
        "opcode": f"0x{opcode:02x}",
        "payload": [f"0x{b:02x}" for b in payload],
    }, start + packet_bits)


def decode(path, samp_rate=24000):
    try:
        data = np.fromfile(path, dtype=np.float32)
    except Exception as e:
        result(False, error=f"Failed to read file: {e}")
    if len(data) < 100:
        result(False, error="File too short — not enough samples")

    iq = data[0::2] + 1j * data[1::2]
    bits = ook_to_bits(iq, samp_rate)
    if not bits:
        result(False, error="No signal detected — file appears to be silence")

    commands = []
    i = 0
    N = len(bits)
    while i <= N - len(PREAMBLE):
        if bits[i:i + len(PREAMBLE)] == PREAMBLE:
            cmd, nxt = parse_packet_at(bits, i)
            if cmd:
                commands.append(cmd)
                i = nxt          # jump past the packet (skip in-payload false preambles)
                continue
        i += 1

    if not commands:
        result(False, error="No valid packet found — check modulation (OOK, 100 baud), CRC-8, and opcode")

    last = commands[-1]
    result(True,
           command=last["command"],
           opcode=last["opcode"],
           payload=last["payload"],
           commands=commands,
           message=f"{len(commands)} command(s): " + ", ".join(c["command"] for c in commands))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python3 decoder.py <input.cf32> [sample_rate]"}))
        sys.exit(1)
    filepath = sys.argv[1]
    samp_rate = int(sys.argv[2]) if len(sys.argv) > 2 else 24000
    decode(filepath, samp_rate)
