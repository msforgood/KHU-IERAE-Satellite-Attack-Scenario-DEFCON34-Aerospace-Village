// GS dashboard — renders panel.json telemetry, styles by nominal/warn/danger,
// and escalates to an ENERGY SUPPLY CRITICAL alarm when the torque attack lands.
'use strict';

const COMM_STYLE = { CONNECTED: 'nominal', LOST: 'danger', DEAD: 'danger',
  'NO DOWNLINK': 'warn', REBOOTING: 'warn', 'LOW POWER': 'warn' };

let panelCfg = null;
let state = {};
let truthState = {};   // REAL physical state (drives the simulator even while telemetry is spoofed)
let simEnabled = false; // spacecraft simulator is a per-scenario feature (scn3 on, scn2 off)
const powHist = [], batHist = [], HIST = 120;

const $ = (s) => document.querySelector(s);
const g = (src) => state[src];

function connect() {
  const ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'panel') { panelCfg = m.panel; }
    else if (m.type === 'config') {
      simEnabled = !!m.simulator;
      document.body.classList.toggle('sim-on', simEnabled);
      const el = document.querySelector('.simcard');
      if (el) el.classList.toggle('hidden', !simEnabled);
      if (simEnabled) { sizeSat(); sizeMap(); }
    }
    else if (m.type === 'state') { state = m.state; onState(); }
    else if (m.type === 'truth') { truthState = m.state; }
    else if (m.type === 'uplink') { logUplink(m); }
  };
}
function setConn(ok) {
  $('#connDot').classList.toggle('off', !ok);
  $('#connText').textContent = ok ? 'LINK ESTABLISHED' : 'RECONNECTING…';
}

// ── value / style helpers ───────────────────────────────────────────────────
function fmtNum(v, d) { return (typeof v === 'number' ? v.toFixed(d || 0) : v); }
function fmtUptime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}
function numStyle(f, v) {
  if (typeof v !== 'number') return 'nominal';
  if (f.dangerBelow != null && v < f.dangerBelow) return 'danger';
  if (f.warnBelow != null && v < f.warnBelow) return 'warn';
  if (f.dangerAbove != null && v > f.dangerAbove) return 'danger';
  if (f.warnAbove != null && v > f.warnAbove) return 'warn';
  return 'nominal';
}

// returns {html, style, attacked}
function renderField(f) {
  const flags = state._flags || {};
  // indicator flag (e.g. SUN-TRACK LOST / TUMBLING / HIJACKED)
  let tag = null, style = 'nominal';

  if (f.indicator) {
    const on = !!g(f.indicator.source) || !!flags[f.indicator.source.replace('_flags.', '')];
    tag = { text: on ? f.indicator.danger : f.indicator.nominal, style: on ? 'danger' : 'nominal' };
    if (on) style = 'danger';
  }

  let valueTxt;
  if (f.sources) {
    let s = f.format || f.sources.map((_, i) => `{${i}}`).join(' / ');
    f.sources.forEach((src, i) => { s = s.replace(`{${i}}`, fmtNum(g(src), f.decimals)); });
    valueTxt = s;
  } else if (f.commStatus) {
    valueTxt = g(f.source);
    style = COMM_STYLE[valueTxt] || 'nominal';
    tag = { text: valueTxt, style };
    valueTxt = '';
  } else if (f.boolean) {
    const v = g(f.source);
    valueTxt = v ? f.boolean.true : f.boolean.false;
    if (f.dangerWhenFalse && !v) style = 'danger';
    else style = v ? 'nominal' : 'warn';
  } else if (f.format === 'uptime') {
    valueTxt = fmtUptime(g(f.source));
  } else {
    let v = g(f.source);
    style = numStyle(f, v);
    if (f.dangerValues && f.dangerValues.includes(v)) style = 'danger';
    valueTxt = `${fmtNum(v, f.decimals)}${f.unit || ''}`;
  }

  // bar (battery)
  let barHtml = '';
  if (f.bar) {
    const v = g(f.source) || 0;
    barHtml = `<span class="bar ${style}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span>`;
  }

  const parts = [];
  if (valueTxt !== '') parts.push(`<span class="val ${style}">${valueTxt}</span>`);
  if (barHtml) parts.push(barHtml);
  if (tag) parts.push(`<span class="tag ${tag.style} ${tag.style === 'danger' ? 'blink' : ''}">${tag.text}</span>`);

  return {
    html: `<div class="field"><span class="fl">${f.label}</span><span class="fr">${parts.join('')}</span></div>`,
    attacked: style === 'danger',
  };
}

