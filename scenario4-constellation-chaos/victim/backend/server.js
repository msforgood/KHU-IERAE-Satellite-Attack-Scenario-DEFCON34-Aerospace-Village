// server.js — victim Ground Station backend (scenario 4 · constellation chaos).
//
//   :4536  WS  ← (optional) OpenVSA / VSA forwards uplink-command here
//   :4540  HTTP+WS → serves the GS dashboard (monitor 2) + broadcasts events
//
// Flow: uplink-command(orbit_maneuver) → decode the delta-v → compute the
// deterministic collision outcome with the SAME orbital math the sim uses
// (satellite-sim/kepler.js) so the attacker console and this dashboard agree →
// broadcast a "maneuver" event. The frontend sim animates the burn; if it
// collides, the dashboard raises the alarm and plays the debris video.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WSServer } = require("./miniws");

const FRONTEND = path.resolve(__dirname, "..", "frontend");
const SIM_DIR = path.resolve(__dirname, "..", "..", "satellite-sim");
const ASSET_DIR = path.resolve(__dirname, "..", "..", "assets");
const HTTP_PORT = +(process.env.GS_HTTP_PORT || 4540);
const UPLINK_PORT = +(process.env.UPLINK_PORT || 4536);

// ── shared orbital math + constellation (the sim seam, reused server-side) ────
global.window = global;
require(path.join(SIM_DIR, "kepler.js"));     // -> global.SatKepler
require(path.join(SIM_DIR, "scenario.js"));   // -> global.Scenario4 (uses SatKepler)
const K = global.SatKepler;
const Scenario4 = global.Scenario4;

// ── GS state (thin; the frontend sim owns the animation + telemetry) ─────────
// videoPlayed flips true when monitor 2 actually plays the debris-collision video;
// the attacker console polls /api/state to know the collision was REALLY seen (not
// just predicted) and only then shows its "attack succeeded" screen.
let gsState = { status: "nominal", maneuver: null, outcome: null, ts: null, videoPlayed: false };

function reset() {
  gsState = { status: "nominal", maneuver: null, outcome: null, ts: null, videoPlayed: false };
  browserWss.broadcast(JSON.stringify({ type: "reset" }));
  console.log("[gs] reset -> nominal");
}

// decode the 6-byte payload (int16 BE: altitude km, inclination x10, RAAN x10)
function toByte(x) { return typeof x === "number" ? x & 0xff : parseInt(x, 16) & 0xff; }
function decodeManeuver(payload) {
  const b = (payload || []).map(toByte);
  const i16 = (hi, lo) => { let v = ((hi << 8) | lo); if (v & 0x8000) v -= 0x10000; return v; };
  return { altKm: b.length >= 2 ? i16(b[0], b[1]) : 600,
           inc:   b.length >= 4 ? i16(b[2], b[3]) / 10 : 0,
           raan:  b.length >= 6 ? i16(b[4], b[5]) / 10 : 0 };
}

// deterministic outcome — mirrors SatSim.applyManeuver (does the new orbit pass over a satellite?)
function computeOutcome(altKm, inc, raan) {
  const sats = Scenario4.satellites();
  const atk = sats.filter((s) => s.role === "attacker")[0];
  const newKep = [K.EarthRadius + altKm * 1000, 0, inc, raan, 0, atk.kep[5]];
  const thr = Scenario4.simOpts.collisionThreshold || 130000;
  const NU = []; for (let d = 0; d <= 360; d += 2) NU.push(d);
  const orbit = K.keplerianToECI(newKep[0], newKep[1], newKep[2], newKep[3], newKep[4], NU);
  let best = null;
  for (const s of sats) {
    if (s.role === "attacker") continue;
    // different orbital node (RAAN) => ENIGMA-1 cannot line its plane up, so it can never hit it
    const dRaan = Math.abs(((s.kep[3] - raan) % 360 + 540) % 360 - 180);
    if (dRaan > 2) continue;
    const P = K.keplerianToECI(s.kep[0], s.kep[1], s.kep[2], s.kep[3], s.kep[4], s.kep[5]);
    let md = Infinity;
    for (let i = 0; i < NU.length; i++) {
      const dx = orbit.x[i] - P.x, dy = orbit.y[i] - P.y, dz = orbit.z[i] - P.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d < md) md = d;
    }
    if (!best || md < best.d) best = { d: md, name: s.name };
  }
  const collided = !!best && best.d <= thr;
  return {
    collided: collided,
    victim: collided ? best.name : null,
    altKm: Math.round(altKm), incDeg: inc, raanDeg: raan,
    distKm: best ? Math.round(best.d / 1000) : null,
  };
}

