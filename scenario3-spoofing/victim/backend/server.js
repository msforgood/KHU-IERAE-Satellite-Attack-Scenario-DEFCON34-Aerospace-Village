// server.js — victim Ground Station backend.
//
//   :4536  WS  ← OpenVSA forwards uplink-command here (env UPLINK_DEST on OpenVSA)
//   :4540  HTTP+WS → serves the GS dashboard and broadcasts live telemetry
//
// Flow: uplink-command(adcs_torque) → satellite state engine applies attack →
// tumbling → sun-track loss → power collapse → battery drain → dashboard alarm.
// Also fires an optional Arduino HTTP trigger hook on attack onset (ARDUINO_URL);
// the physical panel/antenna are driven live by arduino/bridge/bridge.js polling /api/state.
//
// Scenario 3 (drone spoof): POST /api/spoof {on:true} makes a drone-impersonated
// "healthy" beacon overwrite the DASHBOARD telemetry (browser WS) → the alarm is
// suppressed and everything reads NOMINAL, while /api/state keeps the real tumbling
// state so the physical motors never stop. The deception lives only on the screen.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WSServer } = require("./miniws");
const { createSatelliteState } = require("./satellite-state");

// satellite config lives in the OpenVSA fork's demosat plugin (single source of truth)
const PLUGIN = path.resolve(__dirname, "..", "..", "attacker", "openvsa", "satellites");
const FRONTEND = path.resolve(__dirname, "..", "frontend");
const HTTP_PORT = +(process.env.GS_HTTP_PORT || 4540);
const UPLINK_PORT = +(process.env.UPLINK_PORT || 4536);
const ATTACK_DELAY_MS = +(process.env.ATTACK_DELAY_MS || 4000);
const ARDUINO_URL = process.env.ARDUINO_URL || "";

// ── satellite state engine ──────────────────────────────────────────────────
const sat = createSatelliteState();
sat.loadFromFiles({
  hardware: path.join(PLUGIN, "demosat", "hardware.json"),
  effects:  path.join(PLUGIN, "hardware-effects.json"),
  panel:    path.join(PLUGIN, "demosat", "panel.json"),
});

let lastState = sat.getState();
let tumblingWas = false;

// ── SCENARIO 3 · drone telemetry spoof ──────────────────────────────────────
// A drone impersonates the satellite and replays a "healthy" beacon at the GS.
// Effect: the operator's DASHBOARD reads NOMINAL (alarm suppressed) while the
// REAL satellite keeps tumbling — /api/state (Arduino motors) stays truthful, so
// the physical panel/antenna keep running. The lie lives only on the screen.
const NOMINAL = JSON.parse(JSON.stringify(sat.getState())); // pristine defaults @ boot
let spoofing = false;

// what the browser dashboard is shown: real state, or the drone's healthy forgery.
function browserState(realState) {
  if (!spoofing) return realState;
  const s = JSON.parse(JSON.stringify(NOMINAL));
  s["obc.uptime"] = realState["obc.uptime"];               // clock keeps advancing
  // faint liveliness so the forged telemetry doesn't look frozen
  s["solar_panel.power"] = +(4.15 + Math.random() * 0.1).toFixed(2);
  s["battery.level"]     = +(98 + Math.random() * 1.5).toFixed(1);
  s["obc.temp"]          = +(22 + (Math.random() - 0.5)).toFixed(1);
  s["adcs.roll"]  = +((Math.random() - 0.5) * 0.4).toFixed(2);
  s["adcs.pitch"] = +((Math.random() - 0.5) * 0.4).toFixed(2);
  s["adcs.yaw"]   = +((Math.random() - 0.5) * 0.4).toFixed(2);
  s._flags = {};                                           // no tumbling/attack flags
  return s;
}
function broadcastState() {
  browserWss.broadcast(JSON.stringify({ type: "state", state: browserState(lastState) }));
}

sat.onChange((s) => {
  lastState = s;                                           // REAL state (truth for /api/state + motors)
  broadcastState();                                        // dashboard sees real OR spoofed
  // Arduino trigger hook — rising edge of the attack (tumbling begins). Fires on
  // the REAL state, so the physical panel spins even while the screen says NOMINAL.
  if (s._flags.tumbling && !tumblingWas) fireArduino(s);
  tumblingWas = !!s._flags.tumbling;
});
sat.start();

