#!/usr/bin/env python3
"""
Roundtrip test: generator (build_iq) → decoder (decode_iq) must recover the
exact command + payload, and the frame CRC must validate. This is the contract
that keeps the Python generator and OpenVSA's decoder.py byte-compatible.

Run:  python3 tests/test_roundtrip.py
"""
import os
import sys

_PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "openvsa-plugin", "demosat")
sys.path.insert(0, os.path.abspath(_PLUGIN))
import ccsds_ook as codec  # noqa: E402

CASES = [
    ("orbit_maneuver",  {"altKm": 600, "inc": 63, "raan": 70}, ["0x02", "0x58", "0x02", "0x76", "0x02", "0xbc"]),
    ("orbit_maneuver",  {"altKm": 600, "inc": 34, "raan": 5},  ["0x02", "0x58", "0x01", "0x54", "0x00", "0x32"]),
    ("adcs_torque",     {"torque": 999},   ["0x03", "0xe7"]),
    ("adcs_torque",     {"torque": -1000}, ["0xfc", "0x18"]),
    ("adcs_torque",     {"torque": 0},     ["0x00", "0x00"]),
    ("solar_panel",     {"angle": 0},      ["0x00"]),
    ("solar_panel",     {"angle": 200},    ["0xc8"]),
    ("antenna_gimbal",  {"az": 120, "el": 30}, ["0x78", "0x1e"]),
    ("subsystem_ctrl",  {"bitmask": 0},    ["0x00"]),
    ("transponder_ctrl", {"on": False},    ["0x00"]),
    ("obc_reboot",      {},                []),
]


def run():
    failures = 0
    for command, params, expect_payload in CASES:
        iq, breakdown = codec.build_iq(command, params)
        result = codec.decode_iq(iq)
        ok = (result.get("success")
              and result.get("command") == command
              and result.get("payload") == expect_payload)
        status = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"[{status}] {command:16} {params}")
        if not ok:
            print(f"        expected payload={expect_payload}")
            print(f"        got     {result}")

    # negative case: corrupted frame bits should fail cleanly, not crash.
    # Force a mid-signal band ON (=1.0) to flip frame bits → CRC mismatch.
    # (indices chosen to land inside the frame, past the lead-in silence)
    iq, _ = codec.build_iq("adcs_torque", {"torque": 500})
    iq[5000:7000] = 1.0
    corrupt = codec.decode_iq(iq)
    neg_ok = corrupt.get("success") is False
    print(f"[{'PASS' if neg_ok else 'FAIL'}] corrupted-frame rejected → {corrupt.get('error', '')[:50]}")
    if not neg_ok:
        failures += 1

    print(f"\n{'ALL PASSED' if failures == 0 else str(failures) + ' FAILED'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    run()
