// app.js — victim Ground Station dashboard (monitor 2).
// Receives a "maneuver" event over WebSocket, plays the collision in the
// satellite sim (top), and drives the telemetry + alarm below. The sim (client
// side) owns the animation; this script maps sim events to the dashboard.
'use strict';

const $ = (s) => document.querySelector(s);
let sim = null;
let scenarioInfo = { altKm: 600, constellation: 'AURORA', count: 2 };
let collided = false;

// ── clock ───────────────────────────────────────────────────────────────────
setInterval(() => {
  const c = $('#clock');
  if (c) c.textContent = new Date().toTimeString().slice(0, 8);
}, 1000);

// ── simulation (playback) ────────────────────────────────────────────────────
function initSim() {
  const cv = $('#playSim');
  if (!cv || typeof SatSim === 'undefined' || typeof Scenario4 === 'undefined') return;
  sim = new SatSim(cv, Object.assign({
    mode: 'playback',
    onTick: onTick,
    onCollision: onCollision,
    onOutcome: onOutcome
  }, Scenario4.simOpts));
  sim.setSatellites(Scenario4.satellites());
  sim.lockOn('demosat');           // Earth-centred view, locked onto the attacker satellite
  sim._resize();
}

function armAndFire(altKm, inc, raan) {
  if (!sim) return;
  collided = false;
  collisionReported = false;
  aftermathShown = false; clearTimeout(videoTimer);
  document.body.classList.remove('collision');
  hideVideo();
  hideAlarm();
  startHeartbeat();                            // beacons live again for the new maneuver
  sim.setSatellites(Scenario4.satellites());   // canonical start - matches the GS outcome
  sim.lockOn('demosat');
  sim.applyManeuver({ altKm, inc, raan });
}

function onTick(t) {
  setVal('#mAlt', t.altKm + ' km', t.collided ? 'danger' : 'nominal');
  setVal('#mInc', t.incDeg + '°', 'nominal');
  setVal('#mRaan', t.raanDeg + '°', 'nominal');
  const nAlive = sim ? sim.sats.filter((s) => s.role === 'neighbor' && s.alive).length : scenarioInfo.count;
  setVal('#cAlive', nAlive + ' / ' + scenarioInfo.count, nAlive < scenarioInfo.count ? 'danger' : 'nominal');
  const bar = $('#cBar');
  if (bar) {
    bar.style.width = (nAlive / scenarioInfo.count * 100) + '%';
    bar.parentElement.className = 'bar' + (nAlive < scenarioInfo.count ? ' danger' : '');
  }
}

function onCollision(evt) {
  collided = true;
  const victim = evt.victimId ? evt.victimId.toUpperCase() : 'a constellation member';
  setBanner('danger', `COLLISION - ENIGMA-1 struck ${victim}. Debris cascade in progress.`);
  setTag('#orbitTag', 'danger', 'DESTROYED');
  setTag('#threatTag', 'danger blink', 'DEBRIS CASCADE');
  killHeartbeat();                              // beacons flatline - the satellite is gone
  setVal('#cClosest', '0 km · IMPACT', 'danger');
  const sb = $('#simbar'); if (sb) { sb.textContent = '⚠ IMPACT - debris cascade'; sb.className = 'simbar danger'; }
  playVideo(victim);                            // full-screen video; red blink + ALERT come AFTER it ends
}
function onOutcome(evt) {
  if (evt.collided) return;   // handled by onCollision
  setBanner('warn', 'Maneuver complete — ENIGMA-1 missed the constellation (no collision). Awaiting reset.');
  setTag('#orbitTag', 'warn', 'OFF-NOMINAL ORBIT');
  setTag('#threatTag', 'warn', 'ORBIT DRIFT');
  const sb = $('#simbar'); if (sb) { sb.textContent = 'No collision — reset to retry'; sb.className = 'simbar warn'; }
}

// ── dashboard helpers ────────────────────────────────────────────────────────
function setVal(sel, text, cls) {
  const e = $(sel); if (!e) return;
  e.textContent = text;
  if (cls) e.className = 'val ' + cls;
}
function setTag(sel, cls, text) {
  const e = $(sel); if (!e) return;
  e.className = 'tag ' + cls; e.textContent = text;
}
function setBanner(kind, text) {
  const b = $('#statusBanner'); if (b) b.className = 'banner ' + kind;
  const t = $('#bannerText'); if (t) t.textContent = text;
}
function addLog(cmd, detail, danger) {
  const log = $('#log'); if (!log) return;
  const empty = log.querySelector('.logempty'); if (empty) empty.remove();
  const it = document.createElement('div');
  it.className = 'logitem' + (danger ? '' : ' info');
  it.innerHTML = `<div class="lt">${new Date().toTimeString().slice(0, 8)}</div>
                  <div class="lc">${cmd}</div><div class="ld">${detail}</div>`;
  log.insertBefore(it, log.firstChild);
}

