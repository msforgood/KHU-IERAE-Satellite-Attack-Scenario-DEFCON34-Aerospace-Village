// miniws.js — minimal RFC6455 WebSocket server, zero dependencies.
// Enough for this booth demo: text frames, ping/pong, close. No extensions,
// no fragmentation-across-frames beyond simple continuation, no permessage-deflate.
//
// Usage:
//   const { WSServer } = require("./miniws");
//   const wss = new WSServer(httpServer);           // attach to an http.Server
//   wss.on("connection", (sock) => { sock.send("hi"); sock.on("message", ...) });
//
// A WSServer can also stand alone on a port via WSServer.listen(port).

const crypto = require("crypto");
const http = require("http");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function accept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

class WSSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this.alive = true;
    this._closed = false;
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => this._cleanup());
    // A browser tab closing abruptly resets the connection (ECONNRESET). Treat
    // any socket error as a disconnect — never re-emit an unhandled 'error',
    // which would crash the whole ground station.
    socket.on("error", () => this._cleanup());
  }

  _cleanup() {
    if (this._closed) return;   // socket 'error' then 'close' → emit once
    this._closed = true;
    this.alive = false;
    this.emit("close");
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const b0 = this._buf[0], b1 = this._buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < off + 2) return;
        len = this._buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (this._buf.length < off + 8) return;
        len = Number(this._buf.readBigUInt64BE(off)); off += 8;
      }
      let mask;
      if (masked) {
        if (this._buf.length < off + 4) return;
        mask = this._buf.subarray(off, off + 4); off += 4;
      }
      if (this._buf.length < off + len) return;
      let payload = this._buf.subarray(off, off + len);
      if (masked) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this._buf = this._buf.subarray(off + len);

      if (opcode === 0x8) { this.close(); return; }        // close
      else if (opcode === 0x9) { this._frame(0xA, payload); } // ping → pong
      else if (opcode === 0xA) { /* pong */ }
      else if (opcode === 0x1 || opcode === 0x0) {           // text / continuation
        this.emit("message", payload.toString("utf8"));
      }
    }
  }

  _frame(opcode, data) {
    if (!this.alive) return;
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    try { this.socket.write(Buffer.concat([header, data])); } catch { /* closed */ }
  }

  send(str) { this._frame(0x1, Buffer.from(str, "utf8")); }
  close() { try { this._frame(0x8, Buffer.alloc(0)); this.socket.end(); } catch {} this.alive = false; }
}

class WSServer extends EventEmitter {
  constructor(server) {
    super();
    this.clients = new Set();
    if (server) this.attach(server);
  }

  attach(server) {
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      if (!key) { socket.destroy(); return; }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
      );
      const ws = new WSSocket(socket);
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      this.emit("connection", ws, req);
    });
  }

  broadcast(str) { for (const c of this.clients) c.send(str); }

  static listen(port, host = "0.0.0.0", cb) {
    const server = http.createServer((_, res) => { res.writeHead(426); res.end("Upgrade Required"); });
    const wss = new WSServer(server);
    server.listen(port, host, cb);
    wss.httpServer = server;
    return wss;
  }
}

module.exports = { WSServer, WSSocket };
