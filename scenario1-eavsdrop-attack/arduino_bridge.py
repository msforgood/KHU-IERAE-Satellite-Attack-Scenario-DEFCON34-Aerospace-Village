#!/usr/bin/env python3
"""
arduino_bridge.py — VSA ↔ 아두이노 브릿지

VSA의 WebSocket(server.js, ws://localhost:4534)에 접속해 `antenna-lock` 메시지를 읽고,
아두이노(booth_antenna.ino)에 시리얼로 명령을 보낸다:
  locked=true  → 'L' (VSA 안테나가 위성을 가리킴 → 모형 위성 조준)
  locked=false → 'U' (아니면 → 모형 딴 데)

상태가 바뀔 때만 전송(디바운스). WebSocket/시리얼 둘 다 끊기면 자동 재연결.

사용:
  python3 arduino_bridge.py                       # 시리얼 포트 자동탐지
  python3 arduino_bridge.py --port /dev/ttyACM0   # 포트 지정
  python3 arduino_bridge.py --ws ws://localhost:4534 --baud 115200
  python3 arduino_bridge.py -v                    # 수신 메시지 전부 로그 (디버그)
"""
import argparse
import asyncio
import json

import serial
import serial.tools.list_ports
import websockets


def _wsl_ip():
    """Windows에서 WSL 배포판의 IP 조회 (WSL 안에서 도는 server.js 에 붙기 위해)."""
    import subprocess
    try:
        out = subprocess.check_output(["wsl", "hostname", "-I"], text=True,
                                      timeout=5, stderr=subprocess.DEVNULL).strip()
        return out.split()[0] if out else None
    except Exception:
        return None


def resolve_ws_url(ws_url):
    """Windows에서 localhost 로 붙는데 그 포트에 리스너가 없고 WSL 쪽에 server.js 가
    있으면, WSL IP 로 자동 대체한다(server.js 가 WSL 안에서 도는 흔한 구성 대응)."""
    import sys
    import socket
    from urllib.parse import urlparse, urlunparse
    if sys.platform != "win32":
        return ws_url
    u = urlparse(ws_url)
    if (u.hostname or "") not in ("localhost", "127.0.0.1"):
        return ws_url
    port = u.port or 4534
    try:  # localhost 에 이미 리스너가 있으면(미러드 네트워킹 등) 그대로 사용
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        # 'localhost' 는 파이썬 websockets 가 IPv6(::1) 로 먼저 붙어 미러드 네트워킹에서
        # opening-handshake 타임아웃날 수 있다. 검증된 IPv4(127.0.0.1) 로 못박아 반환한다.
        if (u.hostname or "") == "localhost":
            return urlunparse(u._replace(netloc=f"127.0.0.1:{port}"))
        return ws_url
    except OSError:
        pass
    ip = _wsl_ip()
    if not ip:
        return ws_url
    try:  # WSL IP 쪽에 server.js 가 실제로 떠 있는지 확인 후에만 대체
        socket.create_connection((ip, port), timeout=2).close()
    except OSError:
        return ws_url
    netloc = f"{ip}:{u.port}" if u.port else ip
    print(f"[bridge] localhost:{port} 에 server.js 없음 → WSL({ip}) 로 자동 접속")
    return urlunparse(u._replace(netloc=netloc))


def find_arduino_port():
    """연결된 아두이노로 보이는 시리얼 포트 자동 탐지."""
    for p in serial.tools.list_ports.comports():
        desc = f"{p.description} {p.manufacturer or ''} {p.product or ''}".lower()
        if any(k in desc for k in ("arduino", "acm", "ch340", "ftdi", "usb serial", "wch")):
            return p.device
    # 흔한 경로 폴백
    import glob
    for pat in ("/dev/ttyACM*", "/dev/ttyUSB*"):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[0]
    return None


class SerialLink:
    """아두이노 시리얼 연결 (자동 재연결 + 상태 디바운스)."""
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
            self.last_sent = None   # 재연결 후 현재 상태 다시 보내도록
            return True
        except Exception as e:
            print(f"[serial] open failed ({port}): {e}")
            self.ser = None
            return False

    def send_lock(self, locked):
        """상태가 바뀌었을 때만 'L'/'U' 전송."""
        if locked == self.last_sent:
            if self.verbose:
                print(f"[serial] locked={locked} 동일 상태 → 전송 생략 (디바운스)")
            return
        if self.ser is None and not self._open():
            print(f"[serial] ⚠ 아두이노 포트 없음 — locked={locked} 명령 버림"
                  " (USB 연결/포트 확인, WSL이면 usbipd attach 필요)")
            return
        cmd = b"L\n" if locked else b"U\n"
        try:
            self.ser.write(cmd)
            self.ser.flush()
            self.last_sent = locked
            print(f"[serial] → {'L (조준)' if locked else 'U (딴 데)'}")
        except Exception as e:
            print(f"[serial] write failed: {e} — 재연결 시도")
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def poll_incoming(self):
        """아두이노가 보낸 응답(READY/LOCK/UNLOCK 등)을 읽어 로그로 표시."""
        if self.ser is None:
            return
        try:
            while self.ser.in_waiting:
                line = self.ser.readline().decode(errors="replace").strip()
                if line:
                    print(f"[serial] ← {line}")
        except Exception as e:
            print(f"[serial] read failed: {e} — 재연결 시도")
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
                            print(f"[ws] ← JSON 아님, 무시: {raw!r}")
                        continue
                    if msg.get("type") == "antenna-lock":
                        if verbose:
                            print(f"[ws] ← antenna-lock locked={msg.get('locked')}")
                        link.send_lock(bool(msg.get("locked")))
                    elif verbose:
                        print(f"[ws] ← type={msg.get('type')!r} 무시: {raw}")
        except Exception as e:
            print(f"[ws] disconnected ({e}) — 3초 후 재연결")
            await asyncio.sleep(3)


def main():
    ap = argparse.ArgumentParser(description="VSA WebSocket ↔ Arduino serial bridge")
    ap.add_argument("--ws", default="ws://localhost:4534", help="VSA 브릿지 WebSocket URL")
    ap.add_argument("--port", default=None, help="아두이노 시리얼 포트 (기본: 자동탐지)")
    ap.add_argument("--baud", type=int, default=115200, help="시리얼 보드레이트 (스케치와 일치)")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="수신한 모든 WS 메시지와 디바운스 생략까지 로그")
    a = ap.parse_args()

    ws_url = resolve_ws_url(a.ws)   # Windows+WSL 이면 WSL IP 로 자동 대체
    link = SerialLink(a.port, a.baud, verbose=a.verbose)
    detected = a.port or find_arduino_port()
    print(f"[bridge] WS={ws_url}  serial={detected or '(자동탐지 대기)'} @ {a.baud}")
    try:
        asyncio.run(run(ws_url, link, verbose=a.verbose))
    except KeyboardInterrupt:
        print("\n[bridge] 종료")


if __name__ == "__main__":
    main()
