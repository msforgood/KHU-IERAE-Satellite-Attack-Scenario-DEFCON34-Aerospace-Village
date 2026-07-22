#!/usr/bin/env python3
"""
fake_vsa_server.py - a fake WebSocket server that mimics the VSA (server.js), for prototyping and booth rehearsal

Just like the real OpenVSA server.js, it opens a WebSocket on ws://0.0.0.0:4534 and
broadcasts `antenna-lock` messages. arduino_bridge.py can connect to this server
instead of the real one, with no changes, for testing.

Message format (same as server.js):
  { "type": "antenna-lock", "locked": true|false }

Controls (type in the terminal, then press Enter):
  l : broadcast locked=true  (model antenna -> pose aimed at the satellite)
  u : broadcast locked=false (model antenna -> pose aimed elsewhere)
  t : toggle state
  a : start automatic demo mode (by default, repeats lock/unlock every 8 seconds)
  s : stop automatic demo mode
  q : quit

Like the real server, an `antenna-lock` message sent by a client is also relayed to every client
(so you can inject state over WS from a script or another program for testing).

Usage:
  python3 fake_vsa_server.py                 # port 4534
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

    # -- broadcast --
    def send_lock(self, locked):
        self.locked = locked
        msg = json.dumps({"type": "antenna-lock", "locked": locked})
        broadcast(self.clients, msg)
        print(f"[fake-vsa] -> antenna-lock locked={locked} ({len(self.clients)} clients)")

    # -- WebSocket handler --
    async def handler(self, ws):
        self.clients.add(ws)
        peer = ws.remote_address
        print(f"[ws] client connected: {peer}")
        # Like the real server (server.js), send a state-sync message right after connect
        await ws.send(json.dumps({"type": "position", "az": 131, "el": 47}))
        await ws.send(json.dumps({"type": "status", "gpredictConnected": False}))
        # Send the current lock state so the bridge knows it as soon as it connects
        await ws.send(json.dumps({"type": "antenna-lock", "locked": self.locked}))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                # Like the real server, relay an antenna-lock sent by a client to everyone
                if msg.get("type") == "antenna-lock":
                    print(f"[ws] antenna-lock from client: {msg.get('locked')}")
                    self.send_lock(bool(msg.get("locked")))
        finally:
            self.clients.discard(ws)
            print(f"[ws] client disconnected: {peer}")

    # -- automatic demo mode --
    async def _auto_loop(self):
        while True:
            self.send_lock(not self.locked)
            await asyncio.sleep(self.auto_period)

    def auto_start(self):
        if self.auto_task is None or self.auto_task.done():
            self.auto_task = asyncio.get_running_loop().create_task(self._auto_loop())
            print(f"[fake-vsa] automatic demo started ({self.auto_period}s interval)")

    def auto_stop(self):
        if self.auto_task and not self.auto_task.done():
            self.auto_task.cancel()
            print("[fake-vsa] automatic demo stopped")
        self.auto_task = None

    # -- keyboard input --
    def handle_stdin(self, stop_event):
        line = sys.stdin.readline()
        if not line:  # EOF (piped input, etc.) - keep only the server running, no key controls
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
            print("[fake-vsa] commands: l(aim) u(release) t(toggle) a(auto) s(stop) q(quit)")


async def main():
    ap = argparse.ArgumentParser(description="Fake VSA WebSocket server (antenna-lock)")
    ap.add_argument("--port", type=int, default=4534, help="WebSocket port (default 4534, same as the real server)")
    ap.add_argument("--auto-period", type=float, default=8.0, help="automatic demo lock/unlock interval (seconds)")
    a = ap.parse_args()

    vsa = FakeVSA(a.auto_period)
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    try:
        loop.add_reader(sys.stdin, vsa.handle_stdin, stop_event)
    except (NotImplementedError, PermissionError):
        print("[fake-vsa] environment does not allow stdin control - control only via WS relay")

    # Ctrl-C also shuts down cleanly, just like q
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    async with serve(vsa.handler, "0.0.0.0", a.port):
        print(f"[fake-vsa] WebSocket server on ws://localhost:{a.port}")
        print("[fake-vsa] commands: l(aim) u(release) t(toggle) a(auto) s(stop) q(quit)  Note: press Enter after typing")
        await stop_event.wait()
    print("[fake-vsa] shutting down")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[fake-vsa] shutting down")