function onState() {
  if (!panelCfg) return;
  const wrap = $('#panels');
  wrap.innerHTML = '';
  (panelCfg.sections || []).forEach((sec) => {
    let attacked = false;
    const rows = sec.fields.map((f) => { const r = renderField(f); attacked = attacked || r.attacked; return r.html; }).join('');
    const el = document.createElement('div');
    el.className = 'section' + (attacked ? ' attacked' : '');
    el.innerHTML = `<div class="stitle">${sec.title}</div>${rows}`;
    wrap.appendChild(el);
  });

  updateEnergy();
  updateBanner();
}

function updateEnergy() {
  const p = g('solar_panel.power') || 0, b = g('battery.level') || 0;
  powHist.push(p); batHist.push(b);
  if (powHist.length > HIST) powHist.shift();
  if (batHist.length > HIST) batHist.shift();
  const pmax = 4.2;
  $('#powNow').textContent = `${p.toFixed(2)} W`;
  $('#powNow').classList.toggle('danger', p < 2);
  $('#batNow').textContent = `${b.toFixed(1)} %`;
  $('#batNow').classList.toggle('danger', b < 30);
  drawGraph('powGraph', powHist, pmax, p < 2 ? '#ff3b4e' : '#33d17a');
  drawGraph('batGraph', batHist, 100, b < 30 ? '#ff3b4e' : b < 60 ? '#ffb020' : '#39c5ff');
}

