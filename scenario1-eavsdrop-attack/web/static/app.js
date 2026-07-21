/* ENIGMA-1 Downlink Decoder — Scenario 1 web interface front-end.
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
  mission:   { cls: 'nominal', text: 'MISSION BRIEFING — 수신 목표 이해' },
  target:    { cls: 'info',    text: 'TARGET LOCKED — ENIGMA-1 제원 확인' },
  track:     { cls: 'info',    text: 'TRACK & SYNC — 안테나 추적 · RF 동기화' },
  puzzle:    { cls: 'warn',    text: 'DEMOD PIPELINE — flowgraph 조립 중' },
  flowgraph: { cls: 'info',    text: 'FLOWGRAPH READY — 복조 체인 실행' },
  result:    { cls: 'nominal', text: 'DECODE COMPLETE — 이미지 복원됨' },
};
function refreshBanner() {
  const idx = PHASES.findIndex((p) => p.id === state.phase);
  let b = BANNER[state.phase] || BANNER.mission;
  if (state.phase === 'puzzle' && state.puzzleSolved) b = { cls: 'nominal', text: 'DEMOD PIPELINE — flowgraph 완성' };
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
  if (id === 'flowgraph') mountFlowgraph();
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
// PHASE 2 — full dossier · PHASE 3 — SAT info strip
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
// PHASE 3 — embeds (VSA iframe + GPredict iframe/polar-preview) + remaining time
// ─────────────────────────────────────────────────────────────────────────────
// noVNC 임베드 URL 정규화: iframe 안에서 클릭 좌표가 정확히 매핑되도록 원격을
// 뷰포트에 맞춰 스케일(resize=scale). resize=remote 는 서버가 리사이즈를 지원하지
// 않으면 1:1 스크롤 상태가 되어 클릭이 어긋난다.
function novncEmbedUrl(url) {
  if (!url) return url;
  url = /[?&]resize=/.test(url)
    ? url.replace(/([?&])resize=[^&]*/, '$1resize=scale')
    : url + (url.includes('?') ? '&' : '?') + 'resize=scale';
  if (!/[?&]autoconnect=/.test(url)) url += '&autoconnect=1';
  // 연결이 끊겨(컨테이너 재시작 등) 화면이 얼면 클릭이 안 되므로 자동 재접속.
  if (!/[?&]reconnect=/.test(url)) url += '&reconnect=true&reconnect_delay=2000';
  return url;
}
let embedsMounted = false;
function mountEmbeds() {
  if (embedsMounted) return;
  embedsMounted = true;
  // VSA — served statically by this server; auto-selects ENIGMA-1 + loads its IQ.
  $('#vsaFrame').src = state.cfg.vsaUrl || '/vsa/index.html';
  // GPredict — real noVNC embed if configured, else a polar-tracking preview.
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
    btn.disabled = true; stat.className = 'passstat'; stat.textContent = '계산 중…';
    try {
      const r = await fetch('/api/reset-pass'); const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      stat.className = 'passstat ok';
      const alt = j.maxAltDeg != null ? `최대고도 ${j.maxAltDeg}° · ` : '';
      stat.textContent = `${alt}AOS ${j.aosUtc} · gpredict 재시작…`;
      const f = $('#gpredictSlot iframe');
      setTimeout(() => { if (f) f.src = f.src; stat.textContent = `${alt}AOS ${j.aosUtc} (수신 직전)`; }, 6000);
      refreshOffsetSoon();
    } catch (e) { stat.className = 'passstat err'; stat.textContent = `✗ ${e.message}`; }
    finally { setTimeout(() => { btn.disabled = false; }, 6000); }
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
  if (!state.satrec) { buildSatrec(); if (!state.satrec) { val.textContent = '--:--'; val.className = 'remain-val los'; st.textContent = 'TLE 대기'; return; } }
  const now = Date.now() + state.offsetMs;
  const r = state.remain;
  const need = !r.valid || r.lastOffset !== state.offsetMs || (r.boundaryMs != null && now >= r.boundaryMs) || (now - r.lastCalcMs) > 15000;
  if (need) { const b = findBoundary(now); state.remain = { valid: true, boundaryMs: b.boundaryMs, inPass: b.inPass, lastCalcMs: now, lastOffset: state.offsetMs }; }
  const rr = state.remain;
  if (rr.boundaryMs == null) { val.textContent = '--:--'; val.className = 'remain-val los'; st.textContent = rr.inPass ? 'IN PASS' : '패스 없음'; return; }
  const left = rr.boundaryMs - now;
  val.textContent = fmtDur(left);
  if (rr.inPass) { val.className = 'remain-val' + (left < 60000 ? ' warn' : ''); st.textContent = '● IN PASS · LOS'; }
  else { val.className = 'remain-val los'; st.textContent = '— NEXT AOS'; }
}
// faketime offset from gpredict-web control (:6079 → /api/offset). 0 when no Docker.
let offsetTimer = null;
function startOffsetPoll() {
  if (offsetTimer) return;
  const poll = async () => {
    try { const j = await (await fetch('/api/offset')).json(); if (j && typeof j.offsetMs === 'number') state.offsetMs = j.offsetMs; }
    catch (e) { /* no control server — stay on real time */ }
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
        <div class="gpv-badge" data-k="state">— ACQUIRING —</div>
        <div class="gpv-row"><span>Azimuth</span><b data-k="az">–</b></div>
        <div class="gpv-row"><span>Elevation</span><b data-k="el">–</b></div>
        <div class="gpv-row"><span>Range</span><b data-k="rng">–</b></div>
        <div class="gpv-row"><span>Doppler</span><b data-k="dop">–</b></div>
        <div class="gpv-row"><span>RX freq</span><b data-k="rx">–</b></div>
        <div class="gpv-note">⚠ 폴라 프리뷰 (실물 GPredict 미연결)<br>실물: <code>gpredict-web/run.sh</code> → <code>GPREDICT_URL</code> 로 실행</div>
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
      setv('state', '— LOS · WAITING —'); container.querySelector('.gpv-badge').className = 'gpv-badge';
      setv('az', '—'); setv('el', 'below horizon'); setv('rng', '—'); setv('dop', '—'); setv('rx', '433.5000 MHz');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — flowgraph puzzle (blocks/slots/wires match enigma1_decoder.grc)
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
  puzzle.placement = { file_source: 'file_source' };   // 첫 블록(File Source)은 고정 배치로 시작
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
      if (s.id === 'file_source') { d.classList.add('fixed'); d.insertAdjacentHTML('beforeend', '<div class="slotlock">🔒 고정</div>'); }
    }
    else { d.innerHTML = `<div class="ghostname">${BLOCKS[s.id].phase}</div>`; if (puzzle.selected) d.classList.add('selectable'); }
    d.addEventListener('click', () => onSlotClick(s.id));
    layer.append(d);
  });
}
function renderTray() {
  const tray = $('#tray'); tray.innerHTML = '';
  if (!puzzle.tray.length) { tray.append(el('div', 'traynote', '모든 블록을 배치했다.')); return; }
  puzzle.tray.forEach((id) => {
    const b = BLOCKS[id];
    const chip = el('div', `traychip cat-${b.cat}${puzzle.selected === id ? ' selected' : ''}`);
    chip.innerHTML = `<div class="bp">${b.phase}${b.disabled ? ' · disabled' : ''}</div><div class="bt">${b.title}</div><div class="bs">${b.sub}</div>`;
    chip.addEventListener('click', () => { puzzle.selected = puzzle.selected === id ? null : id; renderTray(); renderSlots(); });
    tray.append(chip);
  });
}
function onSlotClick(slotId) {
  if (slotId === 'file_source') return;   // 고정 블록: 제거/이동 불가
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
  $('#puzzleProg').textContent = `${placed} / ${SLOTS.length} 배치`;
  const solved = correct === SLOTS.length;
  state.puzzleSolved = solved;
  $('#solvedBanner').classList.toggle('hidden', !solved);
  $('#toFlowgraph').disabled = !solved;
  $('#toFlowgraph').textContent = solved ? '정답 flowgraph 확인 →' : '🔒 정답 flowgraph 확인 →';
  refreshStepper(); if (state.phase === 'puzzle') refreshBanner();
  updateSignalFlow();
}
function wirePuzzle() {
  $('#resetPuzzle').addEventListener('click', initPuzzle);
  // 힌트: 올바른 신호 체인 순서를 보여주고, 선택된 블록의 정답 슬롯을 잠깐 강조한다.
  $('#hintPuzzle').addEventListener('click', () => {
    const hb = $('#hintBox');
    const order = ['file_source', 'throttle', 'fir', 'fsk', 'deframer', 'reassembler'];
    const chain = order.map((id) => BLOCKS[id].title).join(' → ');
    hb.innerHTML = `<b>신호 체인 순서</b><br>${chain}<br>
      <span style="color:var(--dim)">· File Source 는 좌측 최하단, Reassembler/Message Debug 는 우측 최상/하단.
      · Waterfall Sink 은 FIR 에서 분기(선택). 트레이의 블록을 선택하면 정답 슬롯이 잠깐 강조됩니다.</span>`;
    hb.classList.remove('hidden');
    if (puzzle.selected) {
      const s = $(`.slot[data-slot="${puzzle.selected}"]`);
      if (s && !s.classList.contains('filled')) { s.style.boxShadow = '0 0 0 2px var(--amber) inset'; setTimeout(() => { s.style.boxShadow = ''; }, 1400); }
    }
  });
  // 정답 배치 (배포 시 제거 예정)
  $('#revealPuzzle').addEventListener('click', () => {
    puzzle.placement = {}; SLOTS.forEach((s) => { puzzle.placement[s.id] = s.id; });
    puzzle.tray = []; puzzle.selected = null;
    renderSlots(); renderTray(); drawWires(); updatePuzzleState();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — STEP 0 녹음 파일 업로드 게이트 (업로드 완료 시 퍼즐 노출)
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
// .cf32(complex float32 IQ) 검증 후, PHASE 5 실물 GNU Radio 의 File Source 로 쓰도록 서버에 전송한다.
async function handleRecFile(file) {
  const info = $('#ugInfo'); if (!info) return;
  info.classList.remove('hidden', 'ug-err', 'ug-ok');
  info.innerHTML = '⏳ 파일 검증 중…';
  const name = file.name, size = file.size;
  const okExt = /\.(cf32|iq|raw|c64|dat)$/i.test(name);
  if (size < 4096 || size % 8 !== 0) {
    return ugError(`complex float32(IQ) 형식이 아닙니다 — 크기 ${fmtBytes(size)} (8바이트 배수가 아니거나 너무 작음). Virtual Antenna 에서 녹음한 .cf32 를 올리세요.`);
  }
  let ok = true, peak = 0;                              // 앞부분을 float32 로 해석해 실제 IQ 인지 확인
  try {
    const buf = await file.slice(0, 8192).arrayBuffer();
    const f = new Float32Array(buf);
    for (let i = 0; i < f.length; i++) { const v = f[i]; if (!Number.isFinite(v)) { ok = false; break; } const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak === 0 || peak > 1e6) ok = false;   // NaN/Inf 는 위 isFinite 에서 이미 차단; 정규화 안 된 캡처도 허용
  } catch (e) { ok = false; }
  if (!ok) return ugError('IQ 데이터로 해석되지 않습니다. Virtual Antenna 에서 녹음한 .cf32(complex float32) 파일인지 확인하세요.');
  const samples = size / 8, durAt50k = samples / 50000;
  state.recUploaded = true; state.recFile = { name, size, samples };
  BLOCKS.file_source.sub = name.length > 26 ? name.slice(0, 25) + '…' : name;   // 퍼즐 첫 블록 + PHASE5 File Source 라벨
  info.classList.remove('ug-err'); info.classList.add('ug-ok');
  info.innerHTML =
    `✅ <b>${escHtml(name)}</b> 업로드 완료` +
    `<br>크기 ${fmtBytes(size)} · IQ 샘플 ${samples.toLocaleString()}개 (complex float32)` +
    (okExt ? '' : ' · <span class="ug-warn">확장자 비표준</span>') +
    `<br><span class="ug-sub">≈ ${durAt50k.toFixed(1)}초 @ 50 kSps · 복조 flowgraph 퍼즐을 활성화합니다…</span>` +
    `<br><span id="ugServerLine" class="ug-sub">⏳ PHASE 5 GNU Radio 용으로 서버 전송 중…</span>`;
  uploadToServer(file, name, 50000).then((r) => {          // PHASE 5 실물 GNU Radio File Source 스테이징
    const el = $('#ugServerLine'); if (!el) return;
    el.textContent = (r && r.ok)
      ? '⬆ 서버 등록 완료 — PHASE 5 실물 GNU Radio 의 File Source 로 사용됩니다'
      : '⚠ 서버 전송 실패 — 퍼즐은 진행되지만 PHASE 5 파일소스에는 반영되지 않습니다';
  });
  setTimeout(revealPuzzleBody, 900);                   // 결과를 잠깐 보여준 뒤 퍼즐 노출
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
  // 노출 후 레이아웃이 확정된 시점에 퍼즐을 새로 그린다(첫 블록 고정 + 업로드 파일명 반영).
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
  // 라벨 내부 자식으로 커서가 넘어갈 때 dragleave 가 조기 발화하지 않도록 실제 이탈만 처리
  drop.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !drop.contains(e.relatedTarget)) drop.classList.remove('dragover'); });
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleRecFile(f);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — signal-flow preview (블록을 맞출수록 각 단계 신호가 살아난다)
// 각 단계는 "그 지점까지의 체인이 정답으로 채워졌을 때"만 활성화되어 애니메이션한다.
// ─────────────────────────────────────────────────────────────────────────────
const SIGFLOW = [
  { key: 'iq',     label: 'RAW IQ',    sub: 'IQ + 잡음',      need: ['file_source'] },
  { key: 'filter', label: 'FILTER',    sub: '협대역 · 도플러', need: ['file_source', 'throttle', 'fir'] },
  { key: 'demod',  label: 'FSK DEMOD', sub: '마크 · 스페이스', need: ['file_source', 'throttle', 'fir', 'fsk'] },
  { key: 'frame',  label: 'AX.25',     sub: '프레임 (HDLC)',   need: ['file_source', 'throttle', 'fir', 'fsk', 'deframer'] },
  { key: 'image',  label: 'IMAGE',     sub: '재조립',          need: ['file_source', 'throttle', 'fir', 'fsk', 'deframer', 'reassembler'] },
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
    if (state.phase !== 'puzzle') { sigflowRAF = null; return; }   // 다른 phase 로 가면 정지
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
  if (!active) {   // 비활성: 흐린 점선 baseline
    ctx.strokeStyle = '#1c2836'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(6, h / 2); ctx.lineTo(w - 6, h / 2); ctx.stroke(); ctx.setLineDash([]);
    return;
  }
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  if (key === 'iq') {                                   // 잡음 섞인 IQ (I 시안 / Q 보라)
    const line = (color, ph) => { ctx.strokeStyle = color; ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const n = Math.sin(x * 0.35 - t * 3 + ph) * 0.5 + Math.sin(x * 0.14 - t * 2.1 + ph) * 0.3 + Math.sin(x * 0.8 - t * 4.7 + ph) * 0.2;
        const y = h / 2 + n * (h * 0.30); x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      } ctx.stroke(); };
    line('#39c5ff', 0); line('#8a7dff', 1.7);
  } else if (key === 'filter') {                        // 필터 전(광대역·잡음·오프셋) ▸ 후(협대역·정렬·저잡음)
    const gap = 16, pad = 5, midX = w / 2, baseY = h - 6, topY = 13;
    const lx0 = pad, lx1 = midX - gap / 2, rx0 = midX + gap / 2, rx1 = w - pad;
    const spectrum = (x0, x1, peakFrac, sigma, peakH, noiseAmp, col) => {
      const cx = x0 + (x1 - x0) * peakFrac;
      ctx.strokeStyle = 'rgba(95,125,155,.55)'; ctx.lineWidth = 1; ctx.beginPath();   // 노이즈 플로어
      let first = true;
      for (let x = x0; x <= x1; x += 2) {
        const n = Math.max(0, (Math.sin(x * 1.9 + t * 5) * 0.5 + 0.5) + Math.sin(x * 0.7 - t * 3) * 0.35);
        const y = baseY - n * noiseAmp; first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();                       // 반송파 피크
      for (let x = x0; x <= x1; x += 1.5) {
        const g = Math.exp(-Math.pow((x - cx) / sigma, 2));
        const n = (Math.sin(x * 1.9 + t * 5) * 0.5 + 0.5) * noiseAmp * 0.5;
        const y = baseY - (g * peakH + n); x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    ctx.fillStyle = 'rgba(57,197,255,.10)';                                            // OUT 통과대역(가운데만 통과)
    ctx.fillRect((rx0 + rx1) / 2 - 7, topY, 14, baseY - topY);
    spectrum(lx0, lx1, 0.66, 8, (h - topY) * 0.5 * (0.85 + 0.15 * Math.sin(t * 3)), (h - topY) * 0.30, '#7f92a6');  // 전
    spectrum(rx0, rx1, 0.5, 4.5, (h - topY) * 0.80 * (0.85 + 0.15 * Math.sin(t * 4)), (h - topY) * 0.07, '#39c5ff'); // 후
    ctx.fillStyle = '#33d17a'; ctx.font = '12px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▸', midX, (topY + baseY) / 2);
    ctx.fillStyle = '#7f92a6'; ctx.font = '9px ui-monospace,monospace'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText('전(광대역)', lx0, 2);
    ctx.textAlign = 'right'; ctx.fillText('후(협대역)', rx1, 2);
  } else if (key === 'demod') {                         // FSK: 마크/스페이스 사각파 + 아래 0/1 비트 스트림
    const bits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1], bw = 14, off = (t * 38) % bw;
    const hi = h * 0.18, lo = h * 0.48;
    ctx.strokeStyle = '#33d17a'; ctx.lineWidth = 2; ctx.beginPath(); let started = false;    // 사각파(마크/스페이스)
    for (let i = -1; i < Math.ceil(w / bw) + 1; i++) {
      const bit = bits[((i % bits.length) + bits.length) % bits.length], x0 = i * bw - off, y = bit ? hi : lo;
      if (!started) { ctx.moveTo(x0, y); started = true; } else ctx.lineTo(x0, y); ctx.lineTo(x0 + bw, y);
    } ctx.stroke();
    ctx.strokeStyle = 'rgba(95,125,155,.22)'; ctx.lineWidth = 1;                             // 구분선
    ctx.beginPath(); ctx.moveTo(0, h * 0.60); ctx.lineTo(w, h * 0.60); ctx.stroke();
    ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';   // 0/1 스트림(파형과 동기)
    for (let i = -1; i < Math.ceil(w / bw) + 1; i++) {
      const bit = bits[((i % bits.length) + bits.length) % bits.length], cx = i * bw - off + bw / 2;
      if (cx < -6 || cx > w + 6) continue;
      ctx.fillStyle = bit ? '#33d17a' : '#5b6b7d';
      ctx.fillText(bit ? '1' : '0', cx, h * 0.82);
    }
  } else if (key === 'frame') {                         // 0/1 비트가 AX.25 필드로 묶이는 모습
    const pad = 5;
    // 상단: 들어오는 0/1 비트 스트림(demod 에서 넘어온 비트가 흘러들어옴)
    const inb = [1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0], ibw = 9, ioff = (t * 30) % ibw;
    ctx.font = '8px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = -1; i < Math.ceil(w / ibw) + 1; i++) {
      const bit = inb[((i % inb.length) + inb.length) % inb.length], cx = i * ibw - ioff + ibw / 2;
      if (cx < -4 || cx > w + 4) continue;
      ctx.fillStyle = bit ? 'rgba(51,209,122,.6)' : 'rgba(95,125,155,.5)'; ctx.fillText(bit ? '1' : '0', cx, 8);
    }
    ctx.fillStyle = '#5b6b7d'; ctx.fillText('▾ 묶기', w / 2, 18);
    // 하단: AX.25 UI 프레임 필드 (조립 스윕이 지나가며 각 필드가 채워짐)
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
  } else if (key === 'image') {                         // 복원 이미지 + 스캔라인
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
// PHASE 5 — GNU Radio (real noVNC embed) or rendered solution
// ─────────────────────────────────────────────────────────────────────────────
const VARS = [['samp_rate', '96k'], ['baud_rate', '9.6k'], ['deviation', '2.4k'], ['freq_offset', '0']];
let flowgraphMounted = false;
// PHASE 4 에서 업로드한 파일이 있으면 PHASE 5 표시(samp_rate 칩 · File Source 힌트 · 재시작 안내)를 갱신.
function applyUploadedToFlowgraph() {
  fetch('/api/upload').then((r) => r.json()).then((u) => {
    if (!u || !u.exists) return;
    const rateK = (u.sampleRate / 1000);
    const b = $('#varsRow .varchip[data-key="samp_rate"] b'); if (b) b.textContent = rateK + 'k';   // samp_rate 칩
    const hint = $('#gnuFileHint'); if (hint) hint.textContent = `File Source: ${u.name} (업로드) · samp_rate ${rateK}k → ▶ Run`;
    const note = $('#gnuUploadNote');
    if (note) {
      note.classList.remove('hidden');
      note.innerHTML = `⬆ PHASE 4 업로드 파일 <code>${escHtml(u.name)}</code> 이(가) File Source 로 설정됨 ` +
        `(samp_rate ${rateK}k). 이미 실행 중인 GNU Radio 라면 <code>gnuradio-web/run.sh</code> 로 ` +
        `<b>(재)시작</b>해야 이 파일을 읽습니다.`;
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
    card.append(el('h3', null, 'GNU RADIO COMPANION · ▶ Run 하면 이미지가 복원됩니다'), f);
    slot.append(card);
  } else {
    const card = el('div', 'fgcard'); card.innerHTML = '<h3>ENIGMA-1 DECODER · SOLVED FLOWGRAPH</h3>';
    const cv = el('div', 'fgcanvas'); cv.innerHTML = `<svg class="wirelayer" viewBox="0 0 1180 440" preserveAspectRatio="none"></svg><div class="slotlayer"></div>`;
    card.append(cv);
    card.append(el('div', 'fgnote', '⚠ 정적 렌더 (실물 GNU Radio 미연결) — 실물: <code>gnuradio-web/run.sh</code> → <code>GNURADIO_URL</code> 로 실행'));
    slot.append(card); renderStaticFlowgraph(cv);
  }
  fetch('/api/grc').then((r) => r.json()).then((d) => { $('#grcText').textContent = d.text; }).catch(() => { $('#grcText').textContent = '(.grc 로드 실패)'; });
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
// PHASE 5 — 실시간 이미지 재조합 (▶ 디코드 실행 → 프레임 순서대로 이미지 복원)
// 실물 GNU Radio 출력(gnuradio-out/*.png)이 있으면 그걸 사용, 없으면 기준 이미지로 시연.
// ─────────────────────────────────────────────────────────────────────────────
const reasImg = new Image();
reasImg.src = '/assets/result.png';
const reas = { running: false, done: false, frame: 0, total: 29, startT: 0, raf: null, real: false };
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
async function startDecode() {
  reas.real = false;
  try {
    const j = await (await fetch('/api/decoded', { cache: 'no-store' })).json();
    if (j && j.exists) { reas.real = true; await loadReasImage('/decoded.png?t=' + Date.now()); }
    else await loadReasImage('/assets/result.png');
  } catch (e) { await loadReasImage('/assets/result.png'); }
  const s = $('#reasStatus'); if (s) s.classList.add('hidden');
  const b = $('#reasBadge'); if (b) b.classList.add('hidden');
  reas.running = true; reas.done = false; reas.frame = 0; reas.startT = performance.now();
  if (reas.raf) cancelAnimationFrame(reas.raf);
  const loop = (now) => {
    if (state.phase !== 'flowgraph') { reas.running = false; reas.raf = null; return; }
    reas.frame = Math.min(reas.total, Math.floor((now - reas.startT) / 150));   // 150ms/프레임
    drawReassemble();
    const fill = $('#reasFill'); if (fill) fill.style.width = (reas.frame / reas.total * 100) + '%';
    const fr = $('#reasFrame'); if (fr) fr.textContent = `프레임 ${reas.frame} / ${reas.total}`;
    if (reas.frame >= reas.total) {
      reas.running = false; reas.done = true; drawReassemble();
      const badge = $('#reasBadge'); if (badge) { badge.textContent = reas.real ? '✅ 복원 완료 · 실물 GNU Radio 출력' : '✅ 복원 완료'; badge.classList.remove('hidden'); }
      return;
    }
    reas.raf = requestAnimationFrame(loop);
  };
  reas.raf = requestAnimationFrame(loop);
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
  const revealed = reas.running ? reas.frame : (reas.done ? reas.total : 0);
  if (revealed <= 0) { reasNoise(ctx, dx, dy, dw, dh, 0.55); return; }
  const revRows = Math.min(ih, Math.round(revealed * (ih / reas.total)));
  ctx.drawImage(reasImg, 0, 0, iw, revRows, dx, dy, dw, revRows * sc);   // 복원된 윗부분
  if (revRows < ih) {
    const ny = dy + revRows * sc;
    reasNoise(ctx, dx, ny, dw, dy + dh - ny, 0.7);                        // 아직 안 온 아랫부분
    ctx.strokeStyle = '#39c5ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(dx, ny); ctx.lineTo(dx + dw, ny); ctx.stroke();
  }
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