// ── apply an incoming uplink command ────────────────────────────────────────
// Scenario 5: the attacker console already solved the whole collision (geometry +
// timing) and sends it here. We just record it and replay it on monitor 2.
function handleUplink(msg) {
  const command = msg.command;
  if (command !== "orbit_collision") {
    browserWss.broadcast(JSON.stringify({ type: "uplink", command: command, rejected: false }));
    return { ok: true, outcome: null, note: "non-collision command ignored by sim" };
  }
  const outcome = { collided: true, victim: msg.victim || "AURORA-2",
                    closingKmS: msg.closingKmS, collisionPoint: msg.collisionPoint };
  gsState = { status: "collision-course", maneuver: msg, outcome: outcome, ts: Date.now(), videoPlayed: false };
  browserWss.broadcast(JSON.stringify({ type: "collision",
    victim: outcome.victim, closingKmS: msg.closingKmS, collisionPoint: msg.collisionPoint,
    attackerKep: msg.attackerKep, victimKep: msg.victimKep, victimNuDeg: msg.victimNuDeg,
    collideInSec: msg.collideInSec, impactTargetSec: msg.impactTargetSec || 18 }));
  console.log(`[uplink] COLLISION course -> ${outcome.victim} @ ${msg.closingKmS} km/s`);
  return { ok: true, outcome };
}

// ── :4536 — VSA / OpenVSA uplink input (optional) ───────────────────────────
const uplinkWss = WSServer.listen(UPLINK_PORT, "0.0.0.0", () =>
  console.log(`[uplink] WS listening on :${UPLINK_PORT}`));
uplinkWss.on("connection", (ws) => {
  ws.on("message", (data) => {
    try { const msg = JSON.parse(data); if (msg.type === "uplink-command") handleUplink(msg); }
    catch { /* ignore */ }
  });
});

// ── :4540 — dashboard http + browser WS ─────────────────────────────────────
const CT = { ".html": "text/html; charset=utf-8", ".css": "text/css",
  ".js": "application/javascript", ".json": "application/json", ".mp4": "video/mp4",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

function serveFile(res, baseDir, rel) {
  const fp = path.normalize(path.join(baseDir, rel));
  if (!fp.startsWith(baseDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": CT[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(fp).pipe(res);
}

const httpServer = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ state: gsState }));
  }
  if (url === "/api/inject" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const out = handleUplink({ type: "uplink-command", ...JSON.parse(body || "{}") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(e) })); }
    });
    return;
  }
  if (url === "/api/reset" && req.method === "POST") {
    reset();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  // monitor 2 reports that it actually played the debris-collision video, so the
  // attacker console can switch from "impact countdown" to "attack succeeded".
  if (url === "/api/collision-reported" && req.method === "POST") {
    gsState.videoPlayed = true;
    console.log("[gs] collision video played on monitor 2 -> videoPlayed = true");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.startsWith("/sim/")) return serveFile(res, SIM_DIR, url.slice("/sim/".length));
  if (url.startsWith("/assets/")) return serveFile(res, ASSET_DIR, url.slice("/assets/".length));

  serveFile(res, FRONTEND, url === "/" ? "index.html" : url.replace(/^\//, ""));
});

const browserWss = new WSServer(httpServer);
browserWss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", state: gsState, scenario: {
    altKm: Scenario4.altKm, constellation: Scenario4.target.constellation,
    count: Scenario4.target.constellationCount, neighbors: Scenario4.neighborsInfo } }));
  // resume an in-progress collision (e.g. a page refresh mid-impact)
  if (gsState.maneuver && gsState.status === "collision-course") {
    const m = gsState.maneuver;
    ws.send(JSON.stringify({ type: "collision", victim: m.victim, closingKmS: m.closingKmS,
      collisionPoint: m.collisionPoint, attackerKep: m.attackerKep, victimKep: m.victimKep,
      victimNuDeg: m.victimNuDeg, collideInSec: m.collideInSec, impactTargetSec: m.impactTargetSec || 18, resume: true }));
  }
});

httpServer.listen(HTTP_PORT, "0.0.0.0", () =>
  console.log(`[gs] dashboard -> http://localhost:${HTTP_PORT}  (monitor 2)`));