function drawGraph(id, hist, max, color) {
  const cv = $('#' + id), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 6;
  ctx.clearRect(0, 0, W, H);
  // faint reference grid
  ctx.strokeStyle = 'rgba(120,141,160,.10)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (H * i) / 4; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  if (hist.length < 2) return;
  const xy = (i) => [(i / (HIST - 1)) * W, H - pad - (Math.max(0, Math.min(max, hist[i])) / max) * (H - 2 * pad)];
  // glow line
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.beginPath();
  hist.forEach((_, i) => { const [x, y] = xy(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.shadowBlur = 0;
  // gradient fill under the curve
  ctx.globalAlpha = 0.14; ctx.lineTo((hist.length - 1) / (HIST - 1) * W, H); ctx.lineTo(0, H);
  ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
  // leading scan dot
  const [lx, ly] = xy(hist.length - 1);
  ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
}

let wasCritical = false, alarmTimer = null;
function updateBanner() {
  const f = state._flags || {};
  const power = g('solar_panel.power') || 0, batt = g('battery.level') || 0;
  const energyCritical = f.tumbling || f.solarAttacked || power < 2 || batt < 30;
  const banner = $('#statusBanner'), alarm = $('#alarm');

  if (energyCritical) {
    banner.className = 'banner danger';
    $('#bannerText').textContent = 'ENERGY SUPPLY CRITICAL — unauthorized ADCS torque · solar array off-sun · battery draining';
    $('#alarmTitle').textContent = '⚠ ENERGY SUPPLY CRITICAL';
    $('#alarmDesc').textContent = `Reaction-wheel torque ${g('adcs.torque') ?? '?'} mNm — satellite tumbling, solar array losing sun-track. Power ${power.toFixed(1)}W, battery ${batt.toFixed(0)}%.`;
    // flash the full-screen alarm on attack onset, then reveal the live
    // telemetry (persistent red banner + red panels keep the crisis on screen)
    if (!wasCritical) {
      alarm.classList.remove('hidden');
      clearTimeout(alarmTimer);
      alarmTimer = setTimeout(() => alarm.classList.add('hidden'), 5000);
    }
    wasCritical = true;
    return;
  }
  wasCritical = false;
  alarm.classList.add('hidden');
  if (f.bricked || f.antennaAttacked || g('comm.status') === 'DEAD') {
    banner.className = 'banner danger';
    $('#bannerText').textContent = 'ANOMALY DETECTED — subsystem compromised';
    alarm.classList.add('hidden');
  } else if ((g('obc.temp') || 0) > 30 || batt < 60) {
    banner.className = 'banner warn';
    $('#bannerText').textContent = 'CAUTION — telemetry off-nominal';
    alarm.classList.add('hidden');
  } else {
    banner.className = 'banner nominal';
    $('#bannerText').textContent = 'NOMINAL — all subsystems operational';
    alarm.classList.add('hidden');
  }
}

function logUplink(m) {
  const log = $('#log');
  const item = document.createElement('div');
  item.className = 'logitem';
  const t = new Date().toLocaleTimeString();
  const pl = (m.payload || []).join(' ');
  item.innerHTML = `<div class="lt">${t} · uplink RX</div>
    <div class="lc">${m.rejected ? 'REJECTED' : 'ACCEPTED'} · ${m.command} ${pl ? '[' + pl + ']' : ''}</div>`;
  log.prepend(item);
  while (log.children.length > 12) log.removeChild(log.lastChild);
}

// ── SPACECRAFT VITALS · live-sign metric ─────────────────────────────────────
// Distil the telemetry into a single "instability" (0..1) that drives an ECG:
// nominal → calm sinus rhythm; attack → tachycardia + arrhythmia; dead → flatline.
function computeVitals() {
  const f = state._flags || {};
  const torque = Math.abs(g('adcs.torque') || 0);
  const power = g('solar_panel.power');
  const batt = g('battery.level');
  const dead = (typeof batt === 'number' && batt <= 0) || g('comm.status') === 'DEAD' || !!f.bricked;

  let inst = 0;
  inst += Math.min(1, torque / 800);
  if (typeof power === 'number') inst += Math.min(1, Math.max(0, (3.5 - power) / 3.5));
  if (typeof batt === 'number') inst += Math.min(1, Math.max(0, (60 - batt) / 60));
  if (f.tumbling || f.solarAttacked) inst += 0.7;
  if (f.antennaAttacked) inst += 0.3;
  inst = Math.min(1, inst / 2.4);

  const critical = f.tumbling || f.solarAttacked || (typeof power === 'number' && power < 2) || (typeof batt === 'number' && batt < 30);
  const warn = !critical && ((g('obc.temp') || 0) > 30 || (typeof batt === 'number' && batt < 60) || torque > 300);
  const bpm = dead ? 0 : Math.round(58 + inst * 96);
  const color = dead ? '#8b97a6' : critical ? '#ff3b4e' : warn ? '#ffb020' : '#33d17a';
  const level = dead ? 'dead' : critical ? 'danger' : warn ? 'warn' : 'ok';
  const label = dead ? '● NO SIGNAL — FLATLINE' : critical ? '● CRITICAL — ARRHYTHMIA'
    : warn ? '● ELEVATED — UNSTABLE' : '● STABLE RHYTHM';
  return { inst, dead, critical, warn, bpm, color, level, label };
}

// PQRST heartbeat morphology over one cycle phase p∈[0,1) (sum of gaussians)
function ecgWave(p) {
  const gv = (c, w, a) => a * Math.exp(-((p - c) ** 2) / (2 * w * w));
  return gv(0.15, 0.022, 0.13)   // P wave
       - gv(0.285, 0.008, 0.16)  // Q
       + gv(0.31, 0.0075, 1.0)   // R spike
       - gv(0.335, 0.009, 0.30)  // S
       + gv(0.52, 0.032, 0.28);  // T wave
}

const ECG = { buf: [], W: 0, H: 0, phase: 0, acc: 0, last: 0 };
function sizeCanvasDPR(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function sizeECG() {
  const cv = $('#ecg'); const { w, h } = sizeCanvasDPR(cv);
  ECG.W = w; ECG.H = h;
  if (ECG.buf.length === 0) for (let i = 0; i < w; i++) ECG.buf.push(0);
  else { while (ECG.buf.length < w) ECG.buf.unshift(0); while (ECG.buf.length > w) ECG.buf.shift(); }
}

function drawScopeGrid(ctx, W, H) {
  ctx.strokeStyle = 'rgba(51,209,122,.06)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 26) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 26) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
}

function stepECG(dt, v) {
  const W = ECG.W;
  const speed = 150;                       // horizontal scroll px/s
  const beatsPerSec = (v.bpm || 0) / 60;
  ECG.acc += speed * dt;
  let add = Math.floor(ECG.acc); ECG.acc -= add;
  if (add > W) add = W;
  for (let i = 0; i < add; i++) {
    ECG.phase += beatsPerSec / speed;      // beats advanced per pixel
    let y;
    if (v.dead) {
      y = (Math.random() - 0.5) * 0.02;    // near-flat with faint mains hum
    } else {
      const base = ecgWave(((ECG.phase % 1) + 1) % 1);
      const noise = (Math.random() - 0.5) * 0.5 * v.inst;
      y = base * (0.75 + 0.5 * v.inst) + noise;
      if (v.inst > 0.5 && Math.random() < 0.03 * v.inst) y += (Math.random() - 0.5) * 1.6; // ectopic spikes
    }
    ECG.buf.push(y); if (ECG.buf.length > W) ECG.buf.shift();
  }
}

function drawECG(v) {
  const cv = $('#ecg'), ctx = cv.getContext('2d'), W = ECG.W, H = ECG.H;
  ctx.clearRect(0, 0, W, H);
  drawScopeGrid(ctx, W, H);
  const midY = H * 0.58, amp = H * 0.34;
  ctx.lineWidth = 2.2; ctx.strokeStyle = v.color; ctx.shadowColor = v.color; ctx.shadowBlur = 12;
  ctx.beginPath();
  for (let x = 0; x < ECG.buf.length; x++) {
    const y = midY - ECG.buf[x] * amp;
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke(); ctx.shadowBlur = 0;
  const lx = ECG.buf.length - 1, ly = midY - ECG.buf[lx] * amp;
  ctx.fillStyle = v.color; ctx.shadowColor = v.color; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  // readouts
  const bpmEl = $('#bpm'), stEl = $('#vitState');
  bpmEl.textContent = v.dead ? '—' : v.bpm;
  bpmEl.style.color = v.color;
  stEl.textContent = v.label; stEl.className = 'vstate ' + v.level;
}

// ── ORBITAL TRACKING MAP · Blue Marble + sub-satellite point ─────────────────
const MAP = { W: 0, H: 0, t: 0 };
const earthImg = new Image();
let earthReady = false;
earthImg.onload = () => { earthReady = true; };
earthImg.src = '/assets/earth.jpg';
const GS = { lat: 37.5, lon: 127.0 };       // ground-station (Seoul) marker

// Live gpredict sub-satellite point → the map plots the SAME position gpredict shows
// (same TLE + same faked clock). Polls the gpredict time-control server; falls back
// to a procedural track when it isn't reachable. Configure/disable with ?ctrl=URL
// (default http://localhost:6079) or ?ctrl=off.
const GP = { url: null, tlat: null, tlon: null, lat: null, lon: null, trail: [], have: false, since: 0, acc: 0 };
(function () {
  const c = new URLSearchParams(location.search).get('ctrl');
  if (c === 'off' || c === 'none' || c === '') return;                 // disabled
  GP.url = (c || 'http://localhost:6079').replace(/\/$/, '');
  (function poll() {
    fetch(GP.url + '/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.subLatDeg === 'number' && typeof j.subLonDeg === 'number') {
          GP.tlat = j.subLatDeg; GP.tlon = j.subLonDeg; GP.have = true; GP.since = 0;
        }
      })
      .catch(() => {})                                                  // gpredict down → procedural
      .finally(() => setTimeout(poll, 1500));
  })();
})();

function sizeMap() { const cv = $('#orbit'); const { w, h } = sizeCanvasDPR(cv); MAP.W = w; MAP.H = h; }
const proj = (lat, lon) => [((lon + 180) / 360) * MAP.W, ((90 - lat) / 180) * MAP.H];

function drawMap(dt, v) {
  const cv = $('#orbit'), ctx = cv.getContext('2d'), W = MAP.W, H = MAP.H;
  MAP.t += dt;
  ctx.clearRect(0, 0, W, H);
  if (earthReady) { ctx.globalAlpha = 0.92; ctx.drawImage(earthImg, 0, 0, W, H); ctx.globalAlpha = 1; }
  else { ctx.fillStyle = '#0a1524'; ctx.fillRect(0, 0, W, H); }
  ctx.fillStyle = 'rgba(4,7,12,.28)'; ctx.fillRect(0, 0, W, H);  // darken for contrast
  // graticule
  ctx.strokeStyle = 'rgba(120,141,160,.18)'; ctx.lineWidth = 1;
  for (let lon = -120; lon <= 120; lon += 60) { const [x] = proj(0, lon); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let lat = -60; lat <= 60; lat += 30) { const [, y] = proj(lat, 0); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // position + ground-track: live gpredict fix when available, else a procedural LEO
  let lonNow, satLat, track;
  if (GP.have && GP.tlat != null && (GP.since += dt) > 8) GP.have = false;  // gpredict went quiet
  if (GP.have && GP.tlat != null) {
    if (GP.lat == null) { GP.lat = GP.tlat; GP.lon = GP.tlon; }
    const a = Math.min(1, dt * 3);                    // ease toward the polled fix
    GP.lat += (GP.tlat - GP.lat) * a;
    let dlon = GP.tlon - GP.lon;                       // shortest-path longitude lerp
    if (dlon > 180) dlon -= 360; else if (dlon < -180) dlon += 360;
    GP.lon = (((GP.lon + dlon * a) + 540) % 360) - 180;
    satLat = GP.lat; lonNow = GP.lon;
    GP.acc += dt;                                      // breadcrumb trail = the ground track
    if (!GP.trail.length || GP.acc > 0.8) { GP.trail.push([lonNow, satLat]); GP.acc = 0; if (GP.trail.length > 90) GP.trail.shift(); }
    track = GP.trail;
  } else {
    const period = 92, rate = 360 / period / 4, incl = 51;   // ~92 min LEO, 4× booth feel
    lonNow = ((MAP.t * rate + 200) % 360) - 180;
    track = [];
    for (let d = -70; d <= 70; d += 2) {
      const lon = (((lonNow + d * 2) + 540) % 360) - 180;
      track.push([lon, incl * Math.sin((d + MAP.t * rate) * Math.PI / 180)]);
    }
    satLat = incl * Math.sin((MAP.t * rate) * Math.PI / 180);
  }
  // draw track (split at antimeridian wraps)
  ctx.strokeStyle = v.critical ? 'rgba(255,59,78,.85)' : 'rgba(57,197,255,.85)';
  ctx.lineWidth = 2; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 6; ctx.beginPath();
  let started = false, prevX = 0;
  track.forEach(([lon, lat]) => {
    const [x, y] = proj(lat, lon);
    if (started && Math.abs(x - prevX) > W * 0.5) { ctx.stroke(); ctx.beginPath(); started = false; }
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true; prevX = x;
  });
  ctx.stroke(); ctx.shadowBlur = 0;

  const [sx, sy] = proj(satLat, lonNow);
  // coverage footprint
  ctx.strokeStyle = v.critical ? 'rgba(255,59,78,.5)' : 'rgba(57,197,255,.45)';
  ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, Math.min(W, H) * 0.12, 0, Math.PI * 2); ctx.stroke();
  // blinking marker
  const blink = 0.55 + 0.45 * Math.sin(MAP.t * 6);
  ctx.fillStyle = v.critical ? '#ff3b4e' : '#39c5ff';
  ctx.globalAlpha = v.critical ? blink : 1;
  ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // ground-station marker
  const [gx, gy] = proj(GS.lat, GS.lon);
  ctx.strokeStyle = '#33d17a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(gx - 5, gy); ctx.lineTo(gx + 5, gy); ctx.moveTo(gx, gy - 5); ctx.lineTo(gx, gy + 5); ctx.stroke();

  // readouts
  $('#mapCoord').textContent = `${satLat >= 0 ? 'N' : 'S'} ${Math.abs(satLat).toFixed(1)}° , ${lonNow >= 0 ? 'E' : 'W'} ${Math.abs(lonNow).toFixed(1)}°`;
  const tag = $('#mapTag');
  tag.textContent = v.dead ? '● SIGNAL LOST' : v.critical ? '● TUMBLING — TRACK UNSTABLE'
    : (GP.have ? '● TRACKING · GPREDICT' : '● TRACKING');
  tag.className = 'maptag ' + (v.dead || v.critical ? 'danger' : v.warn ? 'warn' : 'ok');
}

// single 60fps render loop for both live scopes
function frame(t) {
  let dt = ECG.last ? (t - ECG.last) / 1000 : 0; ECG.last = t;
  if (dt > 0.1) dt = 0.1;
  const v = computeVitals();
  stepECG(dt, v); drawECG(v);
  drawMap(dt, v);
  if (simEnabled) { stepSat(dt); drawSat(); }
  requestAnimationFrame(frame);
}

function initScopes() {
  sizeECG(); sizeMap(); sizeSat();
  window.addEventListener('resize', () => { sizeECG(); sizeMap(); sizeSat(); });
  requestAnimationFrame(frame);
}

// ── SPACECRAFT SIMULATOR · ground-truth 3D attitude ──────────────────────────
// A vanilla-canvas pseudo-3D model of DEMOSAT driven by the REAL (truth) state:
// nominal → stable, solar panels sun-tracking; under attack → tumbles on all axes
// with the panels swinging off-sun. This is the physical reality the drone spoof
// cannot hide — it keeps tumbling while the telemetry panels read NOMINAL.
const SAT = { W: 0, H: 0, ax: 0.28, ay: 0.5, az: 0, vx: 0, vy: 0.14, vz: 0, stars: [], geo: null, _p: null };
const SUN = (() => { const v = [-0.32, 0.9, 0.3]; const m = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / m); })();

function satGeometry() {
  const box = (cx, cy, cz, hx, hy, hz, color, kind) => {
    const x0=cx-hx,x1=cx+hx,y0=cy-hy,y1=cy+hy,z0=cz-hz,z1=cz+hz;
    const V=[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const F=[[[4,5,6,7],[0,0,1]],[[1,0,3,2],[0,0,-1]],[[5,1,2,6],[1,0,0]],
             [[0,4,7,3],[-1,0,0]],[[7,6,2,3],[0,1,0]],[[0,1,5,4],[0,-1,0]]];
    return F.map(([i,n]) => ({ pts: i.map((k) => V[k]), n, color, kind }));
  };
  // BODY = gold MLI thermal blanket · CELL = deep-indigo photovoltaic
  const BODY=[192,156,82], BOOM=[122,126,134], DISH=[150,156,168], NOZ=[68,70,80], CELL=[38,50,128];
  // solar wings as single double-sided quads (thin boxes z-fight; a quad reads clean)
  const wing = (sgn) => [{ pts: [[sgn*0.85,0,-0.62],[sgn*3.1,0,-0.62],[sgn*3.1,0,0.62],[sgn*0.85,0,0.62]],
    n: [0,1,0], color: CELL, kind: 'panel' }];
  return [].concat(
    box(0,0,0, 0.55,0.55,0.78, BODY,'body'),       // bus
    box(-0.8,0,0, 0.3,0.05,0.05, BOOM,'body'),      // boom L
    box( 0.8,0,0, 0.3,0.05,0.05, BOOM,'body'),      // boom R
    wing(-1), wing(1),                              // solar wings L / R
    box(0,0.72,0.15, 0.13,0.2,0.13, DISH,'body'),   // top sensor/dish
    box(0,0,-0.9, 0.16,0.16,0.13, NOZ,'body'),      // thruster nozzle
  );
}

function sizeSat() {
  const cv = $('#satsim'); if (!cv) return;
  const { w, h } = sizeCanvasDPR(cv); SAT.W = w; SAT.H = h;
  if (!SAT.geo) SAT.geo = satGeometry();
  if (!SAT.stars.length)
    for (let i=0;i<170;i++) SAT.stars.push({ x: Math.random(), y: Math.random(), r: Math.random()*1.3+0.2, a: Math.random()*0.6+0.2 });
}

function rotM(ax, ay, az) {
  const cx=Math.cos(ax),sx=Math.sin(ax),cy=Math.cos(ay),sy=Math.sin(ay),cz=Math.cos(az),sz=Math.sin(az);
  return [
    [cy*cz, sx*sy*cz - cx*sz, cx*sy*cz + sx*sz],
    [cy*sz, sx*sy*sz + cx*cz, cx*sy*sz - sx*cz],
    [-sy,   sx*cy,            cx*cy],
  ];
}
function mv3(m, v) {
  return [m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2],
          m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2],
          m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2]];
}
const SAT_VIEW = rotM(-0.34, 0.62, 0);   // fixed 3/4 camera angle
// specular lighting: camera dir in world = 3rd row of the view rotation; the Blinn
// half-vector between sun and camera gives metallic glints on the bus + panel sheen.
const CAMW = [SAT_VIEW[2][0], SAT_VIEW[2][1], SAT_VIEW[2][2]];
const HALF = (() => { const h = [SUN[0]+CAMW[0], SUN[1]+CAMW[1], SUN[2]+CAMW[2]];
  const m = Math.hypot(h[0], h[1], h[2]); return h.map((x) => x / m); })();
