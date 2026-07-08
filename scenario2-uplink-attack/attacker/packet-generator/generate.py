#!/usr/bin/env python3
"""
DEMOSAT Uplink Command Generator — CLI  (CCSDS TC over OOK)

Thin wrapper over the canonical codec (openvsa-plugin/demosat/ccsds_ook.py).
Builds an OOK-modulated cf32 IQ file that OpenVSA's decoder.py can decode.

Examples:
    python3 generate.py adcs_torque --torque 999 -o attack.cf32   # ★ main scenario
    python3 generate.py solar_panel --angle 0    -o attack.cf32
    python3 generate.py obc_reboot               -o attack.cf32
"""
import os
import sys
import json
import argparse

# import canonical codec from the plugin dir
_PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "openvsa-plugin", "demosat")
sys.path.insert(0, os.path.abspath(_PLUGIN))
import ccsds_ook as codec  # noqa: E402


def main():
    proto = codec.load_protocol()
    commands = [v["name"] for v in proto["opcodes"].values()]

    ap = argparse.ArgumentParser(description="DEMOSAT uplink command generator (CCSDS TC over OOK)")
    ap.add_argument("command", choices=commands, help="command name")
    ap.add_argument("-o", "--out", default="attack.cf32", help="output cf32 path")
    ap.add_argument("--torque", type=int, help="adcs_torque: reaction-wheel torque (mNm, int16)")
    ap.add_argument("--angle", type=int, help="solar_panel: panel angle (0-255)")
    ap.add_argument("--az", type=int, help="antenna_gimbal: azimuth")
    ap.add_argument("--el", type=int, help="antenna_gimbal: elevation")
    ap.add_argument("--bitmask", type=int, help="subsystem_ctrl: bitmask")
    ap.add_argument("--on", action="store_true", help="transponder_ctrl: turn on")
    ap.add_argument("--raw", help="generic hex payload")
    ap.add_argument("--seq", type=int, default=0, help="frame/packet sequence number")
    args = ap.parse_args()

    params = {k: v for k, v in vars(args).items()
              if k in ("torque", "angle", "az", "el", "bitmask", "on", "raw") and v not in (None, False)}

    iq, breakdown = codec.build_iq(args.command, params, seq=args.seq, proto=proto)
    codec.write_cf32(args.out, iq)

    # safe-torque advisory for the main scenario
    warn = ""
    if args.command == "adcs_torque":
        meta = proto["opcodes"]["0x21"]
        limit = meta.get("safeAbsMax", 500)
        if args.torque is not None and abs(args.torque) > limit:
            warn = f"  ⚠ EXCEEDS SAFE TORQUE ({limit} mNm) — satellite will tumble"

    print(f"✓ Wrote {args.out}  ({breakdown['sampleCount']} samples, {breakdown['durationSec']}s)")
    print(f"  command={args.command} opcode={breakdown['opcode']} apid={breakdown['apid']}")
    print(f"  frame={' '.join(f'{b:02X}' for b in breakdown['frameBytes'])}")
    if warn:
        print(warn)


if __name__ == "__main__":
    main()