function fireArduino(s) {
  const torque = s["adcs.torque"];
  console.log(`[arduino] ⚡ TRIGGER: solar panel runaway (torque=${torque} mNm) — GS→Arduino hook`);
  if (ARDUINO_URL) {
    try {
      const req = http.request(ARDUINO_URL, { method: "POST" });
      req.on("error", () => {});
      req.end(JSON.stringify({ event: "solar_runaway", torque }));
    } catch {}
  }
}

// ── apply an incoming uplink command ────────────────────────────────────────
function handleUplink(msg) {
  const command = msg.command;
  const payload = msg.payload || [];   // forward patch includes decoded payload
  console.log(`[uplink] RX ${command} payload=${JSON.stringify(payload)} @ ${msg.frequency || "?"} MHz`);
  const res = sat.applyCommand(command, payload, { baseDelay: ATTACK_DELAY_MS });
  browserWss.broadcast(JSON.stringify({
    type: "uplink", command, payload, at: msg.timestamp || null,
    rejected: !!(res && res._rejected), reason: res && res._rejectMessage || null,
  }));
}

// ── :4536 — OpenVSA uplink input ────────────────────────────────────────────
const uplinkWss = WSServer.listen(UPLINK_PORT, "0.0.0.0", () =>
  console.log(`[uplink] WS listening on :${UPLINK_PORT} (point OpenVSA UPLINK_DEST here)`));
uplinkWss.on("connection", (ws) => {
  console.log("[uplink] OpenVSA connected");
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "uplink-command") handleUplink(msg);
    } catch { /* ignore */ }
  });
});

// ── :4540 — dashboard http + browser state WS ───────────────────────────────
const CT = { ".html": "text/html; charset=utf-8", ".css": "text/css",
  ".js": "application/javascript", ".json": "application/json",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };

const httpServer = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // CORS: let the attacker console (served from another origin) call the API.
  if (url.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  if (url === "/api/state") {
    // always the REAL state (Arduino bridge / motors read this — truth persists)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ state: lastState, panel: sat.getPanelConfig(), spoofing }));
  }
  // drone spoof hook (scenario 3): POST {} (or {"on":true}) → dashboard reads NOMINAL
  // while the satellite keeps tumbling; POST {"on":false} clears it.
  if (url === "/api/spoof" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let on = true;
      try { const j = JSON.parse(body || "{}"); if (j.on === false) on = false; } catch {}
      spoofing = on;
      console.log(`[spoof] drone beacon ${on ? "ACTIVE — GS alarm SUPPRESSED (satellite still tumbling)" : "cleared — real telemetry restored"}`);
      broadcastState();  // flip the dashboard immediately
      res.writeHead(200); res.end(JSON.stringify({ spoofing }));
    });
    return;
  }
  // test hook: inject a mock uplink-command without OpenVSA
  if (url === "/api/inject" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { handleUplink({ type: "uplink-command", ...JSON.parse(body || "{}") }); res.writeHead(200); res.end("{}"); }
      catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  // pointing hook: gpredict/OpenVSA (or the operator) signals "target acquired" →
  // the antenna sweeps left↔right. POST {} to set, {"on":false} to clear.
  if (url === "/api/acquire" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let on = true;
      try { const j = JSON.parse(body || "{}"); if (j.on === false) on = false; } catch {}
      sat.setFlag("acquiring", on);
      console.log(`[point] target ${on ? "ACQUIRED — antenna sweep" : "released"}`);
      res.writeHead(200); res.end("{}");
    });
    return;
  }
  if (url === "/api/reset" && req.method === "POST") {
    sat.reset(); tumblingWas = false; spoofing = false; res.writeHead(200); return res.end("{}");
  }

  let file = url === "/" ? "/index.html" : url;
  const fp = path.normalize(path.join(FRONTEND, file));
  if (!fp.startsWith(FRONTEND) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": CT[path.extname(fp)] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

const browserWss = new WSServer(httpServer);
browserWss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "panel", panel: sat.getPanelConfig() }));
  ws.send(JSON.stringify({ type: "state", state: browserState(lastState) }));
});

httpServer.listen(HTTP_PORT, "0.0.0.0", () =>
  console.log(`[gs] dashboard → http://localhost:${HTTP_PORT}  (state WS on same port)`));