const MAT = { body: { spec: 0.55, shin: 20 }, panel: { panel: true, spec: 0.6, shin: 44 } };
function projS(p) {                       // view-space point → [screenX, screenY]
  const MS = 1.35, camZ = 13, f = SAT.H * 1.7;
  const s = f / (camZ - p[2]*MS);
  return [SAT.W/2 + p[0]*MS*s, SAT.H*0.5 - p[1]*MS*s];
}

function satParams() {
  const flags = truthState._flags || {};
  const torque = Math.abs(truthState['adcs.torque'] || 0);
  const batt = truthState['battery.level'];
  const dead = (typeof batt === 'number' && batt <= 0) || truthState['comm.status'] === 'DEAD' || !!flags.bricked;
  const tumbling = !!(flags.tumbling || flags.solarAttacked) && !dead;
  return { tumbling, torque, dead };
}

function stepSat(dt) {
  const p = satParams();
  let tx=0, ty=0.14, tz=0;                 // target angular velocity (rad/s)
  if (p.dead) { tx=0.03; ty=0.06; tz=0.02; }
  else if (p.tumbling) {
    const k = Math.min(1, p.torque / 999);
    tx = 1.1 + 2.3*k; ty = 0.8 + 1.9*k; tz = 0.6 + 1.7*k;
  }
  const ease = 1 - Math.exp(-dt * (p.tumbling ? 2.4 : 1.1));
  SAT.vx += (tx - SAT.vx) * ease;
  SAT.vy += (ty - SAT.vy) * ease;
  SAT.vz += (tz - SAT.vz) * ease;
  SAT.ax += SAT.vx*dt; SAT.ay += SAT.vy*dt; SAT.az += SAT.vz*dt;
  SAT._p = p;
}