// ── alarm + debris video ─────────────────────────────────────────────────────
// On collision: play the full-screen debris video. ONLY AFTER it ends does the
// page start blinking red with a centered ALERT (persistent until reset).
let aftermathShown = false;
let videoTimer = null;
function showAlarm(victim) {
  const a = $('#alarm'); if (!a) return;
  const d = $('#alarmDesc');
  if (d) d.textContent = `Unauthorized orbit maneuver - ENIGMA-1 struck ${victim}. Debris cascade in progress across AURORA.`;
  a.classList.remove('hidden');   // stays up until reset
}
function hideAlarm() { const a = $('#alarm'); if (a) a.classList.add('hidden'); }
function playVideo(victim) {
  const ov = $('#videoOverlay'), v = $('#collisionVideo');
  const done = () => afterVideo(victim);
  // tell the backend the debris-collision video is playing, so the attacker
  // console (which polls /api/state) can flip to its "attack succeeded" screen.
  reportCollision();
  if (!ov || !v) { done(); return; }
  ov.classList.remove('hidden');
  v.onended = done;
  try { v.currentTime = 0; const p = v.play(); if (p && p.catch) p.catch(() => done()); } catch (e) { done(); }
  // safety net: only fire if 'ended' never came AND the clip is not still playing
  clearTimeout(videoTimer);
  videoTimer = setTimeout(() => { if (v.paused || v.ended) done(); }, 12000);
}
// after the video: hide it, blink the page red, raise the centered ALERT
function afterVideo(victim) {
  if (aftermathShown) return; aftermathShown = true;
  clearTimeout(videoTimer);
  const ov = $('#videoOverlay'); if (ov) ov.classList.add('hidden');
  document.body.classList.add('collision');   // page-wide red blink
  showAlarm(victim);
}
function hideVideo() {
  const ov = $('#videoOverlay'), v = $('#collisionVideo'); if (!ov) return;
  ov.classList.add('hidden');
  if (v) { try { v.pause(); } catch (e) {} }
  clearTimeout(videoTimer);
}
// report the collision-video playback to the GS backend (best-effort, fire once)
let collisionReported = false;
function reportCollision() {
  if (collisionReported) return; collisionReported = true;
  try { fetch('/api/collision-reported', { method: 'POST' }).catch(() => {}); } catch (e) {}
}

// ── TT&C telemetry beacons (multi-channel) ───────────────────────────────────
// Several channels stream live while ENIGMA-1 is alive; ALL flatline (turn red)
// the moment a collision destroys it.
let hbAlive = true;
let hbTimer = null;
let hbBeatQueue = 0;                                    // frames left in the current heartbeat spike
let hbChannels = [];                                   // { canvas, ctx, samples, type, phase }
const QRS = [0, 0.12, -0.18, 1.0, -0.45, 0.15, 0, 0, 0, 0];
const HB_DEFS = [
  { id: 'hbEcg0', type: 'beacon' },
  { id: 'hbEcg1', type: 'attitude' },
  { id: 'hbEcg2', type: 'power' },
  { id: 'hbEcg3', type: 'downlink' },
];

