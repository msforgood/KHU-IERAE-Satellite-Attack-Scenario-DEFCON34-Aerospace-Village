/* ENIGMA-1 Downlink Decoder - Scenario 1 web interface front-end.
   6 phases in one page (scenario2-style UI). Rendering + client-side flowgraph
   puzzle + a client-side "remaining communication time" countdown (satellite.js).
   Backend (server.py) supplies config, satellite dossier, .grc text, and mounts
   the VSA at /vsa/ (with an electronAPI shim that auto-loads ENIGMA-1's IQ). */

'use strict';

const PHASES = [
  { id: 'mission',   label: 'MISSION' },
  { id: 'target',    label: 'TARGET' },
  { id: 'track',     label: 'TRACK' },
  { id: 'puzzle',    label: 'PUZZLE' },
  { id: 'flowgraph', label: 'FLOWGRAPH' },
  { id: 'result',    label: 'RESULT' },
];
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

const state = {
  phase: 'mission', reached: { mission: true }, puzzleSolved: false,
  recUploaded: false, recFile: null,
  cfg: {}, sat: null,
  qth: null, satrec: null, obs: null, offsetMs: 0,
  remain: { valid: false, boundaryMs: null, inPass: false, lastCalcMs: 0, lastOffset: 0 },
  serverAos: null,   // authoritative AOS (ms) from gpredict-web (/api/remaining). If set, the countdown uses it first
};

// ── clock ──
setInterval(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const c = $('#clock'); if (c) c.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}, 1000);

// ── stepper ──
function buildStepper() {
  const nav = $('#stepper'); nav.innerHTML = '';
  PHASES.forEach((p, i) => {
    const item = el('div', 'stepitem'); item.dataset.id = p.id;
    item.append(el('span', 'sn', String(i + 1)), el('span', 'sl', p.label));
    item.addEventListener('click', () => { if (canGo(p.id)) show(p.id); });
    nav.append(item);
  });
  renderPhaseTags();
}
// Render phase-tag labels ("PHASE n · NAME") from the PHASES order, so inserting a
// phase (e.g. a signal-analysis step after PHASE 4) auto-renumbers every tag.
function renderPhaseTags() {
  PHASES.forEach((p, i) => {
    const t = $(`#p-${p.id} .phasetag[data-tag]`);
    if (t) t.textContent = `PHASE ${i + 1} · ${t.dataset.tag}`;
  });
}
function canGo(id) {
  if (state.reached[id]) return true;
  if (id === 'flowgraph' && !state.puzzleSolved) return false;
  return false;
}
function refreshStepper() {
  const curIdx = PHASES.findIndex((p) => p.id === state.phase);
  PHASES.forEach((p, i) => {
    const item = $(`.stepitem[data-id="${p.id}"]`); if (!item) return;
    item.classList.toggle('active', p.id === state.phase);
    item.classList.toggle('done', i < curIdx && state.reached[p.id]);
    item.classList.toggle('locked', !state.reached[p.id] && !(p.id === 'flowgraph' && state.puzzleSolved));
  });
}

const BANNER = {
  mission:   { cls: 'nominal', text: 'MISSION BRIEFING: know the goal' },
  target:    { cls: 'info',    text: 'TARGET LOCKED: ENIGMA-1 specs confirmed' },
  track:     { cls: 'info',    text: 'TRACK & SYNC: antenna tracking · RF sync' },
  puzzle:    { cls: 'warn',    text: 'DEMOD PIPELINE: assembling the flowgraph' },
  flowgraph: { cls: 'info',    text: 'FLOWGRAPH READY: run the demod chain' },
  result:    { cls: 'nominal', text: 'DECODE COMPLETE: image recovered' },
};
function refreshBanner() {
  const idx = PHASES.findIndex((p) => p.id === state.phase);
  let b = BANNER[state.phase] || BANNER.mission;
  if (state.phase === 'puzzle' && state.puzzleSolved) b = { cls: 'nominal', text: 'DEMOD PIPELINE: flowgraph complete' };
  const bn = $('#pipeBanner'); bn.className = `banner ${b.cls}`;
  $('#pipeText').textContent = b.text;
  $('#pipeStage').textContent = `STAGE ${idx + 1} / ${PHASES.length}`;
}

function show(id) {
  state.phase = id;
  state.reached[id] = true;
  PHASES.forEach((p) => $(`#p-${p.id}`).classList.toggle('hidden', p.id !== id));
  refreshStepper(); refreshBanner();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'track') mountEmbeds();
  if (id === 'flowgraph') { mountFlowgraph(); startDecode(); }   // start live reassembly automatically on entry (no manual button needed)
  if (id === 'puzzle') {
    syncPuzzleGate();
    if (state.recUploaded) requestAnimationFrame(() => { drawWires(); startSignalFlow(); });
  }
}

