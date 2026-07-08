// GS dashboard — renders panel.json telemetry, styles by nominal/warn/danger,
// and escalates to an ENERGY SUPPLY CRITICAL alarm when the torque attack lands.
'use strict';

const COMM_STYLE = { CONNECTED: 'nominal', LOST: 'danger', DEAD: 'danger',
  'NO DOWNLINK': 'warn', REBOOTING: 'warn', 'LOW POWER': 'warn' };

let panelCfg = null;
let state = {};
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
    else if (m.type === 'state') { state = m.state; onState(); }
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

  // simulated LEO ground-track: inclined orbit advancing in longitude over time
  const period = 92;                       // ~92 min LEO, sped for the booth
  const rate = 360 / period / 4;           // deg/sec (4× real-time feel)
  const incl = 51;                         // inclination
  const lonNow = ((MAP.t * rate + 200) % 360) - 180;
  const track = [];
  for (let d = -70; d <= 70; d += 2) {
    const lon = (((lonNow + d * 2) + 540) % 360) - 180;
    const lat = incl * Math.sin((d + MAP.t * rate) * Math.PI / 180);
    track.push([lon, lat]);
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

  // sub-satellite point (current position = middle of track)
  const satLat = incl * Math.sin((MAP.t * rate) * Math.PI / 180);
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
  tag.textContent = v.dead ? '● SIGNAL LOST' : v.critical ? '● TUMBLING — TRACK UNSTABLE' : '● TRACKING';
  tag.className = 'maptag ' + (v.dead || v.critical ? 'danger' : v.warn ? 'warn' : 'ok');
}

// single 60fps render loop for both live scopes
function frame(t) {
  let dt = ECG.last ? (t - ECG.last) / 1000 : 0; ECG.last = t;
  if (dt > 0.1) dt = 0.1;
  const v = computeVitals();
  stepECG(dt, v); drawECG(v);
  drawMap(dt, v);
  requestAnimationFrame(frame);
}

function initScopes() {
  sizeECG(); sizeMap();
  window.addEventListener('resize', () => { sizeECG(); sizeMap(); });
  requestAnimationFrame(frame);
}

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
initScopes();
connect();
