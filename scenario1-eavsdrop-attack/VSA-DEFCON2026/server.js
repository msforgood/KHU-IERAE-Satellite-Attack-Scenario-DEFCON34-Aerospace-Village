// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

/**
 * GPredict rotator bridge
 *
 * - TCP :4533  – Hamlib rotctld protocol (point GPredict here)
 * - WS  :4534  – WebSocket for the browser visualisation
 *
 * Usage:  node server.js
 */

const net  = require("net");
// const http = require("http");
// const fs   = require("fs");
// const path = require("path");
const { WebSocketServer } = require("ws");

// const TLE_FILE = path.join(__dirname, "tle.txt");

// ── shared state ──────────────────────────────────────────────────────────────
let az = 131;
let el = 47;
let gpredictConnected = false;
// 열린 rotctld/rigctld 소켓 집합. 상태를 "연결 개수 > 0"으로 판정한다.
// (단일 boolean 이면 소켓 하나가 닫힐 때 다른 연결이 살아있어도 false 로 떨어지는 버그가 있었음)
const rotClients = new Set();
const rigClients = new Set();

// ── WebSocket helpers ─────────────────────────────────────────────────────────
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wsClients) {
    if (c.readyState === 1 /* OPEN */) c.send(data);
  }
}

function broadcastPosition() {
  broadcast({ type: "position", az, el, time: Date.now() });
}

function broadcastStatus() {
  broadcast({ type: "status", gpredictConnected });
}

