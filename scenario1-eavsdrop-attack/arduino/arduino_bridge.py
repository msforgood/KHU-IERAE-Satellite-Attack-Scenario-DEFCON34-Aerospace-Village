#!/usr/bin/env python3
"""
arduino_bridge.py - VSA to Arduino bridge

Connects to the VSA WebSocket (server.js, ws://localhost:4534), reads `antenna-lock` messages,
and sends serial commands to the Arduino (booth_antenna.ino):
  locked=true  -> 'L' (the VSA antenna points at the satellite -> aim the model satellite)
  locked=false -> 'U' (otherwise -> aim the model elsewhere)

Sends only when the state changes (debounce). Reconnects automatically if either the WebSocket or the serial link drops.

Usage:
  python3 arduino_bridge.py                       # auto-detect the serial port
  python3 arduino_bridge.py --port /dev/ttyACM0   # specify the port
  python3 arduino_bridge.py --ws ws://localhost:4534 --baud 115200
  python3 arduino_bridge.py -v                    # log every received message (debug)
"""
import argparse
import asyncio
import json

import serial
import serial.tools.list_ports
import websockets


def _wsl_ip():
    """On Windows, look up the WSL distribution's IP (to connect to server.js running inside WSL)."""
    import subprocess
    try:
        out = subprocess.check_output(["wsl", "hostname", "-I"], text=True,
                                      timeout=5, stderr=subprocess.DEVNULL).strip()
        return out.split()[0] if out else None
    except Exception:
        return None


def resolve_ws_url(ws_url):
    """On Windows, if you connect via localhost but nothing is listening on that port and
    server.js is on the WSL side, automatically switch to the WSL IP (handles the common
    setup where server.js runs inside WSL)."""
    import sys
    import socket
    from urllib.parse import urlparse, urlunparse
    if sys.platform != "win32":
        return ws_url
    u = urlparse(ws_url)
    if (u.hostname or "") not in ("localhost", "127.0.0.1"):
        return ws_url
    port = u.port or 4534
    try:  # if a listener already exists on localhost (mirrored networking, etc.), use it as-is
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        # With 'localhost', the Python websockets library tries IPv6 (::1) first, which can
        # cause an opening-handshake timeout under mirrored networking. Pin the return to the
        # verified IPv4 address (127.0.0.1).
        if (u.hostname or "") == "localhost":
            return urlunparse(u._replace(netloc=f"127.0.0.1:{port}"))
        return ws_url
    except OSError:
        pass
    ip = _wsl_ip()
    if not ip:
        return ws_url
    try:  # switch only after confirming server.js is actually up on the WSL IP
        socket.create_connection((ip, port), timeout=2).close()
    except OSError:
        return ws_url
    netloc = f"{ip}:{u.port}" if u.port else ip
    print(f"[bridge] no server.js on localhost:{port} -> connecting automatically to WSL({ip})")
    return urlunparse(u._replace(netloc=netloc))


def find_arduino_port():
    """Auto-detect the serial port that looks like a connected Arduino."""
    for p in serial.tools.list_ports.comports():
        desc = f"{p.description} {p.manufacturer or ''} {p.product or ''}".lower()
        if any(k in desc for k in ("arduino", "acm", "ch340", "ftdi", "usb serial", "wch")):
            return p.device
    # fall back to common paths
    import glob
    for pat in ("/dev/ttyACM*", "/dev/ttyUSB*"):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[0]
    return None


class SerialLink:
    """Arduino serial connection (auto-reconnect plus state debounce)."""
    def __init__(self, port, baud, verbose=False):
        self.port_arg = port
        self.baud = baud
        self.verbose = verbose
        self.ser = None
        self.last_sent = None

    def _open(self):
        port = self.port_arg or find_arduino_port()
        if not port:
            return False
        try:
            self.ser = serial.Serial(port, self.baud, timeout=1)
            print(f"[serial] connected: {port} @ {self.baud}")
            self.last_sent = None   # resend the current state after reconnecting
            return True
        except Exception as e:
            print(f"[serial] open failed ({port}): {e}")
            self.ser = None
            return False

    def send_lock(self, locked):
        """Send 'L'/'U' only when the state has changed."""
        if locked == self.last_sent:
            if self.verbose:
                print(f"[serial] locked={locked} unchanged state -> skipping send (debounce)")
            return
        if self.ser is None and not self._open():
            print(f"[serial] no Arduino port - dropping locked={locked} command"
                  " (check the USB connection/port; on WSL you need usbipd attach)")
            return
        cmd = b"L\n" if locked else b"U\n"
        try:
            self.ser.write(cmd)
            self.ser.flush()
            self.last_sent = locked
            print(f"[serial] -> {'L (aim)' if locked else 'U (aim elsewhere)'}")
        except Exception as e:
            print(f"[serial] write failed: {e} - attempting reconnect")
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def poll_incoming(self):
        """Read responses sent by the Arduino (READY/LOCK/UNLOCK, etc.) and show them in the log."""
        if self.ser is None:
            return
        try:
            while self.ser.in_waiting:
                line = self.ser.readline().decode(errors="replace").strip()
                if line:
                    print(f"[serial] <- {line}")
        except Exception as e:
            print(f"[serial] read failed: {e} - attempting reconnect")
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None


async def _poll_serial(link):
    while True:
        link.poll_incoming()
        await asyncio.sleep(0.5)


async def run(ws_url, link, verbose=False):
    asyncio.get_running_loop().create_task(_poll_serial(link))
    while True:
        try:
            async with websockets.connect(ws_url, ping_interval=20) as ws:
                print(f"[ws] connected: {ws_url}")
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        if verbose:
                            print(f"[ws] <- not JSON, ignoring: {raw!r}")
                        continue
                    if msg.get("type") == "antenna-lock":
                        if verbose:
                            print(f"[ws] <- antenna-lock locked={msg.get('locked')}")
                        link.send_lock(bool(msg.get("locked")))
                    elif verbose:
                        print(f"[ws] <- type={msg.get('type')!r} ignoring: {raw}")
        except Exception as e:
            print(f"[ws] disconnected ({e}) - reconnecting in 3 seconds")
            await asyncio.sleep(3)


def main():
    ap = argparse.ArgumentParser(description="VSA WebSocket to Arduino serial bridge")
    ap.add_argument("--ws", default="ws://localhost:4534", help="VSA bridge WebSocket URL")
    ap.add_argument("--port", default=None, help="Arduino serial port (default: auto-detect)")
    ap.add_argument("--baud", type=int, default=115200, help="serial baud rate (must match the sketch)")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="log every received WS message, including skipped debounce sends")
    a = ap.parse_args()

    ws_url = resolve_ws_url(a.ws)   # on Windows+WSL, switch automatically to the WSL IP
    link = SerialLink(a.port, a.baud, verbose=a.verbose)
    detected = a.port or find_arduino_port()
    print(f"[bridge] WS={ws_url}  serial={detected or '(waiting for auto-detect)'} @ {a.baud}")
    try:
        asyncio.run(run(ws_url, link, verbose=a.verbose))
    except KeyboardInterrupt:
        print("\n[bridge] shutting down")


if __name__ == "__main__":
    main()
