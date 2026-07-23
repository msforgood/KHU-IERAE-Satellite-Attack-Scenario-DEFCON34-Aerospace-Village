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
  { id: 'analyze',   label: 'ANALYZE' },
  { id: 'puzzle',    label: 'PUZZLE' },
  { id: 'flowgraph', label: 'FLOWGRAPH' },
  { id: 'result',    label: 'RESULT' },
];
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

const state = {
  phase: 'mission', reached: { mission: true }, puzzleSolved: false,
  recUploaded: false, recFile: null, recFileObj: null,
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
// The stepper shows 4 phases (mission/target are intro, result is the outro; all screens stay).
const STEPPER = [
  { id: 'track',     label: 'Track' },
  { id: 'analyze',   label: 'Analyze' },
  { id: 'puzzle',    label: 'Puzzle' },
  { id: 'flowgraph', label: 'Execute' },
];
function buildStepper() {
  const nav = $('#stepper'); nav.innerHTML = '';
  STEPPER.forEach((p, i) => {
    const item = el('div', 'stepitem'); item.dataset.id = p.id;
    item.append(el('span', 'sn', String(i + 1)), el('span', 'sl', p.label));
    item.addEventListener('click', () => { if (canGo(p.id)) show(p.id); });
    nav.append(item);
  });
  renderPhaseTags();
}
// Renumber the phase-tag labels ("PHASE n / NAME") for the 4 stepper phases.
function renderPhaseTags() {
  STEPPER.forEach((p, i) => {
    const t = $(`#p-${p.id} .phasetag[data-tag]`);
    if (t) t.textContent = `PHASE ${i + 1} / ${p.label.toUpperCase()}`;
  });
}
function canGo(id) {
  if (state.reached[id]) return true;
  if (id === 'puzzle') return state.recUploaded;      // the puzzle needs the PHASE 4 capture
  if (id === 'flowgraph') return state.puzzleSolved;
  return false;
}
function refreshStepper() {
  const order = STEPPER.map((p) => p.id);
  const curIdx = order.indexOf(state.phase);
  STEPPER.forEach((p, i) => {
    const item = $(`.stepitem[data-id="${p.id}"]`); if (!item) return;
    item.classList.toggle('active', p.id === state.phase);
    item.classList.toggle('done', curIdx > -1 && i < curIdx && state.reached[p.id]);
    item.classList.toggle('locked', !canGo(p.id));
  });
}

const BANNER = {
  mission:   { cls: 'nominal', text: 'MISSION BRIEFING: know the goal' },
  target:    { cls: 'info',    text: 'TARGET LOCKED: ENIGMA-1 specs confirmed' },
  track:     { cls: 'info',    text: 'TRACK & SYNC: antenna tracking / RF sync' },
  analyze:   { cls: 'info',    text: 'CAPTURE & ANALYZE: spectrum / waterfall on the captured IQ' },
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
  if (id === 'analyze') mountAnalyze();
  if (id === 'flowgraph') { mountFlowgraph(); startDecode(); }   // start live reassembly automatically on entry (no manual button needed)
  if (id === 'result') { const ri = $('#resultImg'); if (ri) ri.src = '/decoded.png?t=' + Date.now(); }   // show the actual recovered image (fresh)
  if (id === 'puzzle') {   // upload + analysis already happened in PHASE 4; refresh labels and start the preview
    requestAnimationFrame(() => { renderSlots(); renderTray(); drawWires(); updatePuzzleState(); startSignalFlow(); });
  }
}

function wireNav() {
  $('#ackChk').addEventListener('change', (e) => { $('#toTarget').disabled = !e.target.checked; });
  $('#toTarget').addEventListener('click', () => show('target'));
  $('#toTrack').addEventListener('click', () => show('track'));
  $('#toAnalyze').addEventListener('click', () => show('analyze'));
  $('#toPuzzle').addEventListener('click', () => { if (state.recUploaded) show('puzzle'); });
  $('#toFlowgraph').addEventListener('click', () => { if (state.puzzleSolved) show('flowgraph'); });
  $('#toResult').addEventListener('click', () => show('result'));
  const th = $('#trackHint');
  if (th) th.addEventListener('click', () => {
    const box = $('#trackHintBox');
    const show = box ? box.classList.contains('hidden') : true;   // reveal if currently hidden
    if (box) box.classList.toggle('hidden', !show);
    document.querySelectorAll('.si-cell[data-si]').forEach((cell) => cell.classList.toggle('hl', show));
    if (show && box) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  // Result-page "Restart ↺" = next participant, so it runs the SAME full reset (recreate gpredict +
  // GNU Radio, clear the recorded signal / recovered image, reload) rather than a client-only redo.
  $('#restart').addEventListener('click', () => { doFullReset(); });
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 - full dossier / PHASE 3 - SAT info strip
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
    ['Center freq', sat.rf?.['Downlink freq']],
    ['Modulation', sat.rf?.['Modulation']],
    ['Symbol rate', sat.rf?.['Symbol rate']],
    ['Sample rate', sat.sdr?.['Sample rate']],
    ['Polarization', sat.rf?.['Polarization']],
    ['Doppler', sat.passes?.['Doppler shift @433.5 MHz']],
    ['Framing', sat.rf?.['Framing']],
  ];
  cells.forEach(([k, v]) => { if (!v) return; const c = el('div', 'si-cell'); if (k === 'Center freq') c.dataset.si = 'center'; else if (k === 'Polarization') c.dataset.si = 'pol'; c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`; root.append(c); });
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
// Make the VSA card exactly as tall as the Gpredict card. Gpredict's height comes from its
// main-window aspect (natural, no black bars); the VSA follows so the two panes line up.
let _syncBound = false;
function syncEmbedHeights() {
  const apply = () => {
    const gp = $('#gpredictSlot');
    const vsaBody = $('#vsaFrame') && $('#vsaFrame').parentElement;
    if (gp && vsaBody && gp.offsetHeight) vsaBody.style.height = gp.offsetHeight + 'px';
  };
  requestAnimationFrame(apply);
  setTimeout(apply, 250);
  if (!_syncBound) { window.addEventListener('resize', apply); _syncBound = true; }
}
function mountEmbeds() {
  if (embedsMounted) return;
  embedsMounted = true;
  // VSA - served statically by this server; auto-selects ENIGMA-1 + loads its IQ.
  $('#vsaFrame').src = state.cfg.vsaUrl || '/vsa/index.html';
  // GPredict - real noVNC embed if configured, else a polar-tracking preview.
  const slot = $('#gpredictSlot');
  if (state.cfg.gpredictUrl) {
    // Wrap the iframe in a clip box so only the main window band shows; the slot then takes
    // that band's natural height and the VSA card is synced to match it (syncEmbedHeights).
    const clip = el('div', 'gpclip');
    const f = el('iframe', 'embedframe'); f.title = 'GPredict';
    f.allow = 'clipboard-read; clipboard-write';
    f.src = novncEmbedUrl(state.cfg.gpredictUrl); clip.append(f); slot.append(clip);
  } else {
    makeGpredictView(slot);
  }
  syncEmbedHeights();
  wireResetPass();
  wireAutoControls();
  wireRecord();
  wireVsaControls();
  startGpredictStatusPoll();
  startOffsetPoll();
  startRemainingCountdown();
}

// Phase-3 record button: triggers the VSA's own IQ recorder inside the embedded VSA
// iframe (same origin), so it saves exactly what the VSA REC button would.
let recTimer = null;
function wireRecord() {
  const btn = $('#btnRecord'), stat = $('#btnRecordStat');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const frame = $('#vsaFrame');
    let vbtn = null;
    try { vbtn = frame && frame.contentDocument && frame.contentDocument.getElementById('btn-record-iq'); } catch (e) {}
    if (!vbtn) { stat.className = 'passstat err'; stat.textContent = '✗ Virtual Antenna not ready yet'; return; }
    vbtn.click();   // toggle the VSA recorder
    const recording = vbtn.classList.contains('recording');
    btn.classList.toggle('recording', recording);
    btn.textContent = recording ? '■ Stop & save' : '⏺ Record';
    stat.className = 'passstat ok';
    if (recording) {
      const t0 = performance.now();
      const fmt = () => { const s = Math.floor((performance.now() - t0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
      if (recTimer) clearInterval(recTimer);
      stat.textContent = `● Recording ${fmt()}`;
      recTimer = setInterval(() => { stat.textContent = `● Recording ${fmt()}`; }, 250);   // live elapsed record time
    } else {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
      // The VSA saves asynchronously (POST /api/upload). VERIFY the server actually stored it rather
      // than assuming success, so a failed save shows a real error instead of a misleading "saved".
      stat.className = 'passstat'; stat.textContent = '⏳ saving to the server…';
      const startedAt = Date.now();
      let tries = 0;
      const verify = async () => {
        let u = null;
        try { u = await (await fetch('/api/upload', { cache: 'no-store' })).json(); } catch (e) {}
        if (u && u.exists && u.size && (!u.uploadedAt || u.uploadedAt * 1000 > startedAt - 4000)) {
          stat.className = 'passstat ok';
          stat.textContent = `✓ saved (${(u.size / 1048576).toFixed(1)} MB) - ready for Phase 4`;
          return;
        }
        if (++tries < 12) { setTimeout(verify, 700); return; }
        stat.className = 'passstat err';
        stat.textContent = '✗ save failed - record again (hold Record a few seconds before Stop)';
      };
      setTimeout(verify, 700);
    }
  });
}

// Phase-3 antenna + sample-rate controls: drive the VSA's own inputs inside the iframe
// (same origin), since the VSA's left panel is hidden.
function vsaEl(id) {
  const f = $('#vsaFrame');
  try { return f && f.contentDocument ? f.contentDocument.getElementById(id) : null; } catch (e) { return null; }
}
// Only the correct antenna (Helix, RHCP) receives ENIGMA-1: green when Helix is chosen, red otherwise.
const CORRECT_ANTENNA = 'helix';
function markAntenna(val) {
  const st = $('#antStat');
  const correct = String(val || '').toLowerCase() === CORRECT_ANTENNA;
  // Keep the dropdown in its plain, readable style (no green/red tint bleeding into the <option>
  // list); only the status message beside it turns green (correct) / red (wrong).
  if (st) {
    st.className = 'passstat ' + (correct ? 'ok' : 'err');
    st.textContent = correct ? '✓ correct antenna (RHCP) - signal received' : '✗ wrong antenna - no signal (try another)';
  }
}
function wireVsaControls() {
  const antSel = $('#antSelect'), antStat = $('#antStat');
  const srInput = $('#srInput'), srBtn = $('#btnSampleRate'), srStat = $('#srStat');
  // copy the VSA's antenna options into our dropdown once the iframe is ready
  const fill = setInterval(() => {
    const vsel = vsaEl('ctrl-type');
    if (vsel && !antSel.dataset.filled) {
      antSel.innerHTML = vsel.innerHTML;
      antSel.value = vsel.value;
      antSel.dataset.filled = '1';
      markAntenna(antSel.value);
      const sr = vsaEl('ctrl-samplerate'); if (sr && sr.value) srInput.value = sr.value;
      clearInterval(fill);
    }
  }, 500);
  setTimeout(() => clearInterval(fill), 10000);

  if (antSel && !antSel.dataset.wired) {
    antSel.dataset.wired = '1';
    antSel.addEventListener('change', () => {
      const vsel = vsaEl('ctrl-type');
      if (!vsel) { antStat.className = 'passstat err'; antStat.textContent = '✗ Virtual Antenna not ready'; return; }
      vsel.value = antSel.value;
      vsel.dispatchEvent(new Event('change', { bubbles: true }));
      markAntenna(antSel.value);
    });
  }
  if (srBtn && !srBtn.dataset.wired) {
    srBtn.dataset.wired = '1';
    srBtn.addEventListener('click', () => {
      const vin = vsaEl('ctrl-samplerate');
      if (!vin) { srStat.className = 'passstat err'; srStat.textContent = '✗ Virtual Antenna not ready'; return; }
      const v = parseFloat(srInput.value);
      if (!isFinite(v) || v <= 0) { srStat.className = 'passstat err'; srStat.textContent = '✗ invalid'; return; }
      vin.value = String(v);
      vin.dispatchEvent(new Event('change', { bubbles: true }));
      srStat.className = 'passstat ok';
      srStat.textContent = `✓ ${v} MSps`;
    });
  }
}

// Phase-3 one-click GPredict controls. Each button drives the Antenna/Radio Control via
// the /api proxy -> control.py (xdotool), and the REAL applied state (engaged / tracking,
// read from the bridge at :4535) is polled and shown, so the buttons are not blind toggles.
let gpStatusTimer = null;

function applyBtnState(btnId, statId, active, partial, text) {
  const stat = $('#' + statId);
  if (stat && stat.dataset.busy) return;   // an action is running on this button; don't fight it
  const btn = $('#' + btnId);
  if (btn) { btn.classList.toggle('applied', !!active); btn.classList.toggle('partial', !active && !!partial); }
  if (stat) {
    stat.className = 'passstat ' + (active ? 'ok' : (partial ? 'warn' : 'dim'));
    stat.textContent = text;
  }
}

function reflectGpredictStatus(st) {
  if (!st || !st.ok) return;
  // The Track button engages + tracks; rotorEngaged is the rock-solid applied signal (the rotor
  // position command is throttled by the deg-threshold, so rotorTracking alone would flicker).
  applyBtnState('btnTrack', 'btnTrackStat', st.rotorEngaged, false,
    st.rotorEngaged ? '● tracking (engaged)' : 'not engaged');
  const mhz = st.downlinkHz ? (st.downlinkHz / 1e6).toFixed(3) : '—';
  applyBtnState('btnFreq', 'btnFreqStat', st.radioEngaged, false,
    st.radioEngaged ? `● engaged, downlink ${mhz} MHz` : `not engaged (set: ${mhz} MHz)`);
  applyBtnState('btnDoppler', 'btnDopplerStat', st.radioTracking, false,
    st.radioTracking ? '● Doppler correction on' : 'Doppler correction off');
}

async function pollGpredictStatus() {
  if (state.phase !== 'track') return;
  try {
    const r = await fetch('/api/gpredict-status');
    reflectGpredictStatus(await r.json());
  } catch { /* bridge/control unreachable -> keep last shown state */ }
}

function startGpredictStatusPoll() {
  if (gpStatusTimer) return;
  pollGpredictStatus();
  gpStatusTimer = setInterval(pollGpredictStatus, 2500);
}

function wireAutoControls() {
  async function post(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!j.ok) throw new Error(j.error || 'failed');
    return j;
  }
  function wire(id, statId, handler) {
    const btn = $('#' + id);
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const stat = $('#' + statId);
      btn.disabled = true;
      if (stat) { stat.dataset.busy = '1'; stat.className = 'passstat'; stat.textContent = 'working…'; }
      let err = null;
      try { await handler(); } catch (e) { err = e; }
      if (err && stat) { stat.className = 'passstat err'; stat.textContent = `✗ ${err.message}`; }
      // let gpredict settle, then reflect the real resulting state (unless the call errored)
      setTimeout(() => {
        btn.disabled = false;
        if (stat) delete stat.dataset.busy;
        if (!err) pollGpredictStatus();
      }, 1200);
    });
  }

  wire('btnTrack', 'btnTrackStat', () => post('/api/rotor-track-engage'));
  wire('btnDoppler', 'btnDopplerStat', () => post('/api/radio-track'));
  wire('btnFreq', 'btnFreqStat', async () => {
    const mhz = parseFloat($('#freqInput').value);
    if (!isFinite(mhz) || mhz <= 0) throw new Error('invalid frequency value');
    await post(`/api/radio-apply?hz=${Math.round(mhz * 1e6)}`);   // toggle: sets freq + engages, or disengages
  });
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
      const alt = j.maxAltDeg != null ? `max elevation ${j.maxAltDeg}° / ` : '';
      const lead = j.leadSec != null ? ` / signal in ${j.leadSec}s` : ' (signal imminent)';
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
  if (rr.inPass) { val.className = 'remain-val' + (left < 60000 ? ' warn' : ''); st.textContent = '● IN PASS / LOS'; }
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
        <div class="gpv-title">GPREDICT / TRACKING</div>
        <div class="gpv-sat">🛰 ENIGMA-1</div>
        <div class="gpv-badge" data-k="state">- ACQUIRING -</div>
        <div class="gpv-row"><span>Azimuth</span><b data-k="az">-</b></div>
        <div class="gpv-row"><span>Elevation</span><b data-k="el">-</b></div>
        <div class="gpv-row"><span>Range</span><b data-k="rng">-</b></div>
        <div class="gpv-row"><span>Doppler</span><b data-k="dop">-</b></div>
        <div class="gpv-row"><span>RX freq</span><b data-k="rx">-</b></div>
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
      setv('state', '- LOS / WAITING -'); container.querySelector('.gpv-badge').className = 'gpv-badge';
      setv('az', '-'); setv('el', 'below horizon'); setv('rng', '-'); setv('dop', '-'); setv('rx', '433.5000 MHz');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 - flowgraph puzzle (blocks/slots/wires match enigma1_decoder.grc)
// ─────────────────────────────────────────────────────────────────────────────
const BLOCKS = {
  file_source: { cat: 'src',  phase: 'SOURCE',   title: 'File Source',                sub: 'enigma34_downlink.cf32',
    desc: 'Reads the recorded IQ samples (your captured .cf32 file) from disk and streams them into the flowgraph as the raw signal to process. This is where the whole demod chain starts.' },
  throttle:    { cat: 'flow', phase: 'FLOW',     title: 'Throttle',                   sub: 'Sample Rate: 96k',
    desc: 'Paces the sample stream to the set sample rate so a recorded file plays back at realistic speed instead of as fast as the CPU can run. Only needed for file sources, not live radios.' },
  fir:         { cat: 'dsp',  phase: 'FILTER',   title: 'Freq Xlating FIR Filter',    sub: 'Decim 1 / low_pass',
    desc: 'Shifts ENIGMA-1\'s channel down to baseband (frequency translation) and low-pass filters it, isolating the signal of interest and rejecting everything outside its bandwidth.' },
  fsk:         { cat: 'dsp',  phase: 'DEMOD',    title: 'FSK Demodulator',            sub: '9.6k baud',
    desc: 'Recovers the digital bits from the frequency-shift-keyed carrier by tracking the shift between the two tones (mark and space) at the 9.6k baud symbol rate.' },
  waterfall:   { cat: 'sink', phase: 'SINK',     title: 'QT GUI Waterfall Sink',      sub: '433.5 MHz', disabled: true,
    desc: 'A display-only sink that shows the live spectrum and waterfall so you can see the signal in frequency and time. It does not change the decoded data (disabled in this chain).' },
  deframer:    { cat: 'dsp',  phase: 'DEFRAME',  title: 'AX.25 Deframer',             sub: 'G3RUH: True',
    desc: 'Turns the demodulated bitstream into AX.25 frames. It undoes the G3RUH scrambling, finds frame boundaries, and checks each packet for errors before passing it on.' },
  reassembler: { cat: 'sink', phase: 'SINK',     title: 'ENIGMA-1 Image Reassembler', sub: '→ png',
    desc: 'Collects the decoded packets in order and rebuilds the downlinked image, writing the finished picture out as a PNG. This is the payload you are trying to recover.' },
  msgdebug:    { cat: 'sink', phase: 'SINK',     title: 'Message Debug',              sub: 'Print PDU: On',
    desc: 'Prints each decoded packet (PDU) to the console so you can read the raw message contents. A debugging sink that helps confirm the frames are being decoded correctly.' },
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
    <div class="bp">${b.phase}${b.disabled ? ' / disabled' : ''}</div>
    <div class="bt">${b.title}</div><div class="bs">${b.sub}</div></div>`;
}
// Show a block's role description in the panel below the puzzle (all blocks clickable).
function showBlockInfo(id) {
  const b = BLOCKS[id]; if (!b) return;
  const box = $('#blockInfo'), body = $('#blockInfoBody');
  if (!box || !body) return;
  box.classList.add('active');
  body.innerHTML = `<div class="bi-head">
      <span class="bi-phase cat-${b.cat}">${b.phase}${b.disabled ? ' / disabled' : ''}</span>
      <span class="bi-title">${b.title}</span>
      <span class="bi-sub">${b.sub}</span>
    </div>
    <div class="bi-desc">${b.desc || ''}</div>`;
}
function resetBlockInfo() {
  const box = $('#blockInfo'), body = $('#blockInfoBody');
  if (box) box.classList.remove('active');
  if (body) body.textContent = 'Click any block (in the tray or on the canvas) to see what it does in the demod chain.';
}
function initPuzzle() {
  puzzle.placement = { file_source: 'file_source' };   // the first block (File Source) starts fixed in place
  puzzle.selected = null;
  puzzle.tray = shuffle(Object.keys(BLOCKS).filter((id) => id !== 'file_source'));
  state.puzzleSolved = false;
  const hb = $('#hintBox'); if (hb) { hb.classList.add('hidden'); hb.innerHTML = ''; }
  resetBlockInfo();
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
    d.addEventListener('click', () => { const p = puzzle.placement[s.id]; if (p) showBlockInfo(p); onSlotClick(s.id); });
    layer.append(d);
  });
}
function renderTray() {
  const tray = $('#tray'); tray.innerHTML = '';
  if (!puzzle.tray.length) { tray.append(el('div', 'traynote', 'All blocks placed.')); return; }
  puzzle.tray.forEach((id) => {
    const b = BLOCKS[id];
    const chip = el('div', `traychip cat-${b.cat}${puzzle.selected === id ? ' selected' : ''}`);
    chip.innerHTML = `<div class="bp">${b.phase}${b.disabled ? ' / disabled' : ''}</div><div class="bt">${b.title}</div><div class="bs">${b.sub}</div>`;
    chip.addEventListener('click', () => { showBlockInfo(id); puzzle.selected = puzzle.selected === id ? null : id; renderTray(); renderSlots(); });
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
      <span style="color:var(--dim)">/ File Source is bottom-left, Reassembler/Message Debug are top/bottom-right.
      / Waterfall Sink branches off FIR (optional). Select a block in the tray to briefly highlight its correct slot.</span>`;
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
// PHASE 4 - STEP 0 recording upload gate (reveals the analysis once upload completes)
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
// After validating .cf32 (complex float32 IQ), send it to the server so PHASE 6's real GNU Radio uses it as the File Source.
async function handleRecFile(file) {
  const info = $('#ugInfo'); if (!info) return;
  info.classList.remove('hidden', 'ug-err', 'ug-ok');
  info.innerHTML = '⏳ validating file…';
  const name = file.name, size = file.size;
  const okExt = /\.(cf32|iq|raw|c64|dat)$/i.test(name);
  if (size < 4096 || size % 8 !== 0) {
    return ugError(`not complex float32 (IQ) format - size ${fmtBytes(size)} (not a multiple of 8 bytes, or too small). Upload the .cf32 recorded in the Virtual Antenna.`);
  }
  let ok = true, peak = 0;                              // read the beginning as float32 to check it is real IQ
  try {
    const buf = await file.slice(0, 8192).arrayBuffer();
    const f = new Float32Array(buf);
    for (let i = 0; i < f.length; i++) { const v = f[i]; if (!Number.isFinite(v)) { ok = false; break; } const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak === 0 || peak > 1e6) ok = false;   // NaN/Inf already blocked by isFinite above; un-normalized captures are also allowed
  } catch (e) { ok = false; }
  if (!ok) return ugError('Cannot be read as IQ data. Check that it is a .cf32 (complex float32) file recorded in the Virtual Antenna.');
  const samples = size / 8, durAt50k = samples / 50000;
  state.recUploaded = true; state.recFile = { name, size, samples }; state.recFileObj = file;   // keep the File for in-browser analysis
  BLOCKS.file_source.sub = name.length > 26 ? name.slice(0, 25) + '…' : name;   // puzzle's first block + PHASE 6 File Source label
  info.classList.remove('ug-err'); info.classList.add('ug-ok');
  info.innerHTML =
    `✅ <b>${escHtml(name)}</b> uploaded` +
    `<br>size ${fmtBytes(size)} / ${samples.toLocaleString()} IQ samples (complex float32)` +
    (okExt ? '' : ' / <span class="ug-warn">non-standard extension</span>') +
    `<br><span class="ug-sub">≈ ${durAt50k.toFixed(1)}s @ 50 kSps / opening the spectrum + waterfall analysis…</span>` +
    `<br><span id="ugServerLine" class="ug-sub">⏳ uploading to the server for PHASE 6 GNU Radio…</span>`;
  uploadToServer(file, name, 50000).then((r) => {          // stage the File Source for PHASE 6's real GNU Radio
    const el = $('#ugServerLine'); if (!el) return;
    el.textContent = (r && r.ok)
      ? '⬆ registered on the server: used as the File Source in PHASE 6 real GNU Radio'
      : '⚠ server upload failed: analysis continues but the PHASE 6 file source is not updated';
  });
  setTimeout(revealAnalyzeBody, 900);                  // show the summary briefly, then open the analysis
}
async function uploadToServer(file, name, sampleRate) {
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(name) + '&sampleRate=' + (sampleRate || 50000),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}
function revealAnalyzeBody() {
  const gate = $('#captureGate'), body = $('#analyzeBody');
  if (gate) gate.classList.add('hidden');
  if (body) body.classList.remove('hidden');
  const btn = $('#toPuzzle'); if (btn) { btn.disabled = false; btn.textContent = 'Build the demod flowgraph →'; }
  requestAnimationFrame(runAnalysis);   // spectrum + waterfall on the uploaded IQ
}
function syncAnalyzeGate() {
  const gate = $('#captureGate'), body = $('#analyzeBody');
  if (!gate || !body) return;
  gate.classList.toggle('hidden', state.recUploaded);
  body.classList.toggle('hidden', !state.recUploaded);
  const btn = $('#toPuzzle');
  if (btn) { btn.disabled = !state.recUploaded; btn.textContent = (state.recUploaded ? '' : '🔒 ') + 'Build the demod flowgraph →'; }
}
// PHASE 4 one-button: use the capture the VSA saved to the server in PHASE 3 (no file picker).
function wireUseRecording() {
  const btn = $('#useRecordingBtn'), info = $('#ugInfo');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const u = await (await fetch('/api/upload', { cache: 'no-store' })).json();
      if (!u || !u.exists || !u.size) throw new Error('no Phase 3 recording found - record the signal in Phase 3 first');
      state.recUploaded = true; state.recFileObj = null;   // analysis reads the file from the server
      state.recFile = { name: u.name || 'uploaded.cf32', size: u.size, samples: u.samples || Math.floor(u.size / 8) };
      BLOCKS.file_source.sub = u.name || 'uploaded.cf32';
      if (u.sampleRate) AN.fs = u.sampleRate;
      if (info) {
        info.classList.remove('hidden', 'ug-err'); info.classList.add('ug-ok');
        info.innerHTML = `✅ Using the Phase 3 recording (${fmtBytes(u.size)}) / opening the spectrum + waterfall…`;
      }
      setTimeout(revealAnalyzeBody, 700);
    } catch (e) {
      if (info) { info.classList.remove('hidden', 'ug-ok'); info.classList.add('ug-err'); info.textContent = `✗ ${e.message}`; }
      btn.disabled = false;
    }
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 - signal analysis: spectrum (PSD) + waterfall (spectrogram) on the uploaded IQ.
// Pure client-side: read a leading slice of the .cf32 (complex float32 interleaved I,Q),
// run a small radix-2 FFT, render on canvases. Fs comes from the upload metadata.
// ─────────────────────────────────────────────────────────────────────────────
const AN = { fs: 50000, ran: false, highlight: false, psd: null, spec: null, m: null, fcMHz: 433.5, devK: 2.4 };
// The 3 signal parameters the visitor reads off the plots (all answerable from the image).
const CORRECT = {
  pFc: { type: 'num', v: 433.5, tol: 0.05 },   // carrier peak on the absolute MHz axis
  pMod: { type: 'text', re: /^g?fsk$/i },       // two separate tones -> FSK / GFSK
  pBw: { type: 'num', v: null, tol: 3 },        // v is set from the measured bandwidth at analysis time
};

// In-place iterative radix-2 FFT (Cooley-Tukey). re/im length must be a power of two.
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const a = i + k, b = a + (len >> 1);
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function hann(N) { const w = new Float32Array(N); for (let k = 0; k < N; k++) w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)); return w; }
function fftShift(idx, N) { return (idx + (N >> 1)) % N; }   // output index -> source bin, so DC sits at center

// Read up to ~8 MB of the uploaded IQ. Prefer the in-memory File; fall back to the server
// (Range request) after a page reload where the File object is gone.
async function readIQBytes() {
  const MAXB = 8 * 1024 * 1024;
  if (state.recFileObj) {
    const n = Math.min(state.recFileObj.size, MAXB) & ~7;   // whole complex samples (8 bytes each)
    const buf = await state.recFileObj.slice(0, n).arrayBuffer();
    return new Float32Array(buf);
  }
  try {
    const r = await fetch('/api/uploaded-iq', { headers: { Range: 'bytes=0-' + (MAXB - 1) }, cache: 'no-store' });
    if (!r.ok && r.status !== 206) return null;
    const buf = await r.arrayBuffer();
    return new Float32Array(buf.slice(0, buf.byteLength & ~7));
  } catch (e) { return null; }
}
// Averaged periodogram (non-overlapping Hann windows), fftshifted, in dB.
function computePSD(iq, N) {
  const win = hann(N), re = new Float32Array(N), im = new Float32Array(N), acc = new Float64Array(N);
  const total = iq.length >> 1, hops = Math.max(1, Math.min(64, Math.floor(total / N)));
  for (let h = 0; h < hops; h++) {
    const base = h * N * 2;
    for (let k = 0; k < N; k++) { const w = win[k]; re[k] = (iq[base + 2 * k] || 0) * w; im[k] = (iq[base + 2 * k + 1] || 0) * w; }
    fftRadix2(re, im);
    for (let k = 0; k < N; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) out[k] = 10 * Math.log10(acc[fftShift(k, N)] / hops + 1e-12);
  return out;
}
// Spectrogram: successive Hann-windowed FFT rows spread across the read window.
function computeSpectrogram(iq, N, rows) {
  const win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
  const total = iq.length >> 1, hop = Math.max(1, Math.floor((total - N) / rows)), spec = [];
  for (let r = 0; r < rows; r++) {
    const base = r * hop * 2;
    for (let k = 0; k < N; k++) { const w = win[k]; re[k] = (iq[base + 2 * k] || 0) * w; im[k] = (iq[base + 2 * k + 1] || 0) * w; }
    fftRadix2(re, im);
    const row = new Float32Array(N);
    for (let k = 0; k < N; k++) { const s = fftShift(k, N); row[k] = 10 * Math.log10(re[s] * re[s] + im[s] * im[s] + 1e-12); }
    spec.push(row);
  }
  return spec;
}
function measurePSD(psd, fs) {
  const N = psd.length, binHz = fs / N;
  let peak = -Infinity, peakIdx = N >> 1;
  for (let k = 0; k < N; k++) { if (Math.abs(k - (N >> 1)) < 2) continue; if (psd[k] > peak) { peak = psd[k]; peakIdx = k; } }
  const noise = Float32Array.from(psd).sort()[N >> 1];   // median as the noise floor
  const thr = noise + (peak - noise) * 0.30;             // occupied-band edge threshold
  let lo = peakIdx, hi = peakIdx;
  while (lo > 0 && psd[lo] > thr) lo--;
  while (hi < N - 1 && psd[hi] > thr) hi++;
  return { centerHz: (peakIdx - (N >> 1)) * binHz, bwHz: (hi - lo) * binHz, peakDb: peak, noiseDb: noise, loIdx: lo, hiIdx: hi, peakIdx };
}
function setupCanvas(cv, hFallback) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || hFallback;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
// Draw a label with a dark backing box so text never blends into the plot or other labels.
function anTextBg(ctx, txt, x, y, color, font, align) {
  ctx.font = font; ctx.textAlign = align || 'center'; ctx.textBaseline = 'alphabetic';
  const wpx = ctx.measureText(txt).width, p = 5;
  let bx = x - wpx / 2 - p;
  if (align === 'left') bx = x - p; else if (align === 'right') bx = x - wpx - p;
  ctx.fillStyle = 'rgba(7,13,21,.72)'; ctx.fillRect(bx, y - 13, wpx + p * 2, 18);
  ctx.fillStyle = color; ctx.fillText(txt, x, y);
}
function drawSpectrum(cv, psd, fs, m) {
  if (!cv) return;
  const hi = AN.highlight;
  const { ctx, w, h } = setupCanvas(cv, 300);
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#070d15'; ctx.fillRect(0, 0, w, h);
  const N = psd.length, padL = 12, padR = 12, padTop = 42, padBot = 34;
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < N; k++) { if (psd[k] < mn) mn = psd[k]; if (psd[k] > mx) mx = psd[k]; }
  const range = Math.max(1, mx - mn);
  const X = (k) => padL + (k / (N - 1)) * (w - padL - padR);
  const Y = (db) => (h - padBot) - ((db - mn) / range) * (h - padBot - padTop);
  const fcMHz = AN.fcMHz || 433.5, devK = AN.devK || 0, half = fs / 2e6, axisY = h - padBot, TICKS = 5;
  ctx.textBaseline = 'alphabetic';
  // ── reference gridlines (center stronger) + frequency scale: ticks + MHz labels (always shown) ──
  for (let i = 0; i < TICKS; i++) {
    const gx = padL + (w - padL - padR) * i / (TICKS - 1), mid = i === (TICKS - 1) / 2;
    ctx.strokeStyle = mid ? 'rgba(255,176,32,.5)' : '#1b2836'; ctx.lineWidth = 1; ctx.setLineDash(mid ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(gx, padTop); ctx.lineTo(gx, axisY); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#2a3a4d'; ctx.beginPath(); ctx.moveTo(gx, axisY); ctx.lineTo(gx, axisY + 5); ctx.stroke();
    const mhz = fcMHz - half + 2 * half * i / (TICKS - 1);
    anTextBg(ctx, mhz.toFixed(3), Math.min(w - 26, Math.max(26, gx)), axisY + 18, '#8194a8', '12px ui-monospace,monospace');
  }
  anTextBg(ctx, 'MHz', w - padR, axisY + 18, '#5b6b7d', '11px ui-monospace,monospace', 'right');
  ctx.strokeStyle = '#2a3a4d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, axisY); ctx.lineTo(w - padR, axisY); ctx.stroke();
  // PSD fill + trace
  ctx.beginPath(); ctx.moveTo(X(0), axisY);
  for (let k = 0; k < N; k++) ctx.lineTo(X(k), Y(psd[k]));
  ctx.lineTo(X(N - 1), axisY); ctx.closePath();
  const grd = ctx.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, 'rgba(57,197,255,.35)'); grd.addColorStop(1, 'rgba(57,197,255,.02)');
  ctx.fillStyle = grd; ctx.fill();
  ctx.strokeStyle = '#39c5ff'; ctx.lineWidth = 1.6; ctx.beginPath();
  for (let k = 0; k < N; k++) { const x = X(k), y = Y(psd[k]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  // ── reference lines: ALWAYS shown (neutral) so an expert reads the values off the MHz scale without the hint ──
  const px = X(m.peakIdx), py = Y(psd[m.peakIdx]), bwK = m.bwHz / 1000, bx0 = X(m.loIdx), bx1 = X(m.hiIdx);
  ctx.strokeStyle = hi ? 'rgba(92,242,154,.95)' : 'rgba(120,150,180,.6)'; ctx.lineWidth = hi ? 1.8 : 1.2; ctx.setLineDash([5, 4]);
  [bx0, bx1].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, axisY); ctx.stroke(); });   // band edges -> bandwidth
  ctx.setLineDash([]);
  // edge-frequency readout on the scale (so the bandwidth is readable off the axis even without the hint)
  const loF = fcMHz + (m.loIdx - (N >> 1)) * (fs / N) / 1e6, hiF = fcMHz + (m.hiIdx - (N >> 1)) * (fs / N) / 1e6, ec = hi ? '#8affc0' : '#a7d8bd';
  ctx.strokeStyle = ec; ctx.lineWidth = 1.8;
  [bx0, bx1].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + 7); ctx.stroke(); });
  anTextBg(ctx, loF.toFixed(3), Math.max(26, Math.min(w - 26, bx0)), axisY - 7, ec, 'bold 12px ui-monospace,monospace');
  anTextBg(ctx, hiF.toFixed(3), Math.max(26, Math.min(w - 26, bx1)), axisY - 7, ec, 'bold 12px ui-monospace,monospace');
  if (devK > 0) {
    const devBins = (devK * 1000) / (fs / N), lx = X(m.peakIdx - devBins), rx = X(m.peakIdx + devBins);
    ctx.strokeStyle = hi ? 'rgba(160,148,255,1)' : 'rgba(150,140,210,.5)'; ctx.lineWidth = hi ? 2.2 : 1.1; ctx.setLineDash([3, 3]);
    [lx, rx].forEach((x) => { if (x > padL && x < w - padR) { ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, axisY); ctx.stroke(); } });   // two tones -> modulation
    ctx.setLineDash([]);
  }
  // ── labels, arrow span, emphasis: ONLY when Hint is pressed ──
  if (hi) {
    const byL = 34;
    ctx.fillStyle = 'rgba(51,209,122,.12)'; ctx.fillRect(bx0, padTop, Math.max(1, bx1 - bx0), axisY - padTop);
    ctx.strokeStyle = '#5cf29a'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(bx0, byL); ctx.lineTo(bx1, byL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx0 + 6, byL - 4); ctx.lineTo(bx0, byL); ctx.lineTo(bx0 + 6, byL + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx1 - 6, byL - 4); ctx.lineTo(bx1, byL); ctx.lineTo(bx1 - 6, byL + 4); ctx.stroke();
    anTextBg(ctx, 'bandwidth ~' + bwK.toFixed(0) + ' kHz', (bx0 + bx1) / 2, 20, '#8affc0', 'bold 15px ui-monospace,monospace');
    ctx.fillStyle = '#33d17a'; ctx.beginPath(); ctx.arc(px, py, 5.5, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#33d17a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 10, 0, 6.3); ctx.stroke();
    anTextBg(ctx, 'carrier ~' + fcMHz.toFixed(3) + ' MHz', px, Math.max(py - 12, padTop + 16), '#eaf2fb', 'bold 14px ui-monospace,monospace');
    if (devK > 0) anTextBg(ctx, '2 tones = FSK', px, (padTop + axisY) / 2, '#c9c2ff', 'bold 14px ui-monospace,monospace');
  }
}
function anColor(t) {   // dark navy -> cyan -> white intensity ramp (matches the UI accent)
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (t < 0.5) { const u = t * 2; return [0, Math.round(u * 190), Math.round(50 + u * 190)]; }
  const u = (t - 0.5) * 2; return [Math.round(u * 255), Math.round(190 + u * 65), 240];
}
function drawWaterfall(cv, spec, m, fs) {
  if (!cv || !spec.length) return;
  const hi = AN.highlight;
  const { ctx, w, h } = setupCanvas(cv, 320);
  const rows = spec.length, N = spec[0].length;
  let mn = Infinity, mx = -Infinity;
  for (let r = 0; r < rows; r++) { const row = spec[r]; for (let k = 0; k < N; k++) { const v = row[k]; if (v < mn) mn = v; if (v > mx) mx = v; } }
  const range = Math.max(1, mx - mn), iw = Math.min(N, 512);
  const img = ctx.createImageData(iw, rows);
  for (let r = 0; r < rows; r++) {
    const row = spec[r];
    for (let x = 0; x < iw; x++) {
      const k = (x * N / iw) | 0, c = anColor((row[k] - mn) / range), o = (r * iw + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas'); tmp.width = iw; tmp.height = rows;
  tmp.getContext('2d').putImageData(img, 0, 0);
  const padBot = 34, imgH = h - padBot;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#070d15'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, w, imgH);
  const fcMHz = AN.fcMHz || 433.5, devK = AN.devK || 0, half = fs / 2e6, axisY = imgH, TICKS = 5, toX = (b) => (b / N) * w;
  ctx.textBaseline = 'alphabetic';
  // ── reference gridlines over the image + frequency scale (ticks + MHz) below (always shown) ──
  for (let i = 0; i < TICKS; i++) {
    const gx = (w - 1) * i / (TICKS - 1), mid = i === (TICKS - 1) / 2;
    ctx.strokeStyle = mid ? 'rgba(255,176,32,.5)' : 'rgba(150,170,200,.22)'; ctx.lineWidth = 1; ctx.setLineDash(mid ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, axisY); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#2a3a4d'; ctx.beginPath(); ctx.moveTo(gx, axisY); ctx.lineTo(gx, axisY + 5); ctx.stroke();
    const mhz = fcMHz - half + 2 * half * i / (TICKS - 1);
    anTextBg(ctx, mhz.toFixed(3), Math.min(w - 26, Math.max(26, gx)), axisY + 18, '#8194a8', '12px ui-monospace,monospace');
  }
  anTextBg(ctx, 'MHz', w - 4, axisY + 18, '#5b6b7d', '11px ui-monospace,monospace', 'right');
  anTextBg(ctx, 'time (top to bottom)', 12, 18, '#a9bacd', '13px ui-monospace,monospace', 'left');
  // ── reference lines: ALWAYS shown (neutral) so an expert reads the values off the MHz scale without the hint ──
  if (m) {
    const bx0 = toX(m.loIdx), bx1 = toX(m.hiIdx);
    ctx.strokeStyle = hi ? 'rgba(92,242,154,.95)' : 'rgba(150,180,210,.55)'; ctx.lineWidth = hi ? 1.8 : 1.2; ctx.setLineDash([5, 4]);
    [bx0, bx1].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, axisY); ctx.stroke(); });   // band edges -> bandwidth
    ctx.setLineDash([]);
    // edge-frequency readout on the scale (bandwidth readable off the axis even without the hint)
    const loF = fcMHz + (m.loIdx - (N >> 1)) * (fs / N) / 1e6, hiF = fcMHz + (m.hiIdx - (N >> 1)) * (fs / N) / 1e6, ec = hi ? '#8affc0' : '#a7d8bd';
    ctx.strokeStyle = ec; ctx.lineWidth = 1.8;
    [bx0, bx1].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + 7); ctx.stroke(); });
    anTextBg(ctx, loF.toFixed(3), Math.max(26, Math.min(w - 26, bx0)), axisY - 7, ec, 'bold 12px ui-monospace,monospace');
    anTextBg(ctx, hiF.toFixed(3), Math.max(26, Math.min(w - 26, bx1)), axisY - 7, ec, 'bold 12px ui-monospace,monospace');
    if (devK > 0) {
      const devBins = (devK * 1000) / (fs / N), lx = toX(m.peakIdx - devBins), rx = toX(m.peakIdx + devBins);
      ctx.strokeStyle = hi ? 'rgba(160,148,255,1)' : 'rgba(170,160,220,.5)'; ctx.lineWidth = hi ? 2.2 : 1.1; ctx.setLineDash([4, 3]);
      [lx, rx].forEach((x) => { if (x > 0 && x < w) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, axisY); ctx.stroke(); } });   // two tones -> modulation
      ctx.setLineDash([]);
    }
  }
  // ── labels, arrow span, emphasis: ONLY when Hint is pressed ──
  if (hi && m) {
    const cxp = toX(m.peakIdx), bx0 = toX(m.loIdx), bx1 = toX(m.hiIdx);
    ctx.strokeStyle = '#5cf29a'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(bx0, 40); ctx.lineTo(bx1, 40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx0 + 6, 36); ctx.lineTo(bx0, 40); ctx.lineTo(bx0 + 6, 44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx1 - 6, 36); ctx.lineTo(bx1, 40); ctx.lineTo(bx1 - 6, 44); ctx.stroke();
    anTextBg(ctx, 'bandwidth ~' + (m.bwHz / 1000).toFixed(0) + ' kHz', (bx0 + bx1) / 2, 32, '#8affc0', 'bold 14px ui-monospace,monospace');
    if (devK > 0) anTextBg(ctx, 'two frequencies = FSK', cxp, axisY - 8, '#c9c2ff', 'bold 14px ui-monospace,monospace');
    anTextBg(ctx, 'carrier ~' + fcMHz.toFixed(3) + ' MHz', cxp, imgH * 0.5, '#eaf2fb', 'bold 13px ui-monospace,monospace');
  }
}
function mountAnalyze() {
  syncAnalyzeGate();
  if (state.recUploaded && !AN.ran) runAnalysis();
}
async function runAnalysis() {
  const meas = $('#anMeas');
  if (meas) meas.textContent = 'analyzing…';
  try { const u = await (await fetch('/api/upload')).json(); if (u && u.sampleRate) AN.fs = u.sampleRate; } catch (e) {}
  const N = 1024;
  const iq = await readIQBytes();
  if (!iq || iq.length < N * 2) { if (meas) meas.textContent = 'no IQ to analyze (re-upload the .cf32)'; return; }
  AN.psd = computePSD(iq, N);
  AN.spec = computeSpectrogram(iq, N, 180);
  AN.m = measurePSD(AN.psd, AN.fs);
  const ex = getExpected();
  AN.fcMHz = ex.fcMHz; AN.devK = ex.devK;          // absolute center frequency + tone spacing for the plot labels
  CORRECT.pBw.v = Math.round(AN.m.bwHz / 1000);     // bandwidth answer = the width the plot actually shows
  redrawAnalysis();
  if (meas) meas.textContent = 'read off the MHz scale + reference lines: peak, band edges, two tones (Hint labels them)';
  AN.ran = true;
}
function redrawAnalysis() {
  if (!AN.psd) return;
  drawSpectrum($('#anSpectrum'), AN.psd, AN.fs, AN.m);
  drawWaterfall($('#anWaterfall'), AN.spec, AN.m, AN.fs);
}
// Expected ENIGMA-1 parameters, pulled from the satellite dossier (with fallbacks).
function getExpected() {
  const rf = (state.sat && state.sat.rf) || {};
  const num = (s, re, d) => { const mm = String(s == null ? '' : s).match(re); return mm ? parseFloat(mm[1]) : d; };
  return {
    fsK: (AN.fs / 1000) || 96,
    fcMHz: num(rf['Downlink freq'], /([\d.]+)/, 433.5),
    baud: num(rf['Symbol rate'], /([\d.]+)/, 9600),
    devK: num(rf['Deviation'], /([\d.]+)\s*kHz/, 2.4),
    mod: (String(rf['Modulation'] || 'GFSK').split(/[ ,]/)[0]) || 'GFSK',
  };
}
function validateOne(id) {
  const e = $('#' + id); if (!e) return;
  e.classList.remove('ok', 'err');
  const t = e.value.trim(); if (t === '') return;
  const c = CORRECT[id]; if (!c) return;
  let ok = false;
  if (c.type === 'text') ok = c.re.test(t);
  else { const v = parseFloat(t); ok = (c.v != null) && Number.isFinite(v) && Math.abs(v - c.v) <= c.tol; }
  e.classList.add(ok ? 'ok' : 'err');
}
function validateAllParams() { ['pFc', 'pMod', 'pBw'].forEach(validateOne); }
// Hint: highlight the plots and explain HOW to read each value. It does NOT fill the answer boxes.
function showAnalyzeHint() {
  const hb = $('#anHintBox');
  if (hb) {
    hb.classList.remove('hidden');
    hb.innerHTML = `<b>How to read each value off the plots</b>` +
      `<br>- <b>Center frequency</b>: where the green carrier peak sits on the spectrum's MHz axis.` +
      `<br>- <b>Bandwidth</b>: the width of the green shaded band, measured against the same axis.` +
      `<br>- <b>Modulation</b>: the signal is two separate frequencies (the purple tones) = frequency-shift keying, FSK.` +
      `<br><span style="color:var(--dim)">Type your readings into the 3 boxes: green = correct, red = wrong.</span>`;
  }
  AN.highlight = true; redrawAnalysis();   // emphasize + reveal the callouts on the plots; the answer boxes stay for the user
}
function wireAnalyzeControls() {
  const hint = $('#anHint'); if (hint) hint.addEventListener('click', showAnalyzeHint);
  ['pFc', 'pMod', 'pBw'].forEach((id) => {
    const e = $('#' + id); if (!e) return;
    ['input', 'change'].forEach((ev) => e.addEventListener(ev, () => validateOne(id)));   // number inputs fire 'input', the select fires 'change'
  });
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
// PHASE 5 - signal-flow preview (each stage's signal comes alive as you place blocks)
// A stage only activates and animates once the chain up to that point is filled in correctly.
// ─────────────────────────────────────────────────────────────────────────────
const SIGFLOW = [
  { key: 'iq',     label: 'RAW IQ',    sub: 'IQ + noise',        need: ['file_source'] },
  { key: 'filter', label: 'FILTER',    sub: 'narrowband / Doppler', need: ['file_source', 'throttle', 'fir'] },
  { key: 'demod',  label: 'FSK DEMOD', sub: 'mark / space',      need: ['file_source', 'throttle', 'fir', 'fsk'] },
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
  } else if (key === 'filter') {                        // before filter (wideband / noisy / offset) ▸ after (narrowband / aligned / low-noise)
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
// PHASE 6 - GNU Radio (real noVNC embed) or rendered solution
// ─────────────────────────────────────────────────────────────────────────────
const VARS = [['samp_rate', '96k'], ['baud_rate', '9.6k'], ['deviation', '2.4k'], ['freq_offset', '0']];
let flowgraphMounted = false;
// If a file was uploaded in PHASE 4, refresh the PHASE 6 display (samp_rate chip / File Source hint / restart notice).
function applyUploadedToFlowgraph() {
  fetch('/api/upload').then((r) => r.json()).then((u) => {
    if (!u || !u.exists) return;
    const rateK = (u.sampleRate / 1000);
    const b = $('#varsRow .varchip[data-key="samp_rate"] b'); if (b) b.textContent = rateK + 'k';   // samp_rate chip
    const hint = $('#gnuFileHint'); if (hint) hint.textContent = `File Source: ${u.name} (uploaded) / samp_rate ${rateK}k → ▶ Run`;
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
    card.append(el('h3', null, 'GNU RADIO COMPANION / ▶ Run to recover the image'), f);
    // GNU Radio (inside the container) takes ~10-15s to bring up the QT waterfall window. Show a
    // "starting…" overlay so the participant does not think it is stuck. noVNC's iframe 'load' fires
    // early (when vnc.html loads, before the session is visible), so keep a hard backstop timer too.
    const wait = el('div', 'gnu-wait');
    wait.innerHTML = '<div class="reset-spinner"></div>' +
      '<div class="gnu-wait-title">GNU Radio waterfall is starting…</div>' +
      '<div class="gnu-wait-sub">The live spectrum window takes about <b>10-15s</b> to appear. This is normal, please wait.</div>';
    card.append(wait);
    const clearWait = () => { if (wait && wait.parentElement) wait.remove(); };
    f.addEventListener('load', () => setTimeout(clearWait, 6000));
    setTimeout(clearWait, 15000);
    slot.append(card);
  } else {
    const card = el('div', 'fgcard'); card.innerHTML = '<h3>ENIGMA-1 DECODER / SOLVED FLOWGRAPH</h3>';
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
// PHASE 6 - live image reassembly (▶ run decode → recover the image frame by frame)
// If real GNU Radio output (gnuradio-out/*.png) exists, use it; otherwise demo with the reference image.
// ─────────────────────────────────────────────────────────────────────────────
const reasImg = new Image();
reasImg.src = '/assets/result.png';
const reas = { running: false, done: false, frac: 0, rows: 128, reps: 0, everDone: false, maxFrac: 0, liveStart: 0, poll: null, real: false, baselineMtime: 0 };
let reasWired = false;
let reasBlank = true;   // true = show the "waiting" panel instead of a stale image, until a fresh decode loads

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
  // Start from a clean slate: blank the panel + progress so the previous run's image is not shown
  // while the new input decodes (avoids the "already recovered on entry" feeling).
  reasBlank = true;
  const fill0 = $('#reasFill'); if (fill0) fill0.style.width = '0%';
  const fr0 = $('#reasFrame'); if (fr0) fr0.textContent = 'waiting for the new decode…';
  drawReassemble();
  // Snapshot the newest decode output present RIGHT NOW, then ignore anything at or before it: only a
  // decode whose progress file is (re)written AFTER this moment counts as live. This is what stops a
  // previous participant's leftover gnuradio-out image from popping up the instant we enter the phase.
  reas.baselineMtime = 0;
  try {
    const p0 = await (await fetch('/api/decode-progress', { cache: 'no-store' })).json();
    if (p0 && p0.exists) reas.baselineMtime = p0.mtime || 0;
  } catch (e) {}
  const t0 = performance.now(); let sawLive = false;
  reas.poll = setInterval(async () => {
    if (state.phase !== 'flowgraph') { stopDecode(); return; }
    let live = false, done = false, frac = 0;
    try {
      const p = await (await fetch('/api/decode-progress', { cache: 'no-store' })).json();
      // Only a decode whose progress file was (re)written AFTER we entered (mtime past the entry
      // baseline) counts as live. A stale leftover from a previous run has mtime == baseline -> ignored.
      if (p && p.exists && (p.mtime || 0) > reas.baselineMtime) {
        live = true; sawLive = true; frac = Math.min(1, p.fraction || 0); done = !!p.done; reas.rows = 128; reas.reps = p.reps || 0; if (!reas.liveStart) reas.liveStart = performance.now();
      }
    } catch (e) {}
    if (live) {                                   // follow the real progressive image
      reas.real = true;
      await loadReasImage('/decoded.png?t=' + Date.now());
      reasBlank = false;                           // a fresh decode has arrived -> show it
      reas.frac = frac; reas.done = done && frac >= 0.99;
      if (reas.done) reas.everDone = true;
      if (frac > reas.maxFrac) reas.maxFrac = frac;
    } else if (!sawLive && !state.cfg.gnuradioUrl) {   // no real GNU Radio configured: brief reference-image demo (with real GNU Radio we stay blank until it actually decodes)
      if (!reas.real) { await loadReasImage('/assets/result.png'); reasBlank = false; reas.frac = Math.min(1, (performance.now() - t0) / 6000); reas.done = reas.frac >= 1; }
    }
    drawReassemble();
    const fill = $('#reasFill'); if (fill) fill.style.width = Math.round(reas.frac * 100) + '%';
    const fr = $('#reasFrame'); if (fr) fr.textContent = reas.real ? `recovered ${Math.round(reas.frac * 100)}% / pass ${(reas.reps || 0) + 1}` : (reasBlank ? 'waiting for the decode (▶ Run in GNU Radio)…' : `recovered ${Math.round(reas.frac * 100)}%`);
    const badge = $('#reasBadge');
    const failing = reas.real && !reas.everDone && reas.liveStart && (performance.now() - reas.liveStart > 30000);   // demodulating for over 30s without ever completing = recovery failure (center-frequency offset, etc.)
    if (badge) {
      badge.classList.toggle('reas-fail', failing);
      if (failing) { badge.classList.remove('hidden'); badge.textContent = `⚠ recovery failed: center-frequency offset (after ${(reas.reps || 0) + 1} repeated passes, stuck at max ${Math.round(reas.maxFrac * 100)}%)`; }
      else if (reas.done) { badge.classList.remove('hidden'); badge.textContent = reas.real ? `✅ recovered / pass ${(reas.reps || 0) + 1} (still receiving)` : '✅ recovered'; }
      else badge.classList.add('hidden');
    }
    // Continuous display: keep polling while on PHASE 6 to refresh live (shows repeated demodulation passes in sequence).
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
  if (reasBlank || !reasImg.complete || !reasImg.naturalWidth) { reasNoise(ctx, 8, 8, w - 16, h - 16, 0.5); return; }
  const iw = reasImg.naturalWidth, ih = reasImg.naturalHeight;
  const sc = Math.min((w - 16) / iw, (h - 16) / ih), dw = iw * sc, dh = ih * sc, dx = (w - dw) / 2, dy = (h - dh) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.strokeStyle = '#1e2b3a'; ctx.lineWidth = 1; ctx.strokeRect(dx - 1, dy - 1, dw + 2, dh + 2);
  if (!reas.running && !reas.done) { reasNoise(ctx, dx, dy, dw, dh, 0.55); return; }   // before start: noise
  ctx.drawImage(reasImg, dx, dy, dw, dh);   // draw the full image as-is on one screen (no row split or partial reveal; the real decode fills top to bottom)
}

// Full reset for the next participant: recreate gpredict + GNU Radio, clear the recorded signal
// and recovered image on the server, then reload the page (resets the browser / VSA state too).
// Full booth reset for the next participant: recreate gpredict + GNU Radio, clear the recorded
// signal and recovered image on the server, then reload the page. Shared by the topbar "Reset for
// next participant" button and the result-page "Restart ↺" button so both give a clean slate.
async function doFullReset() {
  if (!confirm('Reset the whole demo (gpredict, Virtual Antenna, GNU Radio, and this page) to the initial state for the next participant?')) return;
  const ov = $('#resetOverlay'); if (ov) ov.classList.remove('hidden');
  // Clear the client-side upload / Analyze / Puzzle state immediately so the recording and its
  // file-source labels disappear at once, instead of only after the deferred reload (which can lag
  // 28-80s while gpredict recreates). This is what made Reset feel like it "did nothing".
  state.recUploaded = false; state.recFile = null; state.recFileObj = null;
  AN.ran = false; AN.highlight = false; AN.psd = null; AN.spec = null; AN.m = null;
  if (BLOCKS && BLOCKS.file_source) BLOCKS.file_source.sub = 'enigma34_downlink.cf32';
  { const ui = $('#ugInfo'); if (ui) { ui.classList.add('hidden'); ui.classList.remove('ug-ok', 'ug-err'); ui.innerHTML = ''; } }
  { const uf = $('#ugFile'); if (uf) uf.value = ''; }
  if (typeof syncAnalyzeGate === 'function') syncAnalyzeGate();
  try { await fetch('/api/reset-all'); } catch (e) { /* fire-and-forget: the poll below waits for the fresh state */ }
  // Reload ONLY once the recreated gpredict is back AND fully clean - engaged AND tracking both off -
  // otherwise the reloaded page re-colours the Track/Apply/Doppler buttons from stale gpredict state.
  const cd = $('#resetCountdown');
  const minReload = Date.now() + 28000;   // give the container recreates time to finish
  const deadline  = Date.now() + 80000;   // hard cap
  const tick = async () => {
    if (cd) cd.textContent = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    let clean = false;
    try {
      const st = await (await fetch('/api/gpredict-status', { cache: 'no-store' })).json();
      clean = st && st.ok && st.bridgeUp && !st.radioEngaged && !st.rotorEngaged
              && !st.radioTracking && !st.rotorTracking;
    } catch (e) { /* control server still coming up */ }
    if ((clean && Date.now() > minReload) || Date.now() > deadline) { location.reload(); return; }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 6000);
}
function wireResetAll() {
  const btn = $('#resetAllBtn'); if (btn) btn.addEventListener('click', doFullReset);
}

// ── boot ──
async function boot() {
  buildStepper(); wireNav(); wirePuzzle(); initPuzzle(); wireUploadGate(); wireUseRecording(); wireAnalyzeControls(); wireResetAll();
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
  // Re-derive the upload state from the server so any reload (Reset-triggered or manual) starts
  // consistent: never leave a stale recUploaded=true, and reflect a still-present server file as true.
  try {
    const u = await fetch('/api/upload', { cache: 'no-store' }).then((r) => r.json());
    state.recUploaded = !!(u && u.exists);
    if (u && u.exists) {
      state.recFile = { name: u.name || 'uploaded.cf32', size: u.size, samples: u.samples || Math.floor((u.size || 0) / 8) };
      if (BLOCKS && BLOCKS.file_source) BLOCKS.file_source.sub = u.name || 'uploaded.cf32';
    }
  } catch (e) { state.recUploaded = false; }
  show('mission');
}
boot();
