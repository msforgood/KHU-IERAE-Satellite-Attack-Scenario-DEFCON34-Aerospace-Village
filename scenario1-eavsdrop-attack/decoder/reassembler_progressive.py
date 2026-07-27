"""
Embedded Python Block: ENIGMA-1 progressive, repeat-aware, offset-shearing reassembler.

Orders AX.25 Info chunks by sequence and STREAMING-inflates the in-order prefix so the
image appears progressively (row by row) as it decodes, and keeps re-decoding on every
repeat burst so the web shows a continuously updating picture.

B2 EFFECT (center-frequency skew): the flow's startup measures the recording's residual
center-frequency offset and writes it to  <out_dir>/offset.txt  (normalized, cycles/sample).
This block reads that value and applies a PROGRESSIVE HORIZONTAL SHEAR proportional to it:
  - offset ~ 0 (correctly tuned)  -> shear 0  -> image comes out straight (original);
  - larger offset                 -> stronger diagonal slant (like a mistuned analog frame).
So the OUTPUT depends on the INPUT file: a centered capture decodes straight, an off-center
capture decodes visibly slanted, and the slant grows with the measured offset (and its sign
sets the direction). The shear is applied to whatever has decoded so far, so the slant builds
up live as the picture fills in.

Progress line: "decoded total done reps".
"""
import os
import time
import struct
import zlib
import pmt
from gnuradio import gr


class blk(gr.sync_block):
    def __init__(self, img_w=486, img_h=320, out_path='/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution/enigma1_recovered.png'):
        gr.sync_block.__init__(self, name='ENIGMA-1 Image Reassembler', in_sig=[], out_sig=[])
        self.message_port_register_in(pmt.intern('frame'))          # ax25_deframer(out) -> frames are received on this port
        self.set_msg_handler(pmt.intern('frame'), self.handle)
        self.w, self.h = int(img_w), int(img_h)
        self.out_path = out_path
        self.prog_path = out_path.rsplit('.', 1)[0] + '_progress.txt'
        self.off_path = os.path.join(os.path.dirname(out_path), 'offset.txt')
        self.chunks = {}
        self.last_seq = -1
        self.reps = 0
        self.decoded = 0
        self.done_flag = False
        self.last_prog = 0.0
        # Persistent image buffer: instead of resetting to black each pass, we overwrite on top of it. It is also saved to disk so
        # that after a watchdog restart (new process) the previous image is carried over, completely removing the black flicker.
        self.persist_path = os.path.join(os.path.dirname(out_path), 'persist.raw')
        self.persist = self._load_persist()

    def _load_persist(self):
        try:
            data = open(self.persist_path, 'rb').read()
            if len(data) == self.w * self.h:
                return bytearray(data)
        except Exception:
            pass
        return bytearray(self.w * self.h)

    def _read_offset(self):
        """Center-frequency offset (normalized cyc/sample). Written to offset.txt when the flow starts. Returns 0 if absent."""
        try:
            return float(open(self.off_path).read().strip())
        except Exception:
            return 0.0

    def _progress(self):
        try:
            with open(self.prog_path + '.tmp', 'w') as fh:
                fh.write('%d %d %d %d' % (self.decoded, self.w * self.h, 1 if self.done_flag else 0, self.reps))
            os.replace(self.prog_path + '.tmp', self.prog_path)
        except Exception:
            pass

    def _shear(self, buf):
        """B2: proportional to the measured offset, each row is shifted horizontally a bit more, producing a diagonal shear.
        Offset 0 -> shift 0 (original). The larger |offset| is, the more it slants, and the sign sets the direction."""
        off = self._read_offset()
        GAIN = 18.0
        frac = max(-0.6, min(0.6, off * GAIN))        # shift amount of the bottom row (as a fraction of the width)
        if abs(frac) < 0.003:
            return buf                                # center is on target -> original left unchanged
        try:
            import numpy as np
            W, H = self.w, self.h
            arr = np.frombuffer(bytes(buf), dtype=np.uint8).reshape(H, W)
            out = np.empty_like(arr)
            denom = (H - 1) if H > 1 else 1
            for y in range(H):
                s = int(round(frac * W * (y / denom)))
                out[y] = np.roll(arr[y], s)           # the further down, the more it is shifted
            return out.tobytes()
        except Exception:
            return buf

    def _image(self, raw):
        total = self.w * self.h
        n = min(len(raw), total)
        self.persist[:n] = raw[:n]                    # overwrite the decoded prefix onto persist line by line
        try:                                          # atomically save persist to disk so it can be resumed after a restart
            with open(self.persist_path + '.tmp', 'wb') as fh:
                fh.write(bytes(self.persist))
            os.replace(self.persist_path + '.tmp', self.persist_path)
        except Exception:
            pass
        buf = self._shear(bytes(self.persist))        # always output the full persist -> never resets to black (no flicker)
        try:
            from PIL import Image
            img = Image.frombytes('L', (self.w, self.h), bytes(buf))
            try:
                img.save(self.out_path + '.tmp'); os.replace(self.out_path + '.tmp', self.out_path)
            except Exception:
                img.save(self.out_path)
        except Exception:
            pass

    def handle(self, msg):
        try:
            ba = bytes(pmt.u8vector_elements(pmt.cdr(msg)))
        except Exception:
            return
        now = time.time()
        info = ba[16:] if len(ba) > 16 else b''
        if len(info) >= 2:                            # candidate for a valid image frame
            seq = struct.unpack('>H', info[:2])[0]
            if self.chunks and self.last_seq - seq > 5:   # seq goes backward = transmission repeats (new pass)
                self.reps += 1; self.done_flag = False   # accumulate chunks across passes: a looping/repeated transmission fills the missing chunks over time, so even a lossy demod completes the full image (persist overwrites line by line)
            self.last_seq = seq
            self.chunks.setdefault(seq, info[2:])
            ordered, k = b'', 0
            while k in self.chunks:
                ordered += self.chunks[k]; k += 1
            if len(ordered) >= 4:
                clen = struct.unpack('>I', ordered[:4])[0]
                comp = ordered[4:4 + clen]
                try:
                    raw = zlib.decompressobj().decompress(comp)
                except zlib.error:
                    raw = None
                if raw is not None:
                    self.decoded = min(len(raw), self.w * self.h)
                    self.done_flag = len(comp) >= clen and len(raw) >= self.w * self.h
                    self._image(raw)
                    self._progress()
                    self.last_prog = now
                    return
        # not a valid frame (corrupted/short frame) - periodically signal that GNU Radio is still running
        if now - self.last_prog > 0.4:
            self.last_prog = now
            self._progress()

    def work(self, input_items, output_items):
        return 0
