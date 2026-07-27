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
// Serial is done without the `serialport` npm package — see ./serial.js, the shared
// zero-dependency layer that hides the per-OS differences (stty vs mode.com, /dev/cu.*
// vs COM3, and the flags:"w" / OPEN_EXISTING trap on Windows). This side is host→board
// write only — all we need to drive the motors.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   SOLAR_PORT=/dev/cu.usbmodemXXXX ANT_PORT=/dev/cu.usbmodemYYYY \
//     node bridge.js
//   Windows:  SOLAR_PORT=COM4 ANT_PORT=COM3 node bridge.js
//
//   Either port may be omitted — the bridge drives whatever is present.
//   With neither set it lists candidate serial ports and exits.
//
//   GS_URL         (default http://localhost:4540)
//   POLL_MS        (default 150)
//   BAUD           (default 9600)
//   PANEL_SPIN     (default off) 1 = solar panel is a continuous-rotation servo → SPIN

const http = require("http");
const S = require("./serial");   // 크로스플랫폼 시리얼 레이어(포트 목록·설정·열기)

const GS_URL   = process.env.GS_URL || "http://localhost:4540";
const POLL_MS  = +(process.env.POLL_MS || 150);
const BAUD     = +(process.env.BAUD || 9600);
// PANEL_SPIN=1 → the solar panel is a continuous-rotation servo (FS90R / modded
// SG90): under attack it SPINs endlessly instead of swinging to an off-sun angle.
const PANEL_SPIN = /^(1|true|yes)$/i.test(process.env.PANEL_SPIN || "");
const RESET_WAIT_MS = 2000;   // Uno auto-resets when the port opens; wait it out

// ── serial port helper ──────────────────────────────────────────────────────
const listCandidates = () => S.listPorts();

function openPort(path, label) {
  if (!path) return null;
  // Windows 의 COM 이름은 파일시스템에 없어 existsSync 가 늘 false 다 → portExists 로 판단.
  if (!S.portExists(path)) {
    console.error(`[bridge] ${label}: port not found: ${path}`);
    return null;
  }
  // Configure the line: raw, chosen baud, 8N1, no flow control.
  // (macOS `stty -f` / Linux `stty -F` / Windows `mode COMx:` — serial.js 가 고른다.)
  if (!S.configure(path, BAUD)) console.warn(`[bridge] ${label}: 포트 설정 실패 (그대로 진행)`);

  let stream;
  try {
    stream = S.openWriter(path);        // Windows 는 flags:"r+" (COM 은 OPEN_EXISTING 만 허용)
  } catch (e) {
    console.error(`[bridge] ${label}: 포트 열기 실패 ${path}: ${e.message}`);
    return null;
  }
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
                       : "No serial ports detected — check the cable (must be data-capable) and connect directly, not through a hub.");
  console.log(S.IS_WIN
    ? "\nExample:\n  SOLAR_PORT=COM4 ANT_PORT=COM3 node bridge.js"
    : "\nExample:\n  SOLAR_PORT=/dev/cu.usbmodemXXXX ANT_PORT=/dev/cu.usbmodemYYYY node bridge.js");
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
let lastSolarAng = null, lastSolarMode = null, lastSolarModeAt = 0;
let lastAz = null, lastEl = null, lastAntMode = null;
const now = () => Date.now();

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
    } else if (attack) {
      // 공격: MODE 1(무한 왕복)을 ~1초마다 재전송한다. 이유 —
      //  ① 보드가 전원 sag 등으로 리셋되면 mode0(90°)로 부팅되는데, dedup 으로 MODE 1 을 다시
      //     안 보내면 스윕을 못 되찾는다 → 주기적 재전송으로 self-heal(1초 내 복귀).
      //  ② 공격 중 ANG 는 보내지 않는다. mode1 에선 무시되고, 혹 보드가 mode0 로 떨어지면
      //     ANG(공격 중 0~100+ 로 크게 진동)를 빠르게 좇아 "끝단↔원위치를 미친듯이" 튀는 사고를 낸다.
      //  매 폴(150ms)이 아니라 1초 간격으로 보내 시리얼 트래픽·충돌 위험을 낮춘다.
      if (lastSolarMode !== 1 || now() - lastSolarModeAt > 1000) {
        send(solar, "MODE 1"); lastSolarMode = 1; lastSolarModeAt = now();
      }
      lastSolarAng = null;            // nominal 복귀 시 ANG 가 다시 동기화되도록
    } else {
      // nominal: 정지(현재 위치 유지). 태양추적을 하지 않으므로 ANG 스트림을 보내지 않는다
      //  — ANG 를 보내면 sketch 가 그 각도로 이동해 "정지"가 깨진다. MODE 0 만 한 번 보낸다.
      if (lastSolarMode !== 0) { send(solar, "MODE 0"); lastSolarMode = 0; lastSolarAng = null; }
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

// 종료 시 모터를 반드시 정지시킨다. 스케치는 공격(mode 1)이면 스스로 계속 왕복하므로,
// 여기서 MODE 0(정지)을 보내지 않으면 브리지가 죽어도 서보/모터가 계속 돈다.
function shutdownBridge() {
  try { if (solar) solar.stream.write("MODE 0\n"); } catch {}
  try { if (ant)   ant.stream.write("MODE 0\n"); } catch {}
  setTimeout(() => {                       // 시리얼로 나갈 시간 확보 후 닫고 종료
    try { if (solar) solar.stream.end(); } catch {}
    try { if (ant)   ant.stream.end(); } catch {}
    process.exit(0);
  }, 250);
}
process.on("SIGINT",  shutdownBridge);
process.on("SIGTERM", shutdownBridge);
