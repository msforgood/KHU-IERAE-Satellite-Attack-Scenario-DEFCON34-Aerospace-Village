// Scenario 4 dedicated rotctld/rigctld bridge (isolated from scenario 1).
//
// Scenario 1 owns the default bridge on :4532-4535. If scenario 4 reused those
// ports, its gpredict and scenario 1's gpredict would both drive the SAME shared
// rotor state and fight over it (a parked gpredict keeps writing 179/0 and stomps
// the tracking gpredict, so the antenna looks stuck). This bridge listens on a
// separate port block so the two scenarios never collide and can run at once.
//
//   TCP  ROT_PORT (4543)  - Hamlib rotctld (point scenario-4 gpredict rotor here)
//   TCP  RIG_PORT (4542)  - Hamlib rigctld (point scenario-4 gpredict radio here)
//   WS   WS_PORT  (4544)  - browser antenna/Doppler visualisation (scenario-4 VSA)
//   HTTP STATUS_PORT(4545)- status poll (control.py reads engaged/tracking here)
//
// Zero external deps: the WebSocket server is a minimal RFC6455 implementation on
// top of node's built-in http/net/crypto, so scenario 4 stays install-free.
//
// Usage:  node server.js     (ports overridable via env ROT_PORT/RIG_PORT/WS_PORT/STATUS_PORT)

const net    = require("net");
const http   = require("http");
const crypto = require("crypto");

const ROT_PORT    = parseInt(process.env.ROT_PORT    || "4543", 10);
const RIG_PORT    = parseInt(process.env.RIG_PORT    || "4542", 10);
const WS_PORT     = parseInt(process.env.WS_PORT     || "4544", 10);
const STATUS_PORT = parseInt(process.env.STATUS_PORT || "4545", 10);

// ── shared state ──────────────────────────────────────────────────────────────
let az = 131;
let el = 47;
let rigFreq = 0;
let gpredictConnected = false;
let lastPosChangeTs  = 0;   // when az/el last actually changed (rotor tracking = a recent change)
let lastFreqChangeTs = 0;   // when the rig frequency last actually changed (Doppler tracking = a recent change)
const rotClients = new Set();
const rigClients = new Set();

// ── minimal RFC6455 WebSocket server (text frames, no deps) ───────────────────
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsClients = new Set();

function wsSend(sock, str) {
  if (sock.destroyed) return;
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch { /* client gone */ }
}

// Parse as many complete frames as buf holds; return leftover bytes.
function wsParse(sock, buf, onText) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;                     // frame incomplete, wait for more
    const data = buf.slice(p, p + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    off = p + len;

    if (opcode === 0x8) { sock.end(); return buf.slice(off); }         // close
    else if (opcode === 0x9) {                                          // ping -> pong
      try { sock.write(Buffer.from([0x8a, 0x00])); } catch {}
    } else if (opcode === 0x1 || opcode === 0x0) {                      // text / continuation
      try { onText(data.toString("utf8")); } catch {}
    }
  }
  return buf.slice(off);
}

const wsHttp = http.createServer();
wsHttp.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);
  wsClients.add(socket);
  console.log("[ws] Browser connected");

  // send current state immediately so the page syncs on load/reconnect
  wsSend(socket, JSON.stringify({ type: "position", az, el }));
  wsSend(socket, JSON.stringify({ type: "status", gpredictConnected }));

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = wsParse(socket, Buffer.concat([buf, chunk]), (text) => {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "uplink-transmit") {
          // scenario 4 transmits via the software console, not this bridge; log only.
          console.log(`[uplink] TX → ${msg.satellite} @ ${msg.frequency} MHz: ${msg.command}`);
        } else if (msg.type === "antenna-lock") {
          broadcast({ type: "antenna-lock", locked: !!msg.locked });
        }
      } catch { /* ignore non-JSON */ }
    });
  });
  const drop = () => { wsClients.delete(socket); console.log("[ws] Browser disconnected"); };
  socket.on("close", drop);
  socket.on("error", drop);
});
wsHttp.listen(WS_PORT, "0.0.0.0", () => {
  console.log(`[ws]      WebSocket server on ws://localhost:${WS_PORT}`);
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const s of wsClients) wsSend(s, data);
}
function broadcastPosition() { broadcast({ type: "position", az, el, time: Date.now() }); }
function broadcastStatus()   { broadcast({ type: "status", gpredictConnected }); }

