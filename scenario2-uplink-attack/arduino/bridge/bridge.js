#!/usr/bin/env node
// bridge.js — GS backend → Arduino serial bridge (zero-dependency, pure Node).
//
// Non-invasive glue: the victim server is NOT modified. This process
// polls its /api/state endpoint and streams the live satellite state to the two
// Arduinos over USB serial, so the physical panel/antenna track the dashboard.
//
//   GS :4540 /api/state ──poll──▶ bridge ──serial──▶ solar_panel_uno  (ANG/MODE or SPIN/STOP)
//                                        └─serial──▶ antenna_gimbal   (AZEL/MODE, SWEEP on acquire)
//
// Antenna: on the `acquiring` flag (POST /api/acquire during gpredict pointing) the
// antenna SWEEPs left↔right; under attack (tumbling) it jitters; else it tracks az/el.
//
// Serial is done without the `serialport` npm package: on macOS/Linux a tty is
// just a file, so we configure it with stty(1) then fs.createWriteStream(). This
// is host→board write only — all we need to drive the motors.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   SOLAR_PORT=/dev/cu.usbmodemXXXX ANT_PORT=/dev/cu.usbmodemYYYY \
//     node bridge.js
//
//   Either port may be omitted — the bridge drives whatever is present.
//   With neither set it lists candidate /dev/cu.usbmodem* ports and exits.
//
//   GS_URL         (default http://localhost:4540)
//   POLL_MS        (default 150)
//   BAUD           (default 9600)
//   PANEL_SPIN     (default off) 1 = solar panel is a continuous-rotation servo → SPIN

const http = require("http");
const fs = require("fs");
const { execFileSync } = require("child_process");

const GS_URL   = process.env.GS_URL || "http://localhost:4540";
const POLL_MS  = +(process.env.POLL_MS || 150);
const BAUD     = +(process.env.BAUD || 9600);
// PANEL_SPIN=1 → the solar panel is a continuous-rotation servo (FS90R / modded
// SG90): under attack it SPINs endlessly instead of swinging to an off-sun angle.
const PANEL_SPIN = /^(1|true|yes)$/i.test(process.env.PANEL_SPIN || "");
const RESET_WAIT_MS = 2000;   // Uno auto-resets when the port opens; wait it out

// ── serial port helper ──────────────────────────────────────────────────────
function listCandidates() {
  try {
    return fs.readdirSync("/dev")
      .filter((f) => f.startsWith("cu.usbmodem") || f.startsWith("cu.usbserial"))
      .map((f) => "/dev/" + f);
  } catch { return []; }
}

function openPort(path, label) {
  if (!path) return null;
  if (!fs.existsSync(path)) {
    console.error(`[bridge] ${label}: port not found: ${path}`);
    return null;
  }
  // Configure the tty: raw, chosen baud, 8N1, no flow control. macOS uses -f,
  // Linux uses -F; try both so the bridge is portable.
  const sttyArgs = [BAUD, "cs8", "-cstopb", "-parenb", "-echo", "raw"].map(String);
  let configured = false;
  for (const flag of ["-f", "-F"]) {
    try { execFileSync("stty", [flag, path, ...sttyArgs], { stdio: "ignore" }); configured = true; break; }
    catch { /* try the other flag */ }
  }
  if (!configured) console.warn(`[bridge] ${label}: stty config failed (continuing anyway)`);

  const stream = fs.createWriteStream(path, { flags: "w" });
  stream.on("error", (e) => console.error(`[bridge] ${label} write error:`, e.message));
  console.log(`[bridge] ${label} → ${path} @ ${BAUD} (waiting ${RESET_WAIT_MS}ms for board reset)`);
  return { path, label, stream, ready: false };
}

function send(port, line) {
  if (!port || !port.ready) return;
  port.stream.write(line + "\n");
}

// ── main ────────────────────────────────────────────────────────────────────
const solarPath = process.env.SOLAR_PORT || "";
const antPath   = process.env.ANT_PORT   || "";

if (!solarPath && !antPath) {
  const c = listCandidates();
  console.log("No SOLAR_PORT / ANT_PORT set.");
  console.log(c.length ? "Candidate ports:\n  " + c.join("\n  ")
                       : "No /dev/cu.usbmodem* ports detected — check the cable (must be data-capable) and connect directly, not through a hub.");
  console.log("\nExample:\n  SOLAR_PORT=/dev/cu.usbmodemXXXX ANT_PORT=/dev/cu.usbmodemYYYY node bridge.js");
  process.exit(0);
}

const solar = openPort(solarPath, "solar");
const ant   = openPort(antPath, "antenna");

// Let the boards finish their USB-reset boot before we start streaming.
setTimeout(() => {
  if (solar) { solar.ready = true; send(solar, "PING"); }
  if (ant)   { ant.ready = true;   send(ant, "PING"); }
  console.log(`[bridge] polling ${GS_URL}/api/state every ${POLL_MS}ms`);
  setInterval(poll, POLL_MS);
}, RESET_WAIT_MS);

// dedupe: only transmit when the rounded value actually changes
let lastSolarAng = null, lastSolarMode = null;
let lastAz = null, lastEl = null, lastAntMode = null;

function poll() {
  const req = http.get(GS_URL + "/api/state", (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try { drive(JSON.parse(body).state || {}); } catch { /* ignore malformed */ }
    });
  });
  req.on("error", () => { /* GS not up yet; keep polling */ });
  req.setTimeout(POLL_MS, () => req.destroy());
}

function drive(state) {
  const flags = state._flags || {};
  const attack = !!(flags.tumbling || flags.solarAttacked);

  // ── solar panel ──
  if (solar) {
    if (PANEL_SPIN) {
      // continuous-rotation panel: SPIN under attack, STOP otherwise.
      const mode = attack ? 1 : 0;
      if (mode !== lastSolarMode) { send(solar, mode ? "SPIN" : "STOP"); lastSolarMode = mode; }
    } else {
      // standard positional servo: stream the falling angle + attack LED mode.
      const ang = Math.round(clamp(state["solar_panel.angle"] ?? 90, 0, 180));
      const mode = attack ? 1 : 0;
      if (ang !== lastSolarAng)   { send(solar, "ANG " + ang);   lastSolarAng = ang; }
      if (mode !== lastSolarMode) { send(solar, "MODE " + mode); lastSolarMode = mode; }
    }
  }

  // ── antenna ── priority: tumbling(1) > acquiring sweep(2) > nominal(0)
  if (ant) {
    const antMode = flags.tumbling ? 1 : (flags.acquiring ? 2 : 0);
    if (antMode !== lastAntMode) {
      send(ant, antMode === 2 ? "SWEEP" : "MODE " + antMode);
      lastAntMode = antMode;
      if (antMode !== 2) { lastAz = lastEl = null; }   // force an AZEL resync after a sweep
    }
    // SWEEP self-oscillates on the board — only stream az/el when not sweeping.
    if (antMode !== 2) {
      const az = Math.round(state["antenna.az"] ?? 180);
      const el = Math.round(state["antenna.el"] ?? 45);
      if (az !== lastAz || el !== lastEl) { send(ant, `AZEL ${az} ${el}`); lastAz = az; lastEl = el; }
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

process.on("SIGINT", () => {
  if (solar) try { solar.stream.end(); } catch {}
  if (ant)   try { ant.stream.end(); } catch {}
  process.exit(0);
});