function satShade(color, nW, mat) {
  let d = nW[0]*SUN[0] + nW[1]*SUN[1] + nW[2]*SUN[2];
  d = mat.panel ? Math.abs(d) : Math.max(0, d);           // panels are double-sided
  const k = (mat.panel ? 0.42 : 0.24) + (mat.panel ? 0.7 : 0.9) * d;
  const hn = Math.max(0, nW[0]*HALF[0] + nW[1]*HALF[1] + nW[2]*HALF[2]);
  const s = (mat.spec || 0) * Math.pow(hn, mat.shin || 16);   // Blinn specular glint
  return `rgb(${Math.min(255, color[0]*k + 255*s*0.95)|0},${Math.min(255, color[1]*k + 255*s*0.9)|0},${Math.min(255, color[2]*k + 255*s*(mat.panel?1:0.68))|0})`;
}

function drawSat() {
  const cv = $('#satsim'); if (!cv || !SAT.W) return;
  const ctx = cv.getContext('2d'), W = SAT.W, H = SAT.H;
  const p = SAT._p || satParams();
  ctx.clearRect(0,0,W,H);
  const bg = ctx.createLinearGradient(0,0,0,H);
  bg.addColorStop(0,'#03060d'); bg.addColorStop(1,'#01030a');
  ctx.fillStyle = bg; ctx.fillRect(0,0,W,H);
  SAT.stars.forEach((s) => { ctx.globalAlpha = s.a; ctx.fillStyle = '#cfe0ff'; ctx.fillRect(s.x*W, s.y*H, s.r, s.r); });
  ctx.globalAlpha = 1;
  // sun glow
  const sp = projS([SUN[0]*4.5, SUN[1]*4.5, SUN[2]*4.5]);
  const sg = ctx.createRadialGradient(sp[0],sp[1],0, sp[0],sp[1],140);
  sg.addColorStop(0,'rgba(255,244,205,.95)'); sg.addColorStop(.4,'rgba(255,208,112,.34)'); sg.addColorStop(1,'rgba(255,208,112,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sp[0],sp[1],140,0,Math.PI*2); ctx.fill();
  // Earth limb along the bottom
  const eg = ctx.createRadialGradient(W*0.5, H*1.95, H*1.0, W*0.5, H*1.95, H*1.6);
  eg.addColorStop(0,'rgba(46,126,205,.5)'); eg.addColorStop(.5,'rgba(22,74,144,.3)'); eg.addColorStop(1,'rgba(22,74,144,0)');
  ctx.fillStyle = eg; ctx.fillRect(0,0,W,H);

  const R = rotM(SAT.ax, SAT.ay, SAT.az);
  const faces = SAT.geo.map((face) => {
    const view = face.pts.map((v) => mv3(SAT_VIEW, mv3(R, v)));
    const nW = mv3(R, face.n);
    const scr = view.map(projS);
    const depth = (view[0][2]+view[1][2]+view[2][2]+view[3][2]) / 4;
    return { scr, nW, depth, face };
  });
  faces.sort((a,b) => a.depth - b.depth);   // far (small z) first

  const lerp = (a,b,t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
  faces.forEach(({ scr, nW, face }) => {
    const mat = MAT[face.kind] || MAT.body, P = scr;
    ctx.beginPath(); ctx.moveTo(P[0][0],P[0][1]);
    for (let i=1;i<P.length;i++) ctx.lineTo(P[i][0],P[i][1]);
    ctx.closePath();
    ctx.fillStyle = satShade(face.color, nW, mat); ctx.fill();

    // localized specular glint (clipped to the face) — metallic pop / panel sheen
    const hn = Math.max(0, nW[0]*HALF[0] + nW[1]*HALF[1] + nW[2]*HALF[2]);
    const glint = (mat.spec || 0) * Math.pow(hn, mat.shin || 16);
    if (glint > 0.06) {
      let gx=0, gy=0; P.forEach((p) => { gx+=p[0]; gy+=p[1]; }); gx/=P.length; gy/=P.length;
      const rad = mat.panel ? 96 : 46;
      const gr = ctx.createRadialGradient(gx,gy,0, gx,gy,rad);
      gr.addColorStop(0, `rgba(255,255,${mat.panel?255:226},${Math.min(0.5, glint)})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save(); ctx.clip(); ctx.fillStyle = gr; ctx.fillRect(gx-rad,gy-rad,rad*2,rad*2); ctx.restore();
    }

    if (face.kind === 'panel') {
      // photovoltaic cells: fine silver interconnect grid + thicker busbar + metal frame
      ctx.strokeStyle = 'rgba(150,170,205,.26)'; ctx.lineWidth = 1;
      for (let u=1;u<9;u++){ const t=u/9, A=lerp(P[0],P[1],t), B=lerp(P[3],P[2],t); ctx.beginPath(); ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]); ctx.stroke(); }
      for (let w=1;w<4;w++){ const t=w/4, A=lerp(P[0],P[3],t), B=lerp(P[1],P[2],t); ctx.beginPath(); ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(196,210,235,.42)'; ctx.lineWidth = 1.5;
      { const A=lerp(P[0],P[3],0.5), B=lerp(P[1],P[2],0.5); ctx.beginPath(); ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(206,201,178,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(P[0][0],P[0][1]); for (let i=1;i<P.length;i++) ctx.lineTo(P[i][0],P[i][1]); ctx.closePath(); ctx.stroke();
    } else if (P.length === 4) {
      // gold MLI blanket: dark seam cross + warm foil edge highlight
      const A=lerp(P[0],P[1],0.5),B=lerp(P[3],P[2],0.5),C=lerp(P[0],P[3],0.5),D=lerp(P[1],P[2],0.5);
      ctx.strokeStyle = 'rgba(58,42,12,.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]); ctx.moveTo(C[0],C[1]); ctx.lineTo(D[0],D[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,236,190,.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(P[0][0],P[0][1]); for (let i=1;i<P.length;i++) ctx.lineTo(P[i][0],P[i][1]); ctx.closePath(); ctx.stroke();
    }
  });

  const deg = (r) => ((((r*180/Math.PI) % 360) + 360) % 360);
  const spin = Math.hypot(SAT.vx, SAT.vy, SAT.vz) * 180/Math.PI;
  const panelN = mv3(R, [0,1,0]);
  const sunInc = Math.acos(Math.max(-1,Math.min(1, panelN[0]*SUN[0]+panelN[1]*SUN[1]+panelN[2]*SUN[2]))) * 180/Math.PI;
  const set = (id,txt,bad) => { const el=$('#'+id); if(!el) return; el.textContent=txt; el.classList.toggle('danger',!!bad); };
  set('simRoll', deg(SAT.ax).toFixed(0)+'°');
  set('simPitch', deg(SAT.az).toFixed(0)+'°');
  set('simYaw', deg(SAT.ay).toFixed(0)+'°');
  set('simSpin', spin.toFixed(1)+' °/s', p.tumbling);
  set('simSun', sunInc.toFixed(0)+'°', sunInc > 60 && !p.dead);

  const tag = $('#simTag'), wrap = cv.parentElement;
  if (wrap) wrap.classList.toggle('tumbling', p.tumbling || p.dead);
  if (tag) {
    if (p.dead) { tag.textContent = '● NO SIGNAL — UNCONTROLLED DRIFT'; tag.className = 'maptag danger'; }
    else if (p.tumbling) { tag.textContent = '● TUMBLING · SUN-TRACK LOST'; tag.className = 'maptag danger'; }
    else { tag.textContent = '● STABLE · SUN-TRACKING'; tag.className = 'maptag ok'; }
  }
}

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
initScopes();
connect();
