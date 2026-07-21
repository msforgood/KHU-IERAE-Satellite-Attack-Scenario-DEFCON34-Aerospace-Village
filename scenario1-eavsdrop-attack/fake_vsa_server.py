#!/usr/bin/env python3
"""
fake_vsa_server.py — VSA(server.js) 흉내내는 가짜 WebSocket 서버 (프로토타입/부스 리허설용)

실제 OpenVSA server.js와 동일하게 ws://0.0.0.0:4534 에서 WebSocket을 열고,
`antenna-lock` 메시지를 브로드캐스트한다. arduino_bridge.py는 수정 없이
실서버 대신 이 서버에 붙여서 테스트하면 된다.

메시지 형식 (server.js와 동일):
  { "type": "antenna-lock", "locked": true|false }

조작 (터미널에서 입력 + Enter):
  l : locked=true  브로드캐스트 (모형 안테나 → 위성 조준 포즈)
  u : locked=false 브로드캐스트 (모형 안테나 → 딴 데 포즈)
  t : 상태 토글
  a : 자동 데모 모드 시작 (기본 8초마다 lock/unlock 반복)
  s : 자동 데모 모드 정지
  q : 종료

실서버처럼, 클라이언트가 보낸 `antenna-lock` 메시지도 모든 클라이언트에게 릴레이한다
(→ 스크립트/다른 프로그램에서 WS로 상태를 주입해 테스트 가능).

사용:
  python3 fake_vsa_server.py                 # 포트 4534
  python3 fake_vsa_server.py --port 4534 --auto-period 8
"""
import argparse
import asyncio
import json
import signal
import sys

from websockets.asyncio.server import serve, broadcast


class FakeVSA:
    def __init__(self, auto_period):
        self.locked = False
        self.auto_period = auto_period
        self.auto_task = None
        self.clients = set()

    # ── 브로드캐스트 ──
    def send_lock(self, locked):
        self.locked = locked
        msg = json.dumps({"type": "antenna-lock", "locked": locked})
        broadcast(self.clients, msg)
        print(f"[fake-vsa] → antenna-lock locked={locked} (클라이언트 {len(self.clients)}개)")

    # ── WebSocket 핸들러 ──
    async def handler(self, ws):
        self.clients.add(ws)
        peer = ws.remote_address
        print(f"[ws] client connected: {peer}")
        # 실서버(server.js)처럼 접속 직후 현재 상태 동기화용 메시지 전송
        await ws.send(json.dumps({"type": "position", "az": 131, "el": 47}))
        await ws.send(json.dumps({"type": "status", "gpredictConnected": False}))
        # 브릿지가 접속하자마자 현재 lock 상태를 알 수 있게 전송
        await ws.send(json.dumps({"type": "antenna-lock", "locked": self.locked}))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                # 실서버처럼 클라이언트가 보낸 antenna-lock을 전체 릴레이
                if msg.get("type") == "antenna-lock":
                    print(f"[ws] antenna-lock from client: {msg.get('locked')}")
                    self.send_lock(bool(msg.get("locked")))
        finally:
            self.clients.discard(ws)
            print(f"[ws] client disconnected: {peer}")

    # ── 자동 데모 모드 ──
    async def _auto_loop(self):
        while True:
            self.send_lock(not self.locked)
            await asyncio.sleep(self.auto_period)

    def auto_start(self):
        if self.auto_task is None or self.auto_task.done():
            self.auto_task = asyncio.get_running_loop().create_task(self._auto_loop())
            print(f"[fake-vsa] 자동 데모 시작 ({self.auto_period}초 간격)")

    def auto_stop(self):
        if self.auto_task and not self.auto_task.done():
            self.auto_task.cancel()
            print("[fake-vsa] 자동 데모 정지")
        self.auto_task = None

    # ── 키보드 입력 ──
    def handle_stdin(self, stop_event):
        line = sys.stdin.readline()
        if not line:  # EOF (파이프 입력 등) — 키 조작 없이 서버만 유지
            asyncio.get_running_loop().remove_reader(sys.stdin)
            return
        cmd = line.strip().lower()
        if cmd == "l":
            self.auto_stop(); self.send_lock(True)
        elif cmd == "u":
            self.auto_stop(); self.send_lock(False)
        elif cmd == "t":
            self.auto_stop(); self.send_lock(not self.locked)
        elif cmd == "a":
            self.auto_start()
        elif cmd == "s":
            self.auto_stop()
        elif cmd == "q":
            stop_event.set()
        elif cmd:
            print("[fake-vsa] 명령: l(조준) u(해제) t(토글) a(자동) s(정지) q(종료)")


async def main():
    ap = argparse.ArgumentParser(description="Fake Virtual Antenna WebSocket server (antenna-lock)")
    ap.add_argument("--port", type=int, default=4534, help="WebSocket 포트 (기본 4534, 실서버와 동일)")
    ap.add_argument("--auto-period", type=float, default=8.0, help="자동 데모 lock/unlock 간격(초)")
    a = ap.parse_args()

    vsa = FakeVSA(a.auto_period)
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    try:
        loop.add_reader(sys.stdin, vsa.handle_stdin, stop_event)
    except (NotImplementedError, PermissionError):
        print("[fake-vsa] stdin 조작 불가 환경 — WS 릴레이로만 제어 가능")

    # Ctrl-C도 q와 동일하게 깔끔히 종료
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    async with serve(vsa.handler, "0.0.0.0", a.port):
        print(f"[fake-vsa] WebSocket server on ws://localhost:{a.port}")
        print("[fake-vsa] 명령: l(조준) u(해제) t(토글) a(자동) s(정지) q(종료)  ※ 입력 후 Enter")
        await stop_event.wait()
    print("[fake-vsa] 종료")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[fake-vsa] 종료")