// ── TCP rotctld server (gpredict rotor talks here) ────────────────────────────
const tcpServer = net.createServer((sock) => {
  const addr = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[rotctld] gpredict connected from ${addr}`);
  rotClients.add(sock);
  gpredictConnected = rotClients.size > 0;
  broadcastStatus();
  broadcastPosition();

  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const raw of lines) {
      const cmd = raw.trim();
      if (!cmd) continue;
      const n = cmd
        .replace(/^\\set_pos\s+/, "P ")
        .replace(/^\\get_pos$/, "p")
        .replace(/^\\stop$/, "S")
        .replace(/^\\quit$/, "q")
        .replace(/^\\set_target\s+/, "T ")
        .replace(/^\\set_conf\s+/, "C ");
      if (n === "p") {
        sock.write(`${az.toFixed(2)}\n${el.toFixed(2)}\n`);
      } else if (n.startsWith("P ")) {
        const parts = n.split(/\s+/);
        az = Math.min(360, Math.max(0, parseFloat(parts[1]) || 0));
        el = Math.min(90,  Math.max(0, parseFloat(parts[2]) || 0));
        lastPosChangeTs = Date.now();
        broadcastPosition();
        sock.write("RPRT 0\n");
      } else if (n.startsWith("T ")) {
        const name = n.slice(2).trim();
        if (name) broadcast({ type: "target", name });
        sock.write("RPRT 0\n");
      } else if (n.startsWith("L ")) {
        const parts = n.split(/\s+/);
        const lat = parseFloat(parts[1]), lon = parseFloat(parts[2]);
        if (!isNaN(lat) && !isNaN(lon)) broadcast({ type: "location", lat, lon });
        sock.write("RPRT 0\n");
      } else if (n.startsWith("C ")) {
        const rest = n.slice(2).trim();
        const sp = rest.indexOf(" ");
        const key = sp === -1 ? rest : rest.slice(0, sp);
        const val = sp === -1 ? ""  : rest.slice(sp + 1).trim();
        if (key === "sat_name" && val) broadcast({ type: "target", name: val });
        sock.write("RPRT 0\n");
      } else if (n === "S") {
        sock.write("RPRT 0\n");
      } else if (n === "q" || n === "Q") {
        sock.end();
      } else {
        sock.write("RPRT 0\n");
      }
    }
  });
  sock.on("close", () => {
    rotClients.delete(sock);
    gpredictConnected = rotClients.size > 0;
    broadcastStatus();
    console.log(`[rotctld] gpredict disconnected (${addr})`);
  });
  sock.on("error", (e) => console.error("[rotctld] socket error:", e.message));
});
tcpServer.listen(ROT_PORT, "0.0.0.0", () => {
  console.log(`[rotctld] Listening on TCP 0.0.0.0:${ROT_PORT}`);
});

// ── TCP rigctld server (gpredict radio / Doppler talks here) ──────────────────
const rigServer = net.createServer((sock) => {
  const addr = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[rigctld] gpredict radio connected from ${addr}`);
  rigClients.add(sock);
  broadcast({ type: "radioStatus", radioConnected: rigClients.size > 0 });

  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const raw of lines) {
      const cmd = raw.trim();
      if (!cmd) continue;
      const n = cmd
        .replace(/^\\set_freq\s+/, "F ")
        .replace(/^\\get_freq$/, "f")
        .replace(/^\\set_mode\s+/, "M ")
        .replace(/^\\get_mode$/, "m")
        .replace(/^\\quit$/, "q");
      if (n === "f") {
        sock.write(`${rigFreq}\n`);
      } else if (n.startsWith("F ")) {
        const freq = parseFloat(n.slice(2).trim());
        if (!isNaN(freq)) {
          rigFreq = freq;
          lastFreqChangeTs = Date.now();
          broadcast({ type: "frequency", freqHz: freq });
        }
        sock.write("RPRT 0\n");
      } else if (n === "m") {
        sock.write("USB\n200000\n");
      } else if (n.startsWith("M ")) {
        sock.write("RPRT 0\n");
      } else if (n === "_" || cmd === "\\dump_state") {
        sock.write(["0","1","","0.000000 6000000000.000000","","0x0","0x0",""].join("\n") + "\n");
      } else if (n === "q") {
        sock.end();
      } else {
        sock.write("RPRT 0\n");
      }
    }
  });
  sock.on("close", () => {
    rigClients.delete(sock);
    broadcast({ type: "radioStatus", radioConnected: rigClients.size > 0 });
    console.log(`[rigctld] gpredict radio disconnected (${addr})`);
  });
  sock.on("error", (e) => console.error("[rigctld] socket error:", e.message));
});
rigServer.listen(RIG_PORT, "0.0.0.0", () => {
  console.log(`[rigctld] Listening on TCP 0.0.0.0:${RIG_PORT}`);
});

// ── HTTP status endpoint ──────────────────────────────────────────────────────
const statusServer = http.createServer((req, res) => {
  if ((req.url || "").split("?")[0] === "/status") {
    const now = Date.now();
    const body = JSON.stringify({
      rotorEngaged:  rotClients.size > 0,
      radioEngaged:  rigClients.size > 0,
      rotorTracking: rotClients.size > 0 && (now - lastPosChangeTs)  < 60000,
      radioTracking: rigClients.size > 0 && (now - lastFreqChangeTs) < 60000,
      az, el, freqHz: rigFreq,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  } else {
    res.writeHead(404); res.end();
  }
});
statusServer.listen(STATUS_PORT, "0.0.0.0", () => {
  console.log(`[status]  HTTP status on http://localhost:${STATUS_PORT}/status`);
});

console.log(`[bridge]  scenario-4 dedicated bridge up  rot=${ROT_PORT} rig=${RIG_PORT} ws=${WS_PORT} status=${STATUS_PORT}`);