function initHeartbeat() {
  hbChannels = HB_DEFS.map((d) => {
    const c = $('#' + d.id);
    return c ? { canvas: c, ctx: c.getContext('2d'), samples: new Array(c.width).fill(0), type: d.type, phase: 0 } : null;
  }).filter(Boolean);
  startHeartbeat();
  requestAnimationFrame(ecgFrame);
}
function startHeartbeat() {
  hbAlive = true;
  hbChannels.forEach((ch) => ch.samples.fill(0));
  const dot = $('#hbDot'); if (dot) dot.classList.remove('dead');
  setHbStatus('LIVE', false);
  clearInterval(hbTimer);
  hbTimer = setInterval(() => { if (hbAlive) beat(); }, 1000);
  beat();
}
function beat() {
  const dot = $('#hbDot');
  if (dot) { dot.classList.remove('beat'); void dot.offsetWidth; dot.classList.add('beat'); }
  hbBeatQueue = QRS.length;
}
function killHeartbeat() {
  hbAlive = false;
  clearInterval(hbTimer); hbTimer = null;
  hbBeatQueue = 0;
  const dot = $('#hbDot'); if (dot) { dot.classList.remove('beat'); dot.classList.add('dead'); }
  setHbStatus('SIGNAL LOST', true);
}
function setHbStatus(text, dead) {
  const s = $('#hbStatus'); if (s) { s.textContent = text; s.className = 'hbstatus ' + (dead ? 'dead' : 'live'); }
}
function hbSample(ch) {
  if (!hbAlive) return 0;                               // dead => flat line
  ch.phase += 1;
  switch (ch.type) {
    case 'beacon':   return hbBeatQueue > 0 ? (QRS[QRS.length - hbBeatQueue] || 0) : (Math.random() - 0.5) * 0.05;
    case 'attitude': return Math.sin(ch.phase * 0.20) * 0.32 + (Math.random() - 0.5) * 0.22;
    case 'power':    return Math.sin(ch.phase * 0.07) * 0.6;
    case 'downlink': return (ch.phase % 24 < 3) ? 0.78 : (Math.random() - 0.5) * 0.06;
    default:         return 0;
  }
}
function ecgFrame() {
  hbChannels.forEach((ch) => { const v = hbSample(ch); ch.samples.push(v); ch.samples.shift(); drawChannel(ch); });
  if (hbBeatQueue > 0) hbBeatQueue--;
  requestAnimationFrame(ecgFrame);
}
function drawChannel(ch) {
  const w = ch.canvas.width, h = ch.canvas.height, ctx = ch.ctx, mid = h * 0.5;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = hbAlive ? '#33d17a' : '#ff3b4e';
  ctx.lineWidth = 2; ctx.beginPath();
  for (let x = 0; x < ch.samples.length; x++) {
    const y = mid - ch.samples[x] * (h * 0.42);
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

// ── reset ─────────────────────────────────────────────────────────────────────
function doReset() {
  collided = false;
  collisionReported = false;
  aftermathShown = false; clearTimeout(videoTimer);
  startHeartbeat();                            // beacons come back after reset
  document.body.classList.remove('collision');
  hideVideo(); hideAlarm();
  if (sim) { sim.reset(); sim.lockOn('demosat'); }
  setBanner('nominal', 'NOMINAL — all satellites separated and station-keeping');
  setTag('#orbitTag', 'nominal', 'STATION-KEEPING');
  setTag('#threatTag', 'nominal', 'NONE');
  const st = (Scenario4 && Scenario4.demosatStart) || { altKm: 600, inc: 50, raan: 25 };
  setVal('#mAlt', st.altKm + ' km', 'nominal');
  setVal('#mInc', st.inc + '°', 'nominal');
  setVal('#mRaan', st.raan + '°', 'nominal');
  setVal('#cClosest', '—', 'nominal');
  setVal('#cAlive', scenarioInfo.count + ' / ' + scenarioInfo.count, 'nominal');
  const bar = $('#cBar'); if (bar) { bar.style.width = '100%'; bar.parentElement.className = 'bar'; }
  const sb = $('#simbar'); if (sb) { sb.textContent = 'Awaiting uplink…'; sb.className = 'simbar'; }
}

// ── incoming maneuver ─────────────────────────────────────────────────────────
function onManeuver(m) {
  const el = { altKm: m.altKm, inc: m.inc, raan: m.raan };
  const out = m.outcome || {};
  addLog('orbit_maneuver', `alt ${el.altKm} km · inc ${el.inc}° · RAAN ${el.raan}°`, true);
  setBanner('warn', `MANEUVER IN PROGRESS — ENIGMA-1 changing orbit to inc ${el.inc}° / RAAN ${el.raan}°. Tracking…`);
  setTag('#orbitTag', 'warn', 'MANEUVERING');
  setTag('#threatTag', 'warn', out.collided ? 'COLLISION IMMINENT' : 'ELEVATED');
  setVal('#cClosest', (out.distKm != null ? out.distKm + ' km' : '—'), out.collided ? 'danger' : 'warn');
  const sb = $('#simbar');
  if (sb) {
    sb.textContent = out.collided ? '⚠ COLLISION COURSE — impact imminent' : 'Maneuver in progress — tracking orbit';
    sb.className = 'simbar ' + (out.collided ? 'danger' : 'warn');
  }
  armAndFire(el.altKm, el.inc, el.raan);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/');
  ws.onopen = () => { const d = $('#connDot'), t = $('#connText'); if (d) d.className = 'dot'; if (t) t.textContent = 'LINKED'; };
  ws.onclose = () => {
    const d = $('#connDot'), t = $('#connText'); if (d) d.className = 'dot off'; if (t) t.textContent = 'RECONNECTING…';
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (x) { return; }
    if (msg.type === 'hello') {
      if (msg.scenario) {
        scenarioInfo = msg.scenario;
        setVal('#ringAlt', (scenarioInfo.altKm || 600) + ' km (shared)', 'nominal');
        setVal('#cMembers', String(scenarioInfo.count), 'nominal');
        setVal('#cAlive', scenarioInfo.count + ' / ' + scenarioInfo.count, 'nominal');
      }
      if (msg.state && msg.state.status === 'nominal') { /* fresh */ }
    } else if (msg.type === 'maneuver') {
      onManeuver(msg);
    } else if (msg.type === 'reset') {
      doReset();
    } else if (msg.type === 'uplink') {
      addLog(msg.command || 'command', 'received', false);
    }
  };
}

initSim();
initHeartbeat();
connect();
