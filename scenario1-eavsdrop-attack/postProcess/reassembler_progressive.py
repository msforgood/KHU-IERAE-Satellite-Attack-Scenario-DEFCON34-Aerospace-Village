"""
Embedded Python Block: ENIGMA-1 progressive, repeat-aware, offset-shearing reassembler.

Orders AX.25 Info chunks by sequence and STREAMING-inflates the in-order prefix so the
image appears progressively (row by row) as it decodes, and keeps re-decoding on every
repeat burst so the web shows a continuously updating picture.

B2 EFFECT (center-frequency skew): the flow's startup measures the recording's residual
center-frequency offset and writes it to  <out_dir>/offset.txt  (normalized, cycles/sample).
This block reads that value and applies a PROGRESSIVE HORIZONTAL SHEAR proportional to it:
  · offset ~ 0 (correctly tuned)  -> shear 0  -> image comes out straight (original);
  · larger offset                 -> stronger diagonal slant (like a mistuned analog frame).
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
    def __init__(self, img_w=192, img_h=128, out_path='/home/sunhyuk/projects/vsa4lv-defcon/vsa4lv-challenges/scenario-1/solution/enigma1_recovered.png'):
        gr.sync_block.__init__(self, name='ENIGMA-1 Image Reassembler', in_sig=[], out_sig=[])
        self.message_port_register_in(pmt.intern('frame'))          # ax25_deframer(out) → 이 포트로 프레임 수신
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
        # 지속 이미지 버퍼: 회차마다 검정으로 리셋하지 않고 그 위에 덮어쓴다. 디스크에도 저장해
        # 워치독 재시작(새 프로세스) 후에도 이전 이미지를 이어받아 검정 깜빡임을 완전히 없앤다.
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
        """중심주파수 오프셋(normalized cyc/sample). flow 기동 시 offset.txt 에 기록됨. 없으면 0."""
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
        """B2: 측정 오프셋에 비례해 행마다 가로로 점점 더 밀어 사선(shear)으로 만든다.
        오프셋 0 → 밀림 0(원본). |오프셋| 클수록 더 기울고, 부호가 방향을 정한다."""
        off = self._read_offset()
        GAIN = 18.0
        frac = max(-0.6, min(0.6, off * GAIN))        # 맨 아랫행의 밀림량(폭 대비 비율)
        if abs(frac) < 0.003:
            return buf                                # 중심 맞음 → 원본 그대로
        try:
            import numpy as np
            W, H = self.w, self.h
            arr = np.frombuffer(bytes(buf), dtype=np.uint8).reshape(H, W)
            out = np.empty_like(arr)
            denom = (H - 1) if H > 1 else 1
            for y in range(H):
                s = int(round(frac * W * (y / denom)))
                out[y] = np.roll(arr[y], s)           # 아래로 갈수록 더 민다
            return out.tobytes()
        except Exception:
            return buf

    def _image(self, raw):
        total = self.w * self.h
        n = min(len(raw), total)
        self.persist[:n] = raw[:n]                    # 디코드된 앞부분을 persist 위에 라인 바이 라인 덮어쓴다
        try:                                          # 재시작 후 이어받도록 persist 를 디스크에 원자적 저장
            with open(self.persist_path + '.tmp', 'wb') as fh:
                fh.write(bytes(self.persist))
            os.replace(self.persist_path + '.tmp', self.persist_path)
        except Exception:
            pass
        buf = self._shear(bytes(self.persist))        # 항상 persist 전체를 출력 → 검정으로 리셋 안 됨(깜빡임 없음)
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
        if len(info) >= 2:                            # 유효 이미지 프레임 후보
            seq = struct.unpack('>H', info[:2])[0]
            if self.chunks and self.last_seq - seq > 5:   # seq 되돌아감 = 전송 반복(새 회차)
                self.chunks = {}; self.reps += 1; self.done_flag = False   # 스트림 청크만 초기화(재복원). persist 는 유지 → 그 위에 라인 바이 라인 덮어씀(검정 리셋 없음)
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
        # 유효 프레임 아님(깨진/짧은 프레임) — GNU Radio 실행 중임을 주기적으로 알림
        if now - self.last_prog > 0.4:
            self.last_prog = now
            self._progress()

    def work(self, input_items, output_items):
        return 0
