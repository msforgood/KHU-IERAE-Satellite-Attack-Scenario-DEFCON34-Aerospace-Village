#!/usr/bin/env python3
"""
ENIGMA-1 Uplink Command Decoder  (CCSDS TC over OOK)

Called by OpenVSA's Electron main process:
    python3 decoder.py <input.cf32> [sample_rate]
Outputs a single JSON line to stdout (docs/command-spec.md §5).

Thin wrapper over the canonical codec (ccsds_ook.py, same directory) so the
decoder is the exact inverse of the packet generator. Requires numpy.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ccsds_ook import decode_iq  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: decoder.py <input.cf32> [sample_rate]"}))
        sys.exit(1)
    filepath = sys.argv[1]
    samp_rate = int(sys.argv[2]) if len(sys.argv) > 2 else 24000
    print(json.dumps(decode_iq(filepath, samp_rate)))
    sys.exit(0)


if __name__ == "__main__":
    main()
