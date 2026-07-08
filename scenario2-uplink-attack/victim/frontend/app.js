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
  if (hist.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (HIST - 1)) * W;
    const y = H - pad - (Math.max(0, Math.min(max, v)) / max) * (H - 2 * pad);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.globalAlpha = 0.12; ctx.lineTo((hist.length - 1) / (HIST - 1) * W, H); ctx.lineTo(0, H);
  ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
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

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
connect();
