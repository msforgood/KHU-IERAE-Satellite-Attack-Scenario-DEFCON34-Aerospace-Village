#!/usr/bin/env python3
"""
generate_downlink.py - ENIGMA-1 downlink IQ (cf32) generator.

Encodes an arbitrary image into a GFSK/AX.25/G3RUH 9600 baud IQ file that
enigma1_decoder.grc can demodulate as-is (= the exact inverse of the decoder chain).

Decoder chain:  slice -> nrzi_decode -> descrambler_bb(0x21,0,16) -> hdlc_deframer
Encoder chain:  hdlc_framer_pb -> scrambler_bb(0x21,0,16) -> nrzi_encode -> GFSK

Frame format (matches the reassembly block):
  Image 192x128 grayscale('L') raw (24576B)
    -> zlib.compress -> [4B BE length][compressed data] = payload
    -> split payload into CHUNK-sized pieces, prefix each chunk with [2B BE seq]
    -> AX.25 UI frame = [dest7][src7][ctrl 0x03][pid 0xF0][2B seq][chunk]
    -> HDLC (FCS/bit stuffing/7E) -> G3RUH scramble -> NRZI -> GFSK(dev 2400, 10 sps) @ 96 kSps

Warning: runtime environment: gnuradio + gr-satellites are required, so run inside the gnuradio-web container.
  e.g.) docker cp military-airbase.png <gnuradio-container>:/tmp/in.png
      docker cp postProcess/generate_downlink.py <gnuradio-container>:/tmp/gen.py
      docker exec -i <gnuradio-container> python3 /tmp/gen.py /tmp/in.png /tmp/enigma34_downlink.cf32
      docker cp <gnuradio-container>:/tmp/enigma34_downlink.cf32 ./enigma34_downlink.cf32

Usage:  python3 generate_downlink.py <input image> <output.cf32> [--reps N] [--chunk B]
"""
import argparse
import struct
import time
import zlib

import numpy as np
import pmt
from PIL import Image
from gnuradio import blocks, digital, gr
from satellites import nrzi_encode

FS = 96000        # sample rate (start.sh patches grc samp_rate 0.05e6 -> 0.096e6)
BAUD = 9600
DEV = 2400        # deviation (h = 2*dev/baud = 0.5, GFSK BT=0.5)
SPS = FS // BAUD  # 10
IMG_W, IMG_H = 192, 128


def ax25_addr(call, ssid, last):
    """AX.25 address, 7 bytes (callsign<<1 + SSID, extension bit if last)."""
    call = (call.upper() + '      ')[:6]
    return bytes([ord(c) << 1 for c in call]) + \
        bytes([0x60 | ((ssid & 0xf) << 1) | (1 if last else 0)])


def build_frames(img_path, chunk):
    raw = Image.open(img_path).convert('L').resize((IMG_W, IMG_H)).tobytes()
    assert len(raw) == IMG_W * IMG_H
    comp = zlib.compress(raw, 9)
    payload = struct.pack('>I', len(comp)) + comp
    header = ax25_addr('ENIGMA', 1, False) + ax25_addr('GRND', 0, True) + bytes([0x03, 0xF0])
    assert len(header) == 16
    frames = [header + struct.pack('>H', seq) + payload[off:off + chunk]
              for seq, off in enumerate(range(0, len(payload), chunk))]
    return frames, len(comp)


def frames_to_txbits(frames, reps):
    """hdlc_framer_pb -> scrambler_bb -> nrzi_encode (the exact inverse of the decoder)."""
    tb = gr.top_block()
    framer = digital.hdlc_framer_pb('packet_len')
    scr = digital.scrambler_bb(0x21, 0, 16)
    nrzi = nrzi_encode()
    snk = blocks.vector_sink_b()
    tb.connect(framer, scr, nrzi, snk)
    tb.start()
    for _ in range(reps):           # repeat several times -> compensate for frames lost during initial lock/sync
        for fr in frames:
            framer.to_basic_block()._post(
                pmt.intern('in'),
                pmt.cons(pmt.PMT_NIL, pmt.init_u8vector(len(fr), list(fr))))
        time.sleep(0.08)
    time.sleep(0.8)
    tb.stop()
    tb.wait()
    return np.array(snk.data(), dtype=np.float32)


def gfsk_modulate(txbits):
    syms = txbits * 2 - 1                       # 0 -> -1, 1 -> +1
    up = np.repeat(syms, SPS)
    sigma = np.sqrt(np.log(2)) / (2 * np.pi * 0.5)      # BT=0.5 gaussian
    t = np.arange(-3 * SPS, 3 * SPS + 1) / SPS
    h = np.exp(-t ** 2 / (2 * sigma ** 2)); h /= h.sum()
    shaped = np.convolve(up, h, 'same')
    phase = 2 * np.pi * (DEV / FS) * np.cumsum(shaped)
    iq = np.exp(1j * phase).astype(np.complex64)
    pre = (0.05 * (np.random.randn(3000) + 1j * np.random.randn(3000))).astype(np.complex64)
    return np.concatenate([pre, iq, pre])       # lead-in for AGC/clock settling


def main():
    ap = argparse.ArgumentParser(description='ENIGMA-1 downlink cf32 generator')
    ap.add_argument('image')
    ap.add_argument('out_cf32')
    ap.add_argument('--reps', type=int, default=2, help='frame burst repetitions (default 2)')
    ap.add_argument('--chunk', type=int, default=200, help='AX.25 info chunk bytes (default 200)')
    a = ap.parse_args()

    frames, comp_len = build_frames(a.image, a.chunk)
    print(f'image={a.image}  compressed={comp_len}B  frames={len(frames)}  reps={a.reps}')
    txbits = frames_to_txbits(frames, a.reps)
    out = gfsk_modulate(txbits)
    out.tofile(a.out_cf32)
    print(f'WROTE {a.out_cf32}  samples={len(out)}  dur={len(out)/FS:.2f}s  bytes={out.nbytes}')


if __name__ == '__main__':
    main()