function wireNav() {
  $('#ackChk').addEventListener('change', (e) => { $('#toTarget').disabled = !e.target.checked; });
  $('#toTarget').addEventListener('click', () => show('target'));
  $('#toTrack').addEventListener('click', () => show('track'));
  $('#toPuzzle').addEventListener('click', () => show('puzzle'));
  $('#toFlowgraph').addEventListener('click', () => { if (state.puzzleSolved) show('flowgraph'); });
  $('#toResult').addEventListener('click', () => show('result'));
  $('#restart').addEventListener('click', () => {
    $('#ackChk').checked = false; $('#toTarget').disabled = true;
    state.recUploaded = false; state.recFile = null;
    const ui = $('#ugInfo'); if (ui) { ui.classList.add('hidden'); ui.classList.remove('ug-ok', 'ug-err'); ui.innerHTML = ''; }
    const uf = $('#ugFile'); if (uf) uf.value = '';
    syncPuzzleGate();
    show('mission');
  });
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 - full dossier · PHASE 3 - SAT info strip
// ─────────────────────────────────────────────────────────────────────────────
const SECT = [['identity', 'IDENTITY'], ['rf', 'RF / DOWNLINK'], ['sdr', 'SDR / RECEIVER'], ['passes', 'PASS / DOPPLER']];
function renderDossierFull(sat) {
  const root = $('#dossierFull'); root.innerHTML = '';
  const head = el('div', 'dcard span2');
  head.innerHTML = `<h3>OVERVIEW <span class="status-pill">${sat.status}</span></h3><div class="tagline">${sat.tagline}</div>`;
  root.append(head);
  SECT.forEach(([key, title]) => {
    if (!sat[key]) return;
    const c = el('div', 'dcard'); let rows = '';
    for (const [k, v] of Object.entries(sat[key])) rows += `<div class="drow"><span>${k}</span><b>${v}</b></div>`;
    c.innerHTML = `<h3>${title}</h3>${rows}`; root.append(c);
  });
  if (sat.tle) { const c = el('div', 'dcard span2'); c.innerHTML = `<h3>TLE (KEPLERIAN ELEMENTS)</h3><div class="tle">${sat.tle.join('\n')}</div>`; root.append(c); }
  if (sat.notes) { const c = el('div', 'dcard span2'); c.innerHTML = `<h3>INTERCEPT NOTES</h3><ul class="notelist">${sat.notes.map((n) => `<li>${n}</li>`).join('')}</ul>`; root.append(c); }
}
function renderSatInfoStrip(sat) {
  const root = $('#satInfoStrip'); if (!root) return; root.innerHTML = '';
  const cells = [
    ['NORAD ID', sat.identity?.['NORAD Catalog ID']],
    ['Downlink', sat.rf?.['Downlink freq']],
    ['Modulation', sat.rf?.['Modulation']],
    ['Symbol rate', sat.rf?.['Symbol rate']],
    ['Sample rate', sat.sdr?.['Sample rate']],
    ['Polarization', sat.rf?.['Polarization']],
    ['Doppler', sat.passes?.['Doppler shift @433.5 MHz']],
    ['Framing', sat.rf?.['Framing']],
  ];
  cells.forEach(([k, v]) => { if (!v) return; const c = el('div', 'si-cell'); c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`; root.append(c); });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 - embeds (VSA iframe + GPredict iframe/polar-preview) + remaining time
// ─────────────────────────────────────────────────────────────────────────────
// Normalize the noVNC embed URL: scale the remote to the viewport (resize=scale)
// so click coordinates map correctly inside the iframe. With resize=remote, if the
// server does not support resizing it stays 1:1 and scrolls, so clicks land wrong.
function novncEmbedUrl(url) {
  if (!url) return url;
  url = /[?&]resize=/.test(url)
    ? url.replace(/([?&])resize=[^&]*/, '$1resize=scale')
    : url + (url.includes('?') ? '&' : '?') + 'resize=scale';
  if (!/[?&]autoconnect=/.test(url)) url += '&autoconnect=1';
  // If the connection drops (e.g. container restart) the screen freezes and clicks stop working, so auto-reconnect.
  if (!/[?&]reconnect=/.test(url)) url += '&reconnect=true&reconnect_delay=2000';
  return url;
}
let embedsMounted = false;
function mountEmbeds() {
  if (embedsMounted) return;
  embedsMounted = true;
  // VSA - served statically by this server; auto-selects ENIGMA-1 + loads its IQ.
  $('#vsaFrame').src = state.cfg.vsaUrl || '/vsa/index.html';
  // GPredict - real noVNC embed if configured, else a polar-tracking preview.
  const slot = $('#gpredictSlot');
  if (state.cfg.gpredictUrl) {
    const f = el('iframe', 'embedframe'); f.title = 'GPredict';
    f.allow = 'clipboard-read; clipboard-write';
    f.src = novncEmbedUrl(state.cfg.gpredictUrl); slot.append(f);
  } else {
    makeGpredictView(slot);
  }
  wireResetPass();
  startOffsetPoll();
  startRemainingCountdown();
}

function wireResetPass() {
  const btn = $('#resetPass'), stat = $('#passStatus');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true; stat.className = 'passstat'; stat.textContent = 'computing…';
    try {
      const r = await fetch('/api/reset-pass'); const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      stat.className = 'passstat ok';
      const alt = j.maxAltDeg != null ? `max elevation ${j.maxAltDeg}° · ` : '';
      const lead = j.leadSec != null ? ` · signal in ${j.leadSec}s` : ' (signal imminent)';
      stat.textContent = `${alt}AOS ${j.aosUtc}${lead}`;
      // The libfaketime clock jumps in real time without a restart (no iframe reload). The countdown snaps immediately too.
      if (typeof j.aosUnix === 'number') state.serverAos = { aosMs: j.aosUnix * 1000 };
      refreshOffsetSoon();
    } catch (e) { stat.className = 'passstat err'; stat.textContent = `✗ ${e.message}`; }
    finally { setTimeout(() => { btn.disabled = false; }, 1200); }
  });
}

// ── remaining communication time (client-side SGP4 via satellite.js) ──
function buildSatrec() {
  const S = window.satellite;
  if (!S || !state.qth || !state.qth.tle || state.qth.tle.length < 3) return;
  try {
    state.satrec = S.twoline2satrec(state.qth.tle[1], state.qth.tle[2]);
    state.obs = {
      longitude: S.degreesToRadians(state.qth.lon),
      latitude: S.degreesToRadians(state.qth.lat),
      height: (state.qth.alt || 0) / 1000,
    };
  } catch (e) { state.satrec = null; }
}
function elevAt(ms) {
  const S = window.satellite;
  if (!S || !state.satrec || !state.obs) return null;
  try {
    const d = new Date(ms);
    const pv = S.propagate(state.satrec, d);
    if (!pv || !pv.position) return null;
    const ecf = S.eciToEcf(pv.position, S.gstime(d));
    const look = S.ecfToLookAngles(state.obs, ecf);
    return S.radiansToDegrees(look.elevation);
  } catch (e) { return null; }
}
function findBoundary(startMs) {
  const e0 = elevAt(startMs);
  if (e0 == null) return { boundaryMs: null, inPass: false };
  const inPass = e0 > 0;
  const step = 30000;
  const horizon = inPass ? 40 * 60000 : 6 * 3600000;
  let prev = startMs, prevUp = inPass;
  for (let t = startMs + step; t <= startMs + horizon; t += step) {
    const e = elevAt(t); const up = e != null && e > 0;
    if (up !== prevUp) {
      let a = prev, b = t;
      while (b - a > 1000) { const m = (a + b) / 2; const em = elevAt(m); const um = em != null && em > 0; if (um === prevUp) a = m; else b = m; }
      return { boundaryMs: b, inPass };
    }
    prev = t; prevUp = up;
  }
  return { boundaryMs: null, inPass };
}
function fmtDur(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}
let remainTimer = null;
function startRemainingCountdown() {
  if (remainTimer) return;
  if (!state.satrec) buildSatrec();
  remainTimer = setInterval(remainTick, 1000);
  remainTick();
}
function remainTick() {
  const val = $('#remainVal'), st = $('#remainState');
  if (!val) return;
  if (!state.satrec) { buildSatrec(); if (!state.satrec) { val.textContent = '--:--'; val.className = 'remain-val los'; st.textContent = 'waiting for TLE'; return; } }
  const now = Date.now() + state.offsetMs;
  // If the server (gpredict-web) gave an authoritative AOS, use it directly so the on-screen number matches gpredict exactly.
  // After AOS (pass in progress) or if the server is absent, fall back to the local SGP4 (LOS calc) below.
  if (state.serverAos && state.serverAos.aosMs > now) {
    const left = state.serverAos.aosMs - now;
    val.textContent = fmtDur(left);
    val.className = 'remain-val los' + (left < 60000 ? ' warn' : '');
    st.textContent = '- NEXT AOS';
    return;
  }
  const r = state.remain;
  const need = !r.valid || r.lastOffset !== state.offsetMs || (r.boundaryMs != null && now >= r.boundaryMs) || (now - r.lastCalcMs) > 15000;
  if (need) { const b = findBoundary(now); state.remain = { valid: true, boundaryMs: b.boundaryMs, inPass: b.inPass, lastCalcMs: now, lastOffset: state.offsetMs }; }
  const rr = state.remain;
  if (rr.boundaryMs == null) { val.textContent = '--:--'; val.className = 'remain-val los'; st.textContent = rr.inPass ? 'IN PASS' : 'no pass'; return; }
  const left = rr.boundaryMs - now;
  val.textContent = fmtDur(left);
  if (rr.inPass) { val.className = 'remain-val' + (left < 60000 ? ' warn' : ''); st.textContent = '● IN PASS · LOS'; }
  else { val.className = 'remain-val los'; st.textContent = '- NEXT AOS'; }
}
// faketime offset from gpredict-web control (:6079 → /api/offset). 0 when no Docker.
let offsetTimer = null;
function startOffsetPoll() {
  if (offsetTimer) return;
  const poll = async () => {
    try { const j = await (await fetch('/api/offset')).json(); if (j && typeof j.offsetMs === 'number') state.offsetMs = j.offsetMs; }
    catch (e) { /* no control server - stay on real time */ }
    // Get the same AOS as gpredict (MIN_ALT filter + faketime) from the server so the countdown matches.
    try {
      const k = await (await fetch('/api/remaining')).json();
      state.serverAos = (k && k.ok && typeof k.aosUnix === 'number' && k.remainingSec > 2)
        ? { aosMs: k.aosUnix * 1000 } : null;   // pass in progress (≤2s) or error: fall back to client SGP4
    } catch (e) { state.serverAos = null; }
  };
  poll(); offsetTimer = setInterval(poll, 3000);
}
function refreshOffsetSoon() { setTimeout(async () => { try { const j = await (await fetch('/api/offset')).json(); if (j && typeof j.offsetMs === 'number') state.offsetMs = j.offsetMs; } catch (e) {} }, 6500); }

// ── GPredict-style polar preview (fallback when the real noVNC URL isn't set) ──
function makeGpredictView(container) {
  const PASS = 34, GAP = 9, CYCLE = PASS + GAP;
  const AOS_AZ = 18, LOS_AZ = 205, MAX_EL = 74;
  const RNG_MIN = 540, RNG_MAX = 2300, DOP_MAX = 9.8;
  container.classList.add('gpvwrap');
  container.innerHTML = `
    <div class="gpv">
      <div class="gpv-plot"><canvas class="gpv-canvas"></canvas></div>
      <div class="gpv-side">
        <div class="gpv-title">GPREDICT · TRACKING</div>
        <div class="gpv-sat">🛰 ENIGMA-1</div>
        <div class="gpv-badge" data-k="state">- ACQUIRING -</div>
        <div class="gpv-row"><span>Azimuth</span><b data-k="az">–</b></div>
        <div class="gpv-row"><span>Elevation</span><b data-k="el">–</b></div>
        <div class="gpv-row"><span>Range</span><b data-k="rng">–</b></div>
        <div class="gpv-row"><span>Doppler</span><b data-k="dop">–</b></div>
        <div class="gpv-row"><span>RX freq</span><b data-k="rx">–</b></div>
        <div class="gpv-note">⚠ polar preview (real GPredict not connected)<br>real: run <code>gpredict-web/run.sh</code> → set <code>GPREDICT_URL</code></div>
      </div>
    </div>`;
  const cv = container.querySelector('.gpv-canvas'); const ctx = cv.getContext('2d');
  const setv = (k, v) => { const n = container.querySelector(`[data-k="${k}"]`); if (n) n.textContent = v; };
  const project = (cx, cy, rad, az, elv) => { const r = rad * (90 - Math.max(0, elv)) / 90; const a = (az - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const passAz = (p) => AOS_AZ + (LOS_AZ - AOS_AZ) * p;
  const passEl = (p) => MAX_EL * Math.sin(Math.PI * p);
  const start = performance.now();
  function frame(now) {
    if (!document.body.contains(cv)) return;
    const w = cv.clientWidth || 380, h = cv.clientHeight || 380;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 - 26;
    ctx.strokeStyle = '#1e2b3a'; ctx.fillStyle = '#5b6b7d'; ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [0, 30, 60].forEach((elv) => { const r = rad * (90 - elv) / 90; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy); ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad); ctx.stroke();
    ctx.fillText('N', cx, cy - rad - 12); ctx.fillText('S', cx, cy + rad + 12); ctx.fillText('E', cx + rad + 12, cy); ctx.fillText('W', cx - rad - 12, cy);
    const t = ((now - start) / 1000) % CYCLE; const inPass = t < PASS; const p = inPass ? t / PASS : 0;
    ctx.strokeStyle = 'rgba(57,197,255,.35)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 60; i++) { const [x, y] = project(cx, cy, rad, passAz(i / 60), passEl(i / 60)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = '#33d17a'; let [ax, ay] = project(cx, cy, rad, AOS_AZ, 0); ctx.beginPath(); ctx.arc(ax, ay, 3.5, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#ff3b4e'; let [lx, ly] = project(cx, cy, rad, LOS_AZ, 0); ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 6.3); ctx.fill();
    if (inPass) {
      const az = passAz(p), elv = passEl(p);
      const rng = RNG_MAX - (RNG_MAX - RNG_MIN) * Math.sin(Math.PI * p);
      const dop = DOP_MAX * Math.cos(Math.PI * p);
      const [x, y] = project(cx, cy, rad, az, elv);
      ctx.strokeStyle = 'rgba(255,210,63,.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(x, y, 6, 0, 6.3); ctx.fill();
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.3); ctx.stroke();
      setv('state', '● TRACKING'); container.querySelector('.gpv-badge').className = 'gpv-badge on';
      setv('az', `${az.toFixed(1)}°`); setv('el', `${elv.toFixed(1)}°`); setv('rng', `${rng.toFixed(0)} km`);
      setv('dop', `${dop >= 0 ? '+' : ''}${dop.toFixed(2)} kHz`); setv('rx', `${(433.5 + dop / 1000).toFixed(4)} MHz`);
    } else {
      setv('state', '- LOS · WAITING -'); container.querySelector('.gpv-badge').className = 'gpv-badge';
      setv('az', '-'); setv('el', 'below horizon'); setv('rng', '-'); setv('dop', '-'); setv('rx', '433.5000 MHz');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 - flowgraph puzzle (blocks/slots/wires match enigma1_decoder.grc)
// ─────────────────────────────────────────────────────────────────────────────
const BLOCKS = {
  file_source: { cat: 'src',  phase: 'SOURCE',   title: 'File Source',                sub: 'enigma34_downlink.cf32' },
  throttle:    { cat: 'flow', phase: 'FLOW',     title: 'Throttle',                   sub: 'Sample Rate: 96k' },
  fir:         { cat: 'dsp',  phase: 'FILTER',   title: 'Freq Xlating FIR Filter',    sub: 'Decim 1 · low_pass' },
  fsk:         { cat: 'dsp',  phase: 'DEMOD',    title: 'FSK Demodulator',            sub: '9.6k baud' },
  waterfall:   { cat: 'sink', phase: 'SINK',     title: 'QT GUI Waterfall Sink',      sub: '433.5 MHz', disabled: true },
  deframer:    { cat: 'dsp',  phase: 'DEFRAME',  title: 'AX.25 Deframer',             sub: 'G3RUH: True' },
  reassembler: { cat: 'sink', phase: 'SINK',     title: 'ENIGMA-1 Image Reassembler', sub: '→ png' },
  msgdebug:    { cat: 'sink', phase: 'SINK',     title: 'Message Debug',              sub: 'Print PDU: On' },
};
const SLOTS = [
  { id: 'file_source', x: 24,   y: 172, w: 168, h: 78 },
  { id: 'throttle',    x: 232,  y: 330, w: 168, h: 78 },
  { id: 'fir',         x: 424,  y: 172, w: 190, h: 78 },
  { id: 'fsk',         x: 648,  y: 56,  w: 176, h: 78 },
  { id: 'waterfall',   x: 648,  y: 320, w: 176, h: 78 },
  { id: 'deframer',    x: 840,  y: 188, w: 168, h: 78 },
  { id: 'reassembler', x: 1000, y: 74,  w: 176, h: 82 },
  { id: 'msgdebug',    x: 1000, y: 300, w: 176, h: 78 },
];
const WIRES = [
  ['file_source', 'throttle'], ['throttle', 'fir'], ['fir', 'fsk'], ['fir', 'waterfall'],
  ['fsk', 'deframer'], ['deframer', 'reassembler'], ['deframer', 'msgdebug'],
];
const CANVAS_W = 1180, CANVAS_H = 440;
const puzzle = { placement: {}, tray: [], selected: null };

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (i * 2654435761 + 40503) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function blockCardHTML(id) {
  const b = BLOCKS[id];
  return `<div class="blockcard cat-${b.cat}${b.disabled ? ' disabled' : ''}">
    <div class="bp">${b.phase}${b.disabled ? ' · disabled' : ''}</div>
    <div class="bt">${b.title}</div><div class="bs">${b.sub}</div></div>`;
}
function initPuzzle() {
  puzzle.placement = { file_source: 'file_source' };   // the first block (File Source) starts fixed in place
  puzzle.selected = null;
  puzzle.tray = shuffle(Object.keys(BLOCKS).filter((id) => id !== 'file_source'));
  state.puzzleSolved = false;
  const hb = $('#hintBox'); if (hb) { hb.classList.add('hidden'); hb.innerHTML = ''; }
  renderSlots(); renderTray(); drawWires(); updatePuzzleState();
}
function renderSlots() {
  const layer = $('#slotLayer'); layer.innerHTML = '';
  SLOTS.forEach((s) => {
    const d = el('div', 'slot');
    d.style.left = `${(s.x / CANVAS_W) * 100}%`; d.style.top = `${(s.y / CANVAS_H) * 100}%`;
    d.style.width = `${(s.w / CANVAS_W) * 100}%`; d.style.height = `${(s.h / CANVAS_H) * 100}%`;
    d.dataset.slot = s.id;
    const placed = puzzle.placement[s.id];
    if (placed) {
      d.classList.add('filled', placed === s.id ? 'correct' : 'wrong'); d.innerHTML = blockCardHTML(placed);
      if (s.id === 'file_source') { d.classList.add('fixed'); d.insertAdjacentHTML('beforeend', '<div class="slotlock">🔒 fixed</div>'); }
    }
    else { d.innerHTML = `<div class="ghostname">${BLOCKS[s.id].phase}</div>`; if (puzzle.selected) d.classList.add('selectable'); }
    d.addEventListener('click', () => onSlotClick(s.id));
    layer.append(d);
  });
}
function renderTray() {
  const tray = $('#tray'); tray.innerHTML = '';
  if (!puzzle.tray.length) { tray.append(el('div', 'traynote', 'All blocks placed.')); return; }
  puzzle.tray.forEach((id) => {
    const b = BLOCKS[id];
    const chip = el('div', `traychip cat-${b.cat}${puzzle.selected === id ? ' selected' : ''}`);
    chip.innerHTML = `<div class="bp">${b.phase}${b.disabled ? ' · disabled' : ''}</div><div class="bt">${b.title}</div><div class="bs">${b.sub}</div>`;
    chip.addEventListener('click', () => { puzzle.selected = puzzle.selected === id ? null : id; renderTray(); renderSlots(); });
    tray.append(chip);
  });
}
function onSlotClick(slotId) {
  if (slotId === 'file_source') return;   // fixed block: cannot be removed or moved
  const occupant = puzzle.placement[slotId];
  if (occupant) { delete puzzle.placement[slotId]; puzzle.tray.push(occupant); puzzle.selected = null; }
  else if (puzzle.selected) { puzzle.placement[slotId] = puzzle.selected; puzzle.tray = puzzle.tray.filter((b) => b !== puzzle.selected); puzzle.selected = null; }
  else return;
  renderSlots(); renderTray(); drawWires(); updatePuzzleState();
}
function slotCenterRight(s) { return { x: s.x + s.w, y: s.y + s.h / 2 }; }
function slotCenterLeft(s) { return { x: s.x, y: s.y + s.h / 2 }; }
function slotById(id) { return SLOTS.find((s) => s.id === id); }
function drawWires() {
  const svg = $('#wireLayer'); svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `<marker id="arrOk" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#33d17a"/></marker>
    <marker id="arrDim" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2a3a4d"/></marker>`;
  svg.append(defs);
  WIRES.forEach(([from, to]) => {
    const sf = slotById(from), st = slotById(to);
    const a = slotCenterRight(sf), b = slotCenterLeft(st);
    const live = puzzle.placement[from] === from && puzzle.placement[to] === to;
    const path = document.createElementNS(ns, 'path');
    const dx = Math.max(30, (b.x - a.x) * 0.45);
    path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', live ? '#33d17a' : '#2a3a4d');
    path.setAttribute('stroke-width', live ? '3' : '2'); if (!live) path.setAttribute('stroke-dasharray', '6 6');
    path.setAttribute('marker-end', live ? 'url(#arrOk)' : 'url(#arrDim)');
    svg.append(path);
  });
}
function updatePuzzleState() {
  const placed = Object.keys(puzzle.placement).length;
  const correct = SLOTS.filter((s) => puzzle.placement[s.id] === s.id).length;
  $('#puzzleProg').textContent = `${placed} / ${SLOTS.length} placed`;
  const solved = correct === SLOTS.length;
  state.puzzleSolved = solved;
  $('#solvedBanner').classList.toggle('hidden', !solved);
  $('#toFlowgraph').disabled = !solved;
  $('#toFlowgraph').textContent = solved ? 'Show the correct flowgraph →' : '🔒 Show the correct flowgraph →';
  refreshStepper(); if (state.phase === 'puzzle') refreshBanner();
  updateSignalFlow();
}
function wirePuzzle() {
  $('#resetPuzzle').addEventListener('click', initPuzzle);
  // Hint: show the correct signal-chain order and briefly highlight the correct slot for the selected block.
  $('#hintPuzzle').addEventListener('click', () => {
    const hb = $('#hintBox');
    const order = ['file_source', 'throttle', 'fir', 'fsk', 'deframer', 'reassembler'];
    const chain = order.map((id) => BLOCKS[id].title).join(' → ');
    hb.innerHTML = `<b>Signal chain order</b><br>${chain}<br>
      <span style="color:var(--dim)">· File Source is bottom-left, Reassembler/Message Debug are top/bottom-right.
      · Waterfall Sink branches off FIR (optional). Select a block in the tray to briefly highlight its correct slot.</span>`;
    hb.classList.remove('hidden');
    if (puzzle.selected) {
      const s = $(`.slot[data-slot="${puzzle.selected}"]`);
      if (s && !s.classList.contains('filled')) { s.style.boxShadow = '0 0 0 2px var(--amber) inset'; setTimeout(() => { s.style.boxShadow = ''; }, 1400); }
    }
  });
  // Auto-solve placement (to be removed before release)
  $('#revealPuzzle').addEventListener('click', () => {
    puzzle.placement = {}; SLOTS.forEach((s) => { puzzle.placement[s.id] = s.id; });
    puzzle.tray = []; puzzle.selected = null;
    renderSlots(); renderTray(); drawWires(); updatePuzzleState();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 - STEP 0 recording upload gate (reveals the puzzle once upload completes)
// ─────────────────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function ugError(msg) {
  const info = $('#ugInfo'); if (!info) return;
  info.classList.remove('hidden', 'ug-ok'); info.classList.add('ug-err');
  info.innerHTML = '⚠ ' + msg;
}
// After validating .cf32 (complex float32 IQ), send it to the server so PHASE 5's real GNU Radio uses it as the File Source.
async function handleRecFile(file) {
  const info = $('#ugInfo'); if (!info) return;
  info.classList.remove('hidden', 'ug-err', 'ug-ok');
  info.innerHTML = '⏳ validating file…';
  const name = file.name, size = file.size;
  const okExt = /\.(cf32|iq|raw|c64|dat)$/i.test(name);
  if (size < 4096 || size % 8 !== 0) {
    return ugError(`not complex float32 (IQ) format - size ${fmtBytes(size)} (not a multiple of 8 bytes, or too small). Upload the .cf32 recorded in the VSA.`);
  }
  let ok = true, peak = 0;                              // read the beginning as float32 to check it is real IQ
  try {
    const buf = await file.slice(0, 8192).arrayBuffer();
    const f = new Float32Array(buf);
    for (let i = 0; i < f.length; i++) { const v = f[i]; if (!Number.isFinite(v)) { ok = false; break; } const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak === 0 || peak > 1e6) ok = false;   // NaN/Inf already blocked by isFinite above; un-normalized captures are also allowed
  } catch (e) { ok = false; }
  if (!ok) return ugError('Cannot be read as IQ data. Check that it is a .cf32 (complex float32) file recorded in the VSA.');
  const samples = size / 8, durAt50k = samples / 50000;
  state.recUploaded = true; state.recFile = { name, size, samples };
  BLOCKS.file_source.sub = name.length > 26 ? name.slice(0, 25) + '…' : name;   // puzzle's first block + PHASE 5 File Source label
  info.classList.remove('ug-err'); info.classList.add('ug-ok');
  info.innerHTML =
    `✅ <b>${escHtml(name)}</b> uploaded` +
    `<br>size ${fmtBytes(size)} · ${samples.toLocaleString()} IQ samples (complex float32)` +
    (okExt ? '' : ' · <span class="ug-warn">non-standard extension</span>') +
    `<br><span class="ug-sub">≈ ${durAt50k.toFixed(1)}s @ 50 kSps · activating the demod flowgraph puzzle…</span>` +
    `<br><span id="ugServerLine" class="ug-sub">⏳ uploading to the server for PHASE 5 GNU Radio…</span>`;
  uploadToServer(file, name, 50000).then((r) => {          // stage the File Source for PHASE 5's real GNU Radio
    const el = $('#ugServerLine'); if (!el) return;
    el.textContent = (r && r.ok)
      ? '⬆ registered on the server: used as the File Source in PHASE 5 real GNU Radio'
      : '⚠ server upload failed: the puzzle continues but the PHASE 5 file source is not updated';
  });
  setTimeout(revealPuzzleBody, 900);                   // show the result briefly, then reveal the puzzle
}
async function uploadToServer(file, name, sampleRate) {
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(name) + '&sampleRate=' + (sampleRate || 50000),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}
function revealPuzzleBody() {
  const up = $('#puzzleUpload'), body = $('#puzzleBody');
  if (up) up.classList.add('hidden');
  if (body) body.classList.remove('hidden');
  // Once revealed and the layout settles, redraw the puzzle (first block fixed + uploaded filename applied).
  requestAnimationFrame(() => { initPuzzle(); startSignalFlow(); });
}
function syncPuzzleGate() {
  const up = $('#puzzleUpload'), body = $('#puzzleBody');
  if (!up || !body) return;
  up.classList.toggle('hidden', state.recUploaded);
  body.classList.toggle('hidden', !state.recUploaded);
}
function wireUploadGate() {
  const input = $('#ugFile'), drop = $('#ugDrop');
  if (!input || !drop) return;
  input.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) handleRecFile(f); });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover'); }));
  // Only handle a real exit, so dragleave does not fire early when the cursor moves onto a child inside the label
  drop.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !drop.contains(e.relatedTarget)) drop.classList.remove('dragover'); });
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleRecFile(f);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 - signal-flow preview (each stage's signal comes alive as you place blocks)
// A stage only activates and animates once the chain up to that point is filled in correctly.
// ─────────────────────────────────────────────────────────────────────────────
const SIGFLOW = [
  { key: 'iq',     label: 'RAW IQ',    sub: 'IQ + noise',        need: ['file_source'] },
  { key: 'filter', label: 'FILTER',    sub: 'narrowband · Doppler', need: ['file_source', 'throttle', 'fir'] },
  { key: 'demod',  label: 'FSK DEMOD', sub: 'mark · space',      need: ['file_source', 'throttle', 'fir', 'fsk'] },
  { key: 'frame',  label: 'AX.25',     sub: 'frame (HDLC)',      need: ['file_source', 'throttle', 'fir', 'fsk', 'deframer'] },
  { key: 'image',  label: 'IMAGE',     sub: 'reassembly',        need: ['file_source', 'throttle', 'fir', 'fsk', 'deframer', 'reassembler'] },
];
const NUM = '①②③④⑤';
const sigResultImg = new Image();
sigResultImg.src = '/assets/result.png';
let sigflowBuilt = false, sigflowRAF = null;

function buildSignalFlow() {
  if (sigflowBuilt) return;
  const row = $('#sigflowRow'); if (!row) return;
  row.innerHTML = '';
  SIGFLOW.forEach((s, i) => {
    if (i > 0) { const a = el('span', 'sig-arrow', '▸'); a.dataset.i = i; row.append(a); }
    const card = el('div', 'sigstage' + (s.key === 'filter' || s.key === 'frame' ? ' wide' : '')); card.dataset.stage = s.key;
    card.innerHTML = `<div class="sscap"><b>${NUM[i]} ${s.label}</b><span>${s.sub}</span></div>`;
    card.append(el('canvas', 'ssviz'));
    row.append(card);
  });
  sigflowBuilt = true;
}
function sigActive(need) { return need.every((id) => puzzle.placement[id] === id); }
function updateSignalFlow() {
  SIGFLOW.forEach((s) => { const c = $(`.sigstage[data-stage="${s.key}"]`); if (c) c.classList.toggle('active', sigActive(s.need)); });
  document.querySelectorAll('.sig-arrow').forEach((a) => a.classList.toggle('lit', sigActive(SIGFLOW[+a.dataset.i].need)));
}
function startSignalFlow() {
  buildSignalFlow(); updateSignalFlow();
  if (sigflowRAF) return;
  const loop = (now) => {
    if (state.phase !== 'puzzle') { sigflowRAF = null; return; }   // stop when leaving for another phase
    const t = now / 1000;
    SIGFLOW.forEach((s) => {
      const cv = document.querySelector(`.sigstage[data-stage="${s.key}"] canvas`);
      if (cv) drawSig(cv, s.key, sigActive(s.need), t);
    });
    sigflowRAF = requestAnimationFrame(loop);
  };
  sigflowRAF = requestAnimationFrame(loop);
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawSig(cv, key, active, t) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 140, h = cv.clientHeight || 62;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  if (!active) {   // inactive: faint dashed baseline
    ctx.strokeStyle = '#1c2836'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(6, h / 2); ctx.lineTo(w - 6, h / 2); ctx.stroke(); ctx.setLineDash([]);
    return;
  }
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  if (key === 'iq') {                                   // noisy IQ (I cyan / Q purple)
    const line = (color, ph) => { ctx.strokeStyle = color; ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const n = Math.sin(x * 0.35 - t * 3 + ph) * 0.5 + Math.sin(x * 0.14 - t * 2.1 + ph) * 0.3 + Math.sin(x * 0.8 - t * 4.7 + ph) * 0.2;
        const y = h / 2 + n * (h * 0.30); x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      } ctx.stroke(); };
    line('#39c5ff', 0); line('#8a7dff', 1.7);
  } else if (key === 'filter') {                        // before filter (wideband · noisy · offset) ▸ after (narrowband · aligned · low-noise)
    const gap = 16, pad = 5, midX = w / 2, baseY = h - 6, topY = 13;
    const lx0 = pad, lx1 = midX - gap / 2, rx0 = midX + gap / 2, rx1 = w - pad;
    const spectrum = (x0, x1, peakFrac, sigma, peakH, noiseAmp, col) => {
      const cx = x0 + (x1 - x0) * peakFrac;
      ctx.strokeStyle = 'rgba(95,125,155,.55)'; ctx.lineWidth = 1; ctx.beginPath();   // noise floor
      let first = true;
      for (let x = x0; x <= x1; x += 2) {
        const n = Math.max(0, (Math.sin(x * 1.9 + t * 5) * 0.5 + 0.5) + Math.sin(x * 0.7 - t * 3) * 0.35);
        const y = baseY - n * noiseAmp; first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();                       // carrier peak
      for (let x = x0; x <= x1; x += 1.5) {
        const g = Math.exp(-Math.pow((x - cx) / sigma, 2));
        const n = (Math.sin(x * 1.9 + t * 5) * 0.5 + 0.5) * noiseAmp * 0.5;
        const y = baseY - (g * peakH + n); x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    ctx.fillStyle = 'rgba(57,197,255,.10)';                                            // OUT passband (only the center passes)
    ctx.fillRect((rx0 + rx1) / 2 - 7, topY, 14, baseY - topY);
    spectrum(lx0, lx1, 0.66, 8, (h - topY) * 0.5 * (0.85 + 0.15 * Math.sin(t * 3)), (h - topY) * 0.30, '#7f92a6');  // before
    spectrum(rx0, rx1, 0.5, 4.5, (h - topY) * 0.80 * (0.85 + 0.15 * Math.sin(t * 4)), (h - topY) * 0.07, '#39c5ff'); // after
    ctx.fillStyle = '#33d17a'; ctx.font = '12px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▸', midX, (topY + baseY) / 2);
    ctx.fillStyle = '#7f92a6'; ctx.font = '9px ui-monospace,monospace'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText('before (wide)', lx0, 2);
    ctx.textAlign = 'right'; ctx.fillText('after (narrow)', rx1, 2);
  } else if (key === 'demod') {                         // FSK: mark/space square wave + 0/1 bit stream below
    const bits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1], bw = 14, off = (t * 38) % bw;
    const hi = h * 0.18, lo = h * 0.48;
    ctx.strokeStyle = '#33d17a'; ctx.lineWidth = 2; ctx.beginPath(); let started = false;    // square wave (mark/space)
    for (let i = -1; i < Math.ceil(w / bw) + 1; i++) {
      const bit = bits[((i % bits.length) + bits.length) % bits.length], x0 = i * bw - off, y = bit ? hi : lo;
      if (!started) { ctx.moveTo(x0, y); started = true; } else ctx.lineTo(x0, y); ctx.lineTo(x0 + bw, y);
    } ctx.stroke();
    ctx.strokeStyle = 'rgba(95,125,155,.22)'; ctx.lineWidth = 1;                             // divider line
    ctx.beginPath(); ctx.moveTo(0, h * 0.60); ctx.lineTo(w, h * 0.60); ctx.stroke();
    ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';   // 0/1 stream (synced to the waveform)
    for (let i = -1; i < Math.ceil(w / bw) + 1; i++) {
      const bit = bits[((i % bits.length) + bits.length) % bits.length], cx = i * bw - off + bw / 2;
      if (cx < -6 || cx > w + 6) continue;
      ctx.fillStyle = bit ? '#33d17a' : '#5b6b7d';
      ctx.fillText(bit ? '1' : '0', cx, h * 0.82);
    }
  } else if (key === 'frame') {                         // 0/1 bits being packed into AX.25 fields
    const pad = 5;
    // top: incoming 0/1 bit stream (bits flowing in from demod)
    const inb = [1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0], ibw = 9, ioff = (t * 30) % ibw;
    ctx.font = '8px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = -1; i < Math.ceil(w / ibw) + 1; i++) {
      const bit = inb[((i % inb.length) + inb.length) % inb.length], cx = i * ibw - ioff + ibw / 2;
      if (cx < -4 || cx > w + 4) continue;
      ctx.fillStyle = bit ? 'rgba(51,209,122,.6)' : 'rgba(95,125,155,.5)'; ctx.fillText(bit ? '1' : '0', cx, 8);
    }
    ctx.fillStyle = '#5b6b7d'; ctx.fillText('▾ pack', w / 2, 18);
    // bottom: AX.25 UI frame fields (each field fills as the assembly sweep passes over it)
    const fields = [
      { l: '7E', w: 1, c: '#ffd23f' }, { l: 'ADDR', w: 3, c: '#39c5ff' },
      { l: 'C', w: 0.7, c: '#8a7dff' }, { l: 'PID', w: 0.9, c: '#8a7dff' },
      { l: 'INFO', w: 4.4, c: '#33d17a' }, { l: 'FCS', w: 1.3, c: '#ff6ad5' },
      { l: '7E', w: 1, c: '#ffd23f' },
    ];
    const tot = fields.reduce((s, f) => s + f.w, 0), avail = w - pad * 2, fy = h * 0.40, fh = h * 0.50;
    const sweep = (t * 0.5) % 1;
    let x = pad, acc = 0;
    fields.forEach((f) => {
      const fwpx = (f.w / tot) * avail, mid = (acc + f.w / 2) / tot, on = Math.abs(mid - sweep) < 0.09;
      ctx.globalAlpha = on ? 0.36 : 0.13; ctx.fillStyle = f.c; rr(ctx, x, fy, fwpx - 2, fh, 3); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = f.c; ctx.lineWidth = on ? 1.6 : 1; rr(ctx, x, fy, fwpx - 2, fh, 3); ctx.stroke();
      if (fwpx > 13) { ctx.fillStyle = on ? '#eaf2fb' : f.c; ctx.fillText(f.l, x + (fwpx - 2) / 2, fy + fh / 2); }
      x += fwpx; acc += f.w;
    });
    ctx.globalAlpha = 1;
  } else if (key === 'image') {                         // recovered image + scanline
    if (sigResultImg.complete && sigResultImg.naturalWidth) {
      const iw = sigResultImg.naturalWidth, ih = sigResultImg.naturalHeight, sc = Math.min((w - 8) / iw, (h - 8) / ih);
      const dw = iw * sc, dh = ih * sc, dx = (w - dw) / 2, dy = (h - dh) / 2;
      ctx.imageSmoothingEnabled = false; ctx.drawImage(sigResultImg, dx, dy, dw, dh);
      const sy = dy + ((t * 26) % dh); ctx.strokeStyle = 'rgba(57,197,255,.75)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(dx, sy); ctx.lineTo(dx + dw, sy); ctx.stroke();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 - GNU Radio (real noVNC embed) or rendered solution
// ─────────────────────────────────────────────────────────────────────────────
const VARS = [['samp_rate', '96k'], ['baud_rate', '9.6k'], ['deviation', '2.4k'], ['freq_offset', '0']];
let flowgraphMounted = false;
// If a file was uploaded in PHASE 4, refresh the PHASE 5 display (samp_rate chip · File Source hint · restart notice).
function applyUploadedToFlowgraph() {
  fetch('/api/upload').then((r) => r.json()).then((u) => {
    if (!u || !u.exists) return;
    const rateK = (u.sampleRate / 1000);
    const b = $('#varsRow .varchip[data-key="samp_rate"] b'); if (b) b.textContent = rateK + 'k';   // samp_rate chip
    const hint = $('#gnuFileHint'); if (hint) hint.textContent = `File Source: ${u.name} (uploaded) · samp_rate ${rateK}k → ▶ Run`;
    const note = $('#gnuUploadNote');
    if (note) {
      note.classList.remove('hidden');
      note.innerHTML = `⬆ PHASE 4 upload <code>${escHtml(u.name)}</code> set as the File Source ` +
        `(samp_rate ${rateK}k). If GNU Radio is already running, <b>(re)start</b> it with <code>gnuradio-web/run.sh</code> ` +
        `to read this file.`;
    }
  }).catch(() => {});
}
function mountFlowgraph() {
  const vrow = $('#varsRow');
  if (!vrow.childElementCount) VARS.forEach(([k, v]) => { const c = el('div', 'varchip'); c.dataset.key = k; c.innerHTML = `<span>${k} =</span> <b>${v}</b>`; vrow.append(c); });
  applyUploadedToFlowgraph();
  if (flowgraphMounted) return;
  flowgraphMounted = true;
  const slot = $('#gnuradioSlot');
  if (state.cfg.gnuradioUrl) {
    const card = el('div', 'fgcard');
    const f = el('iframe', 'gnuframe'); f.title = 'GNU Radio'; f.src = novncEmbedUrl(state.cfg.gnuradioUrl);
    card.append(el('h3', null, 'GNU RADIO COMPANION · ▶ Run to recover the image'), f);
    slot.append(card);
  } else {
    const card = el('div', 'fgcard'); card.innerHTML = '<h3>ENIGMA-1 DECODER · SOLVED FLOWGRAPH</h3>';
    const cv = el('div', 'fgcanvas'); cv.innerHTML = `<svg class="wirelayer" viewBox="0 0 1180 440" preserveAspectRatio="none"></svg><div class="slotlayer"></div>`;
    card.append(cv);
    card.append(el('div', 'fgnote', '⚠ static render (real GNU Radio not connected) - real: run <code>gnuradio-web/run.sh</code> → set <code>GNURADIO_URL</code>'));
    slot.append(card); renderStaticFlowgraph(cv);
  }
  fetch('/api/grc').then((r) => r.json()).then((d) => { $('#grcText').textContent = d.text; }).catch(() => { $('#grcText').textContent = '(.grc load failed)'; });
  initReassemble();
}
function renderStaticFlowgraph(cv) {
  const svg = cv.querySelector('.wirelayer'); const layer = cv.querySelector('.slotlayer');
  const ns = 'http://www.w3.org/2000/svg';
  svg.innerHTML = `<defs><marker id="arrOk2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#33d17a"/></marker></defs>`;
  WIRES.forEach(([from, to]) => {
    const sf = slotById(from), st = slotById(to); const a = slotCenterRight(sf), b = slotCenterLeft(st);
    const dx = Math.max(30, (b.x - a.x) * 0.45); const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#33d17a'); path.setAttribute('stroke-width', '3'); path.setAttribute('marker-end', 'url(#arrOk2)');
    svg.append(path);
  });
  SLOTS.forEach((s) => {
    const d = el('div', 'slot filled correct');
    d.style.left = `${(s.x / CANVAS_W) * 100}%`; d.style.top = `${(s.y / CANVAS_H) * 100}%`;
    d.style.width = `${(s.w / CANVAS_W) * 100}%`; d.style.height = `${(s.h / CANVAS_H) * 100}%`;
    d.style.cursor = 'default'; d.innerHTML = blockCardHTML(s.id); layer.append(d);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 - live image reassembly (▶ run decode → recover the image frame by frame)
// If real GNU Radio output (gnuradio-out/*.png) exists, use it; otherwise demo with the reference image.
// ─────────────────────────────────────────────────────────────────────────────
const reasImg = new Image();
reasImg.src = '/assets/result.png';
const reas = { running: false, done: false, frac: 0, rows: 128, reps: 0, everDone: false, maxFrac: 0, liveStart: 0, poll: null, real: false };
let reasWired = false;

function initReassemble() {
  if (!reasWired) {
    reasWired = true;
    const btn = $('#decodeRun'); if (btn) btn.addEventListener('click', startDecode);
    reasImg.addEventListener('load', () => { if (state.phase === 'flowgraph' && !reas.running) drawReassemble(); });
  }
  drawReassemble();
}
function loadReasImage(src) {
  return new Promise((resolve) => {
    if (reasImg.src.endsWith(src) && reasImg.complete && reasImg.naturalWidth) return resolve();
    const done = () => { reasImg.removeEventListener('load', done); reasImg.removeEventListener('error', done); resolve(); };
    reasImg.addEventListener('load', done); reasImg.addEventListener('error', done);
    reasImg.src = src;
  });
}
function stopDecode() { if (reas.poll) { clearInterval(reas.poll); reas.poll = null; } reas.running = false; }
// Poll the image/progress that real GNU Radio (▶Run) writes progressively to gnuradio-out and sync live.
// If there is no real progress yet (before ▶Run), demo briefly with the reference image.
async function startDecode() {
  const s = $('#reasStatus'); if (s) s.classList.add('hidden');
  const b = $('#reasBadge'); if (b) b.classList.add('hidden');
  stopDecode();
  reas.running = true; reas.done = false; reas.frac = 0; reas.real = false; reas.everDone = false; reas.maxFrac = 0; reas.liveStart = 0;
  const t0 = performance.now(); let sawLive = false;
  reas.poll = setInterval(async () => {
    if (state.phase !== 'flowgraph') { stopDecode(); return; }
    let live = false, done = false, frac = 0;
    try {
      const p = await (await fetch('/api/decode-progress', { cache: 'no-store' })).json();
      if (p && p.exists) { live = true; sawLive = true; frac = Math.min(1, p.fraction || 0); done = !!p.done; reas.rows = 128; reas.reps = p.reps || 0; if (!reas.liveStart) reas.liveStart = performance.now(); }
    } catch (e) {}
    if (live) {                                   // follow the real progressive image
      reas.real = true;
      await loadReasImage('/decoded.png?t=' + Date.now());
      reas.frac = frac; reas.done = done && frac >= 0.99;
      if (reas.done) reas.everDone = true;
      if (frac > reas.maxFrac) reas.maxFrac = frac;
    } else if (!sawLive) {                         // before ▶Run: 6-second demo with the reference image
      if (!reas.real) { await loadReasImage('/assets/result.png'); reas.frac = Math.min(1, (performance.now() - t0) / 6000); reas.done = reas.frac >= 1; }
    }
    drawReassemble();
    const fill = $('#reasFill'); if (fill) fill.style.width = Math.round(reas.frac * 100) + '%';
    const fr = $('#reasFrame'); if (fr) fr.textContent = reas.real ? `recovered ${Math.round(reas.frac * 100)}% · pass ${(reas.reps || 0) + 1}` : `recovered ${Math.round(reas.frac * 100)}%`;
    const badge = $('#reasBadge');
    const failing = reas.real && !reas.everDone && reas.liveStart && (performance.now() - reas.liveStart > 30000);   // demodulating for over 30s without ever completing = recovery failure (center-frequency offset, etc.)
    if (badge) {
      badge.classList.toggle('reas-fail', failing);
      if (failing) { badge.classList.remove('hidden'); badge.textContent = `⚠ recovery failed: center-frequency offset (after ${(reas.reps || 0) + 1} repeated passes, stuck at max ${Math.round(reas.maxFrac * 100)}%)`; }
      else if (reas.done) { badge.classList.remove('hidden'); badge.textContent = reas.real ? `✅ recovered · pass ${(reas.reps || 0) + 1} (still receiving)` : '✅ recovered'; }
      else badge.classList.add('hidden');
    }
    // Continuous display: keep polling while on PHASE 5 to refresh live (shows repeated demodulation passes in sequence).
    // Only stops when leaving the phase (the state.phase check at the top). The fallback demo also switches automatically once real data arrives.
  }, 350);
}
function reasNoise(ctx, x, y, w, h, intensity) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = '#070d15'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = `rgba(120,150,180,${0.12 * intensity})`;
  const n = Math.min(160, (w * h) / 260);
  for (let i = 0; i < n; i++) ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 2, 1);
}
function drawReassemble() {
  const cv = $('#reasCanvas'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 320, h = cv.clientHeight || 420;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#050a10'; ctx.fillRect(0, 0, w, h);
  if (!reasImg.complete || !reasImg.naturalWidth) { reasNoise(ctx, 8, 8, w - 16, h - 16, 0.5); return; }
  const iw = reasImg.naturalWidth, ih = reasImg.naturalHeight;
  const sc = Math.min((w - 16) / iw, (h - 16) / ih), dw = iw * sc, dh = ih * sc, dx = (w - dw) / 2, dy = (h - dh) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.strokeStyle = '#1e2b3a'; ctx.lineWidth = 1; ctx.strokeRect(dx - 1, dy - 1, dw + 2, dh + 2);
  if (!reas.running && !reas.done) { reasNoise(ctx, dx, dy, dw, dh, 0.55); return; }   // before start: noise
  ctx.drawImage(reasImg, dx, dy, dw, dh);   // draw the full image as-is on one screen (no row split or partial reveal; the real decode fills top to bottom)
}

// ── boot ──
async function boot() {
  buildStepper(); wireNav(); wirePuzzle(); initPuzzle(); wireUploadGate();
  try {
    const [cfg, sat, qth] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/satellite').then((r) => r.json()),
      fetch('/api/qth').then((r) => r.json()).catch(() => null),
    ]);
    state.cfg = cfg; state.sat = sat;
    if (qth && qth[0]) { state.qth = qth[0]; buildSatrec(); }
    renderDossierFull(sat); renderSatInfoStrip(sat);
  } catch (e) { console.error('boot load failed', e); }
  show('mission');
}
boot();