// ── TCP rotctld server (GPredict talks here) ──────────────────────────────────
const tcpServer = net.createServer((sock) => {
  const addr = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[rotctld] GPredict connected from ${addr}`);

  rotClients.add(sock);
  gpredictConnected = rotClients.size > 0;
  broadcastStatus();
  broadcastPosition();  // sync browser rotator immediately on reconnect

  let buf = "";

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep any incomplete last line

    for (const raw of lines) {
      const cmd = raw.trim();
      if (!cmd) continue;

      // Normalise extended-format commands (\set_pos → P, \get_pos → p, etc.)
      const normalised = cmd
        .replace(/^\\set_pos\s+/, "P ")
        .replace(/^\\get_pos$/, "p")
        .replace(/^\\stop$/, "S")
        .replace(/^\\quit$/, "q")
        .replace(/^\\set_target\s+/, "T ")
        .replace(/^\\set_conf\s+/, "C ");   // GPredict extended config

      if (normalised === "p") {
        // Query current position
        sock.write(`${az.toFixed(2)}\n${el.toFixed(2)}\n`);
      } else if (normalised.startsWith("P ")) {
        // Set position:  P <AZ> <EL>
        const parts = normalised.split(/\s+/);
        az = Math.min(360, Math.max(0, parseFloat(parts[1]) || 0));
        el = Math.min(90, Math.max(0, parseFloat(parts[2]) || 0));
        broadcastPosition();
        sock.write("RPRT 0\n");
        console.log(`[rotctld] → AZ=${az.toFixed(1)}° EL=${el.toFixed(1)}°`);
      } else if (normalised.startsWith("T ")) {
        // Set target satellite:  T <name>
        const name = normalised.slice(2).trim();
        if (name) {
          broadcast({ type: "target", name });
          console.log(`[rotctld] → TARGET=${name}`);
        }
        sock.write("RPRT 0\n");
      } else if (normalised.startsWith("L ")) {
        // Set observer location:  L <LAT> <LON>
        const parts = normalised.split(/\s+/);
        const lat = parseFloat(parts[1]);
        const lon = parseFloat(parts[2]);
        if (!isNaN(lat) && !isNaN(lon)) {
          broadcast({ type: "location", lat, lon });
          console.log(`[rotctld] → LAT=${lat} LON=${lon}`);
        }
        sock.write("RPRT 0\n");
      } else if (normalised.startsWith("C ")) {
        // \set_conf <key> <value>  – GPredict may send sat name here
        const rest  = normalised.slice(2).trim();
        const space = rest.indexOf(" ");
        const key   = space === -1 ? rest : rest.slice(0, space);
        const val   = space === -1 ? ""   : rest.slice(space + 1).trim();
        if (key === "sat_name" && val) {
          broadcast({ type: "target", name: val });
          console.log(`[rotctld] → TARGET (via set_conf) = ${val}`);
        }
        sock.write("RPRT 0\n");
      } else if (normalised === "S") {
        sock.write("RPRT 0\n");
      } else if (normalised === "q" || normalised === "Q") {
        sock.end();
      } else {
        // Unknown command – respond OK so GPredict doesn't bail out
        console.log(`[rotctld] UNKNOWN: ${JSON.stringify(cmd)}`);
        sock.write("RPRT 0\n");
      }
    }
  });

  sock.on("close", () => {
    console.log(`[rotctld] GPredict disconnected (${addr})`);
    rotClients.delete(sock);
    gpredictConnected = rotClients.size > 0;
    broadcastStatus();
  });

  sock.on("error", (e) => console.error("[rotctld] Socket error:", e.message));
});

tcpServer.listen(4533, "0.0.0.0", () => {
  console.log("[rotctld] Listening on TCP 0.0.0.0:4533");
  console.log("          → Point GPredict's rotator host to localhost:4533");
});

// ── HTTP server — TLE feed for GPredict (my_link) ─────────────────────────────
// DISABLED: TLE is served externally.
// Configure GPredict to use your own TLE source.
// const httpServer = http.createServer((req, res) => {
//   if (req.url === "/tle.txt") {
//     try {
//       const data = fs.readFileSync(TLE_FILE, "utf8");
//       res.writeHead(200, { "Content-Type": "text/plain" });
//       res.end(data);
//     } catch (e) {
//       res.writeHead(500);
//       res.end("TLE file not found");
//     }
//   } else {
//     res.writeHead(404);
//     res.end();
//   }
// });
//
// httpServer.listen(4535, "0.0.0.0", () => {
//   console.log("[tle]     HTTP TLE feed on http://localhost:4535/tle.txt");
//   console.log("          → Add this URL as 'my_link' in GPredict TLE sources");
// });

// ── WebSocket server (browser talks here) ─────────────────────────────────────
const wss = new WebSocketServer({ port: 4534 });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  console.log("[ws] Browser connected");

  // Send current state immediately so the page syncs on load/reconnect
  ws.send(JSON.stringify({ type: "position", az, el }));
  ws.send(JSON.stringify({ type: "status", gpredictConnected }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "uplink-transmit") {
        console.log(`[uplink] TX → ${msg.satellite} @ ${msg.frequency} MHz: ${msg.command}`);
        forwardUplinkCommand(msg);
      } else if (msg.type === "antenna-lock") {
        // Re-broadcast the renderer's lock state to all clients (the Arduino
        // bridge is a separate WS client). arduino_bridge.py turns it into 'L'/'U'.
        broadcast({ type: "antenna-lock", locked: !!msg.locked });
      }
    } catch { /* ignore non-JSON */ }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("[ws] Browser disconnected");
  });
  ws.on("error", (e) => console.error("[ws] Error:", e.message));
});

console.log("[ws]     WebSocket server on ws://localhost:4534");

// ── Uplink command forwarding ─────────────────────────────────────────────────
const UPLINK_DEST = process.env.UPLINK_DEST || "ws://localhost:4536";
let uplinkWs = null;

function forwardUplinkCommand(msg) {
  const payload = JSON.stringify({
    type:      "uplink-command",
    satellite: msg.satellite,
    frequency: msg.frequency,
    command:   msg.command,
    purpose:   msg.purpose,
    timestamp: new Date().toISOString(),
  });

  // Try WebSocket forwarding
  if (!uplinkWs || uplinkWs.readyState !== 1 /* OPEN */) {
    try {
      const WebSocket = require("ws");
      uplinkWs = new WebSocket(UPLINK_DEST);
      uplinkWs.on("open", () => {
        console.log(`[uplink] Connected to ${UPLINK_DEST}`);
        uplinkWs.send(payload);
      });
      uplinkWs.on("error", () => {
        console.log(`[uplink] No external receiver at ${UPLINK_DEST} — command logged only`);
        uplinkWs = null;
      });
      uplinkWs.on("close", () => { uplinkWs = null; });
    } catch {
      console.log("[uplink] Forward failed — command logged only");
    }
  } else {
    uplinkWs.send(payload);
  }
}

// ── TCP rigctld server (GPredict radio control) ─────────────────────────────
let rigFreq = 0;

const rigServer = net.createServer((sock) => {
  const addr = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[rigctld] GPredict radio connected from ${addr}`);
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

      const normalised = cmd
        .replace(/^\\set_freq\s+/, "F ")
        .replace(/^\\get_freq$/, "f")
        .replace(/^\\set_mode\s+/, "M ")
        .replace(/^\\get_mode$/, "m")
        .replace(/^\\quit$/, "q");

      if (normalised === "f") {
        sock.write(`${rigFreq}\n`);
      } else if (normalised.startsWith("F ")) {
        const freq = parseFloat(normalised.slice(2).trim());
        if (!isNaN(freq)) {
          rigFreq = freq;
          broadcast({ type: "frequency", freqHz: freq });
          console.log(`[rigctld] → FREQ=${freq} Hz`);
        }
        sock.write("RPRT 0\n");
      } else if (normalised === "m") {
        sock.write("USB\n200000\n");
      } else if (normalised.startsWith("M ")) {
        sock.write("RPRT 0\n");
      } else if (normalised === "_" || cmd === "\\dump_state") {
        sock.write([
          "0",
          "1",
          "",
          "0.000000 6000000000.000000",
          "",
          "0x0",
          "0x0",
          "",
        ].join("\n") + "\n");
      } else if (normalised === "q") {
        sock.end();
      } else {
        console.log(`[rigctld] UNKNOWN: ${JSON.stringify(cmd)}`);
        sock.write("RPRT 0\n");
      }
    }
  });

  sock.on("close", () => {
    console.log(`[rigctld] GPredict radio disconnected (${addr})`);
    rigClients.delete(sock);
    broadcast({ type: "radioStatus", radioConnected: rigClients.size > 0 });
  });

  sock.on("error", (e) => console.error("[rigctld] Socket error:", e.message));
});

rigServer.listen(4532, "0.0.0.0", () => {
  console.log("[rigctld] Listening on TCP 0.0.0.0:4532");
  console.log("          → Point GPredict's radio host to localhost:4532");
});
