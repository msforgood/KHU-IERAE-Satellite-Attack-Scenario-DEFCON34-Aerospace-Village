#!/usr/bin/env python3
"""
ENIGMA-1 Uplink Command Generator — CLI  (CCSDS TC over OOK)

Thin wrapper over the canonical codec (openvsa-plugin/demosat/ccsds_ook.py).
Builds an OOK-modulated cf32 IQ file that OpenVSA's decoder.py can decode.

Examples:
    python3 generate.py orbit_maneuver --prograde 40 --radial 0 -o attack.cf32   # ★ main scenario
    python3 generate.py adcs_torque --torque 999 -o attack.cf32
    python3 generate.py obc_reboot               -o attack.cf32
"""
import os
import sys
import json
import argparse

# import canonical codec from the plugin dir
_PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "openvsa-plugin", "demosat")
sys.path.insert(0, os.path.abspath(_PLUGIN))
import ccsds_ook as codec  # noqa: E402


def main():
    proto = codec.load_protocol()
    commands = [v["name"] for v in proto["opcodes"].values()]

    ap = argparse.ArgumentParser(description="ENIGMA-1 uplink command generator (CCSDS TC over OOK)")
    ap.add_argument("command", choices=commands, help="command name")
    ap.add_argument("-o", "--out", default="attack.cf32", help="output cf32 path")
    ap.add_argument("--alt", type=float, dest="altKm", help="orbit_maneuver: target altitude (km)")
    ap.add_argument("--inc", type=float, help="orbit_maneuver: target inclination (deg)")
    ap.add_argument("--raan", type=float, help="orbit_maneuver: target RAAN (deg)")
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
              if k in ("altKm", "inc", "raan", "torque", "angle", "az", "el", "bitmask", "on", "raw") and v not in (None, False)}

    iq, breakdown = codec.build_iq(args.command, params, seq=args.seq, proto=proto)
    codec.write_cf32(args.out, iq)

    warn = ""
    if args.command == "orbit_maneuver":
        warn = f"  ⚠ Orbit maneuver: alt={args.altKm}km inc={args.inc}deg raan={args.raan}deg — abused, this can hit a neighbour"

    print(f"✓ Wrote {args.out}  ({breakdown['sampleCount']} samples, {breakdown['durationSec']}s)")
    print(f"  command={args.command} opcode={breakdown['opcode']} apid={breakdown['apid']}")
    print(f"  frame={' '.join(f'{b:02X}' for b in breakdown['frameBytes'])}")
    if warn:
        print(warn)


if __name__ == "__main__":
    main()
