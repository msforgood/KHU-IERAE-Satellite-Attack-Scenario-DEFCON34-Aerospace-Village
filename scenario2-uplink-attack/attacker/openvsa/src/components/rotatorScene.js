// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

import { createSceneRenderer, boxPart } from "../lib/simple3d.js";
import { SATELLITES }         from "../data/satellites.js";
import { AMPLIFIERS }         from "../data/amplifiers.js";
import { createSatelliteState } from "../lib/satellite-state.js";

export function createRotatorScene({ container, store, antennaTypes }) {
  container.innerHTML = `
    <div class="scene-stage">
      <canvas
        class="scene-canvas"
        aria-label="3D antenna rotator visualisation"
      ></canvas>
      <div class="waterfall-overlay">
        <div class="waterfall-label">
          Spectrogram display
        </div>
        <canvas id="spectrum-canvas"></canvas>
        <canvas id="waterfall-canvas"></canvas>
      </div>
      <div id="sat-status-panel" class="sat-status-panel" style="display:none">
        <div id="sat-status-loading" class="sat-status-loading" style="display:none">
          <div class="sat-loading-skull">&#x2620;</div>
          <div class="sat-loading-spinner"></div>
          <div class="sat-loading-text">Intercepting ground station telemetry...</div>
          <div class="sat-loading-sub">Establishing covert link</div>
        </div>
        <div id="gs-operator-overlay" class="gs-operator-overlay" style="display:none">
          <div class="gs-operator-icon">&#x1F6A8;</div>
          <div class="gs-operator-title">CONNECTION TERMINATED</div>
          <div class="gs-operator-msg">Unauthorized access detected and logged.<br>Your rogue uplink session has been disconnected.</div>
          <div class="gs-operator-from">— Ground Station Operator</div>
          <div id="gs-operator-flag" class="gs-operator-flag"></div>
          <button id="btn-gs-reconnect" class="btn-gs-reconnect">Reconnect</button>
        </div>
        <div class="sat-status-title-row">
          <span class="sat-status-title">SATELLITE STATUS — <span id="sat-status-name">—</span></span>
          <button id="btn-refresh-status" class="btn-refresh-status" title="Refresh telemetry">↺</button>
        </div>
        <div id="sat-panel-body"></div>
        <p id="sat-panel-msg" class="sat-panel-msg"></p>
      </div>
      <div class="gpredict-overlay">
        <div class="status-row">
          <div class="status-dot" id="dot-bridge"></div>
          <span id="lbl-bridge">Internal Bridge: disconnected</span>
        </div>
        <div class="status-row">
          <div class="status-dot" id="dot-gpredict"></div>
          <span id="lbl-gpredict">GPredict Tracker: disconnected</span>
        </div>
        <div class="status-row">
          <div class="status-dot" id="dot-radio"></div>
          <span id="lbl-radio">GPredict Radio: disconnected</span>
        </div>
      </div>
      <div class="scene-info-overlay">
        <div class="scene-time-row">
          <span id="scene-lbl-time">--:--:-- UTC</span>
        </div>
        <div class="scene-loc-row">
          <input type="number" id="scene-ctrl-lat" class="scene-loc-input" step="0.0001" min="-90"  max="90"  readonly /><span class="scene-loc-sep" id="scene-lbl-lat-dir">N</span>
          <span class="scene-loc-divider">/</span>
          <input type="number" id="scene-ctrl-lon" class="scene-loc-input" step="0.0001" min="-180" max="180" readonly /><span class="scene-loc-sep" id="scene-lbl-lon-dir">E</span>
        </div>
        <div class="scene-loc-refresh-row">

        </div>
        <div class="antenna-spec-overlay">
          <p class="antenna-spec-name" id="spec-name"></p>
          <p class="antenna-spec-desc" id="spec-desc"></p>
          <table class="antenna-spec-table">
            <tr><td>Beamwidth</td><td id="spec-beamwidth"></td></tr>
            <tr><td>Peak Gain</td><td id="spec-gain"></td></tr>
            <tr><td>Polarization</td><td id="spec-polarization"></td></tr>
          </table>
        </div>
        <div class="sdr-spec-box">
          <p class="sdr-spec-title">Virtual SDR</p>
          <table class="antenna-spec-table">
            <tr><td>Frequency</td><td>1 MHz – 6 GHz</td></tr>
            <tr><td>Max Bandwidth</td><td>20 MHz</td></tr>
            <tr><td>Gain</td><td>0 – 50 dB</td></tr>
          </table>
        </div>
        <div class="sdr-spec-box" id="amp-spec-box" style="display:none">
          <p class="sdr-spec-title amp-spec-title">Power Amplifier</p>
          <table class="antenna-spec-table">
            <tr><td>Model</td><td id="amp-spec-name">—</td></tr>
            <tr><td>Freq Range</td><td id="amp-spec-freq">—</td></tr>
            <tr><td>TX Power</td><td id="amp-spec-power">—</td></tr>
          </table>
        </div>
      </div>
    </div>
    <div class="scene-readout">
      <div class="readout-card">
        <span>Antenna</span>
        <strong id="ro-antenna"></strong>
        <p class="readout-note">Mounted payload</p>
      </div>
      <div class="readout-card">
        <span>Azimuth</span>
        <strong id="ro-az"></strong>
        <p class="readout-note">Base rotation</p>
      </div>
      <div class="readout-card">
        <span>Elevation</span>
        <strong id="ro-el"></strong>
        <p class="readout-note">Upward angle</p>
      </div>
    </div>
  `;

  const canvas       = container.querySelector(".scene-canvas");
  const stage        = container.querySelector(".scene-stage");
  const renderer     = createSceneRenderer({ canvas });
  const roAntenna    = container.querySelector("#ro-antenna");
  const roAz         = container.querySelector("#ro-az");
  const roEl         = container.querySelector("#ro-el");
  const lblSceneTime  = container.querySelector("#scene-lbl-time");
  const sceneLatEl    = container.querySelector("#scene-ctrl-lat");
  const sceneLonEl    = container.querySelector("#scene-ctrl-lon");
  const lblLatDir     = container.querySelector("#scene-lbl-lat-dir");
  const lblLonDir     = container.querySelector("#scene-lbl-lon-dir");
  const specName      = container.querySelector("#spec-name");
  const specDesc      = container.querySelector("#spec-desc");
  const specBeamwidth = container.querySelector("#spec-beamwidth");
  const specGain      = container.querySelector("#spec-gain");
  const specPol       = container.querySelector("#spec-polarization");
  const dotBridge     = container.querySelector("#dot-bridge");
  const dotGpredict   = container.querySelector("#dot-gpredict");
  const dotRadio      = container.querySelector("#dot-radio");
  const lblBridge     = container.querySelector("#lbl-bridge");
  const lblGpredict   = container.querySelector("#lbl-gpredict");
  const lblRadio      = container.querySelector("#lbl-radio");

  // ── spectrum (FFT power plot) ──────────────────────────────────────────────
  const spCanvas = container.querySelector("#spectrum-canvas");
  const spCtx    = spCanvas.getContext("2d");
  const SP_W = 308, SP_H = 50;
  spCanvas.width  = SP_W;
  spCanvas.height = SP_H;

  // ── waterfall ─────────────────────────────────────────────────────────────
  const wfCanvas = container.querySelector("#waterfall-canvas");
  const wfCtx    = wfCanvas.getContext("2d");
  const WF_W = 308, WF_H = 300;
  wfCanvas.width  = WF_W;
  wfCanvas.height = WF_H;
  wfCtx.fillStyle = "#000";
  wfCtx.fillRect(0, 0, WF_W, WF_H);

  let wfRowHeight = 1;   // pixels per time row (1 = fast scroll, 8 = stretched)
  wfCanvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    wfRowHeight = Math.max(1, Math.min(8, wfRowHeight + (e.deltaY > 0 ? -1 : 1)));
  }, { passive: false });

  const WF_AXIS_H = 22;

  function drawFreqAxis() {
    const { frequency, bandwidth } = store.getState();
    const bw      = bandwidth || 0.001;
    const freqMin = frequency - bw / 2;
    const freqMax = frequency + bw / 2;

    wfCtx.fillStyle = "#070e1a";
    wfCtx.fillRect(0, 0, WF_W, WF_AXIS_H);

    wfCtx.strokeStyle = "#1e3048";
    wfCtx.lineWidth = 1;
    wfCtx.beginPath();
    wfCtx.moveTo(0, WF_AXIS_H - 1);
    wfCtx.lineTo(WF_W, WF_AXIS_H - 1);
    wfCtx.stroke();

    const ticks = [0, 0.25, 0.5, 0.75, 1.0];
    wfCtx.strokeStyle = "#2e4a62";
    for (const f of ticks) {
      const x = Math.round(f * (WF_W - 1));
      wfCtx.beginPath();
      wfCtx.moveTo(x, WF_AXIS_H - 6);
      wfCtx.lineTo(x, WF_AXIS_H - 1);
      wfCtx.stroke();
    }

    wfCtx.strokeStyle = "#d66a2d";
    wfCtx.beginPath();
    wfCtx.moveTo(WF_W / 2, WF_AXIS_H - 8);
    wfCtx.lineTo(WF_W / 2, WF_AXIS_H - 1);
    wfCtx.stroke();

    wfCtx.font = "bold 9px monospace";
    wfCtx.textBaseline = "top";
    wfCtx.fillStyle = "#4e6880";
    wfCtx.textAlign = "left";
    wfCtx.fillText(freqMin.toFixed(4), 3, 2);
    wfCtx.fillStyle = "#d66a2d";
    wfCtx.textAlign = "center";
    wfCtx.fillText(frequency.toFixed(4), WF_W / 2, 2);
    wfCtx.fillStyle = "#4e6880";
    wfCtx.textAlign = "right";
    wfCtx.fillText(freqMax.toFixed(4), WF_W - 3, 2);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED — Satellite lookup tables, SDR constants, signal processing helpers
  // ═══════════════════════════════════════════════════════════════════════════
  const SAT_CENTER_FREQ_MHZ = Object.fromEntries(
    Object.entries(SATELLITES).map(([k, v]) => [k, v.centerFreqMHz])
  );
  const SAT_EIRP = Object.fromEntries(
    Object.entries(SATELLITES).map(([k, v]) => [k, v.eirp])
  );
  const SAT_iqSampleRate = Object.fromEntries(
    Object.entries(SATELLITES).map(([k, v]) => [k, v.iqSampleRate])
  );
  const SAT_POLARIZATION = Object.fromEntries(
    Object.entries(SATELLITES).map(([k, v]) => [k, v.polarization ?? "linear"])
  );

  const GAIN_MIN_DB        = 0;
  const GAIN_MAX_DB        = 50;
  const SDR_MIN_FREQ_MHZ   = 1;
  const SDR_MAX_DIRECT_MHZ = 6000;

  let iqSampleRate = 48_000;   // current IQ file sample rate in Hz

  function getIQCenterMHz() {
    return SAT_CENTER_FREQ_MHZ[store.getState().targetSat] ?? 0.0;
  }

  // Convert IF frequency (what the SDR sees) to true RF.
  // Only applies the LO shift when the target satellite actually requires down conversion.
  function toRFMHz(ifMHz) {
    const { downconvEnabled, downconvLO, targetSat, antennaType } = store.getState();
    const satFreq = SAT_CENTER_FREQ_MHZ[targetSat] ?? 0;
    if (downconvEnabled && antennaType === "dish" && satFreq > SDR_MAX_DIRECT_MHZ) return ifMHz + downconvLO;
    return ifMHz;
  }

  function computeFSPL(rangeKm, freqMHz) {
    if (!rangeKm || rangeKm <= 0 || !freqMHz || freqMHz <= 0) return 0;
    const lambda = 299.792458 / freqMHz;   // wavelength in metres
    return 20 * Math.log10(4 * Math.PI * rangeKm * 1000 / lambda);
  }

  function computeSignalPowerDb() {
    const sat = store.getState().targetSat;
    const eirp = SAT_EIRP[sat];
    const freqMHz = SAT_CENTER_FREQ_MHZ[sat];
    if (eirp === undefined || !freqMHz || satRangeKm === null) return -20; // fallback
    return eirp - computeFSPL(satRangeKm, freqMHz);
  }

  // Roll-off taper at band edges — smoothly fades signal into noise floor
  function bandEdgeTaper(freqOffsetHz) {
    const edge = Math.abs(freqOffsetHz) / (iqSampleRate / 2);
    if (edge > 1.0) return 0;
    if (edge > 0.85) return (1.0 - edge) / 0.15;
    return 1.0;
  }

  function gaussRand() {
    return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  }

  // Dynamic noise model: N = k × T_system × bandwidth
  const SDR_NOISE_FIGURE_DB = 5;  // typical SDR receiver noise figure
  const BOLTZMANN = 1.380649e-23; // J/K
  const T_RECEIVER = 290 * (10 ** (SDR_NOISE_FIGURE_DB / 10) - 1); // ~627K for 5 dB NF

  function computeNoiseSigma() {
    const ant = antennaTypes[store.getState().antennaType];
    const tAntenna = ant.noiseTemp ?? 80;
    const tSystem = tAntenna + T_RECEIVER;
    const bw = Math.round((store.getState().sampleRate || 0.048) * 1e6);
    const noisePower = BOLTZMANN * tSystem * bw;  // watts
    // Normalize to VSA's ±1.0 ADC range: scale so that typical noise lands
    // in a usable range relative to signal amplitudes
    const NORM = 2.067e10;  // normalization: calibrated so dish@48kSps ≈ 0.003 (50 dB dynamic range)
    return Math.sqrt(noisePower * NORM);
  }

  const FFT_SIZE      = 512;
  const FFT_STEP      = 128;      // complex samples to advance per row
  let MIN_DB          = -65;
  let MAX_DB          = -5;

  // Pre-compute Hann window once
  const HANN = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++)
    HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

  const fftRe  = new Float32Array(FFT_SIZE);
  const fftIm  = new Float32Array(FFT_SIZE);
  const fftMag = new Float32Array(FFT_SIZE);

  function fft(re, im) {
    const n = re.length;
    // bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    // butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j], uIm = im[i + j];
          const vRe = re[i + j + half] * cRe - im[i + j + half] * cIm;
          const vIm = re[i + j + half] * cIm + im[i + j + half] * cRe;
          re[i + j]        = uRe + vRe;  im[i + j]        = uIm + vIm;
          re[i + j + half] = uRe - vRe;  im[i + j + half] = uIm - vIm;
          const nRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nRe;
        }
      }
    }
  }

  let iqSamples = null;   // Float32Array interleaved I,Q
  let iqPos     = 0;      // current complex-sample index

  let gpredictTimeOffset = 0;  // set by time-overlay interval below; used here too

  // ── Satellite position & beam attenuation ────────────────────────────────
  let satAz           = null;
  let satEl           = null;
  let satDopplerHz    = 0;
  let satRangeKm      = null;

  async function updateSatPosition() {
    if (!window.electronAPI) return;
    const state = store.getState();
    if (!SAT_CENTER_FREQ_MHZ[state.targetSat]) {
      satAz = null; satEl = null;
      return;
    }
    const simTime = Date.now() + gpredictTimeOffset;
    const pos = await window.electronAPI.getSatPosition(
      state.targetSat, state.lat, state.lon, simTime
    );
    if (pos) {
      satAz = pos.az; satEl = pos.el;
      satDopplerHz = pos.dopplerHz ?? 0;
      satRangeKm = pos.rangeKm ?? null;
    } else {
      satAz = null; satEl = null;
      satDopplerHz = 0;
      satRangeKm = null;
    }
    store.setState((s) => ({ ...s, _satEl: satEl, _satRangeKm: satRangeKm }));
  }

  const satPosInterval = setInterval(updateSatPosition, 1000);
  updateSatPosition();

  function computeBeamAttenuationDb() {
    const state = store.getState();
    const EL_REFRACTION = 1;  // degrees of atmospheric refraction margin
    const A_ZEN = 2;          // zenith atmospheric loss (dB)

    // No TLE data → satellite position unknown, treat as below horizon
    if (satAz === null || satEl === null) return -60;

    // Atmospheric refraction extends the radio horizon by ~1°.
    // Below that, Earth blocks the signal entirely.
    const elEff = satEl + EL_REFRACTION;
    if (elEff <= 0) return -60;

    const antAzRad = state.azimuth   * Math.PI / 180;
    const antElRad = state.elevation * Math.PI / 180;
    const satAzRad = satAz * Math.PI / 180;
    const satElRad = satEl * Math.PI / 180;

    // Gaussian beam model: −12·(θ/θ_HPBW)² dB  (−3 dB at half-beamwidth)
    const cosTheta = Math.sin(antElRad) * Math.sin(satElRad)
                   + Math.cos(antElRad) * Math.cos(satElRad) * Math.cos(antAzRad - satAzRad);
    const thetaDeg = Math.acos(Math.max(-1, Math.min(1, cosTheta))) * 180 / Math.PI;
    const ant      = antennaTypes[state.antennaType];
    const beamLoss = -12 * (thetaDeg / ant.beamwidthDeg) ** 2;
    const atmLoss = -A_ZEN / Math.sin(elEff * Math.PI / 180);

    // Frequency-dependent gain for dish antenna: G = η(πD/λ)²
    // The dish feed determines the usable frequency range.
    // Other antennas use fixed peakGainDb from their config.
    let peakGain = ant.peakGainDb ?? 0;
    const satFreqMHz = getIQCenterMHz();

    if (state.antennaType === "dish") {
      // Below 1 GHz the dish is electrically too small — no signal at all.
      if (satFreqMHz > 0 && satFreqMHz < 1000) return -60;
      // Feed type determines the usable frequency range
      const feedRanges = {
        lband: [1500, 1800],   // L-band feed: 1.5–1.8 GHz
        sband: [2000, 2500],   // S-band feed: 2.0–2.5 GHz
        ku:    [10700, 12700], // Ku-band feed + LNB: 10.7–12.7 GHz
      };
      const feed = state.dishFeed || "ku";
      const range = feedRanges[feed];
      if (range && satFreqMHz > 0 && (satFreqMHz < range[0] || satFreqMHz > range[1])) return -60;
      if (satFreqMHz > 0) {
        const lambda = 299.792458 / satFreqMHz;  // wavelength in metres
        const dishGainDbi = 10 * Math.log10(0.55 * (Math.PI * 0.75 / lambda) ** 2);
        peakGain = dishGainDbi - 10;  // relative to panel baseline (10 dBi)
      }
    }

    // Yagi and dipole antennas operate in VHF/UHF range (30 MHz – 3 GHz).
    // Above 3 GHz the elements cannot function — no usable gain.
    if (state.antennaType === "yagi" || state.antennaType === "dipole") {
      if (satFreqMHz > 3000) return -60;
    }

    // Polarization mismatch loss
    const satPol = SAT_POLARIZATION[state.targetSat] ?? "linear";
    const antPol = ant.polarization ?? "linear";
    let polLoss = 0;
    if ((satPol === "RHCP" && antPol === "LHCP") || (satPol === "LHCP" && antPol === "RHCP")) {
      polLoss = -60; // cross-polarized — signal blocked
    } else if (satPol !== antPol) {
      polLoss = -3;  // circular-linear mismatch
    }

    return Math.max(-60, peakGain + beamLoss + atmLoss + polLoss);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPECTROGRAM — FFT, waterfall display, spectrum plot
  // ═══════════════════════════════════════════════════════════════════════════
  function computeFFTRow() {
    const n = iqSamples.length >> 1;
    for (let k = 0; k < FFT_SIZE; k++) {
      const si = ((iqPos + k) % n) << 1;
      fftRe[k] = iqSamples[si]     * HANN[k];
      fftIm[k] = iqSamples[si + 1] * HANN[k];
    }
    fft(fftRe, fftIm);
    const norm = 1 / FFT_SIZE;
    for (let k = 0; k < FFT_SIZE; k++) {
      const sk = (k + (FFT_SIZE >> 1)) & (FFT_SIZE - 1); // fftshift
      const r  = fftRe[sk] * norm, im = fftIm[sk] * norm;
      fftMag[k] = 20 * Math.log10(Math.sqrt(r * r + im * im) + 1e-10);
    }
    const rowStride = Math.max(FFT_STEP, Math.round(iqSampleRate * wfInterval / 1000));
    iqPos = (iqPos + rowStride) % n;
  }

  function dbToColor(db) {
    const val = Math.min(255, Math.max(0, ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 255));
    if      (val < 60)  return [0,                          0,                          Math.round(val * 3)];
    else if (val < 120) return [0,                          Math.round((val - 60) * 4), 180];
    else if (val < 180) return [Math.round((val - 120) * 4), 255,                       Math.round(180 - (val - 120) * 3)];
    else                return [255,                         255,                        Math.round((val - 180) * 3)];
  }

  // ── Spectrum (FFT power plot, GQRX-style) ────────────────────────────────
  const SP_DB_TICKS = [MIN_DB, -50, -35, -20, MAX_DB];

  function drawSpectrum(hasSig, beamAtten, signalPowerDb, noiseJitter, gainDb) {
    const { frequency, bandwidth } = store.getState();
    const bw     = bandwidth || (iqSampleRate / 1e6);
    const binHz  = iqSampleRate / FFT_SIZE;

    // Background
    spCtx.fillStyle = "#070c14";
    spCtx.fillRect(0, 0, SP_W, SP_H);

    // Horizontal dB grid lines (no labels)
    for (const db of SP_DB_TICKS) {
      const y = Math.round(SP_H * (1 - (db - MIN_DB) / (MAX_DB - MIN_DB)));
      spCtx.strokeStyle = "#1a2c3e";
      spCtx.lineWidth = 1;
      spCtx.beginPath();
      spCtx.moveTo(0, y);
      spCtx.lineTo(SP_W, y);
      spCtx.stroke();
    }

    // Center frequency marker
    spCtx.strokeStyle = "#d66a2d55";
    spCtx.lineWidth = 1;
    spCtx.beginPath();
    spCtx.moveTo(SP_W / 2, 0);
    spCtx.lineTo(SP_W / 2, SP_H);
    spCtx.stroke();

    // Build filled area path
    spCtx.beginPath();
    for (let x = 0; x < SP_W; x++) {
      const displayFreqMHz = frequency + (x / (SP_W - 1) - 0.5) * bw;
      let db;
      if (hasSig) {
        const freqOffsetHz = (toRFMHz(displayFreqMHz) - getIQCenterMHz()) * 1e6 - satDopplerHz;
        const bin = Math.round(FFT_SIZE / 2 + freqOffsetHz / binHz);
        const taper = bandEdgeTaper(freqOffsetHz);
        const sigDb = (bin >= 0 && bin < FFT_SIZE && taper > 0) ? fftMag[bin] + signalPowerDb + gainDb + beamAtten + 20 * Math.log10(taper) : MIN_DB;
        const noiseDb = MIN_DB + gainDb + Math.random() * noiseJitter;
        db = Math.max(sigDb, noiseDb);
      } else {
        db = MIN_DB + gainDb + Math.random() * noiseJitter;
      }
      const clampedDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
      const y = SP_H * (1 - (clampedDb - MIN_DB) / (MAX_DB - MIN_DB));
      if (x === 0) spCtx.moveTo(x, y);
      else         spCtx.lineTo(x, y);
    }
    spCtx.lineTo(SP_W - 1, SP_H);
    spCtx.lineTo(0, SP_H);
    spCtx.closePath();

    const grad = spCtx.createLinearGradient(0, 0, 0, SP_H);
    grad.addColorStop(0,   "#00d4ff88");
    grad.addColorStop(0.6, "#00d4ff22");
    grad.addColorStop(1,   "#00d4ff00");
    spCtx.fillStyle = grad;
    spCtx.fill();

    // Stroke line on top
    spCtx.strokeStyle = "#00d4ffcc";
    spCtx.lineWidth = 1.2;
    spCtx.beginPath();
    for (let x = 0; x < SP_W; x++) {
      const displayFreqMHz = frequency + (x / (SP_W - 1) - 0.5) * bw;
      let db;
      if (hasSig) {
        const freqOffsetHz = (toRFMHz(displayFreqMHz) - getIQCenterMHz()) * 1e6 - satDopplerHz;
        const bin = Math.round(FFT_SIZE / 2 + freqOffsetHz / binHz);
        const taper = bandEdgeTaper(freqOffsetHz);
        const sigDb = (bin >= 0 && bin < FFT_SIZE && taper > 0) ? fftMag[bin] + signalPowerDb + gainDb + beamAtten + 20 * Math.log10(taper) : MIN_DB;
        const noiseDb = MIN_DB + gainDb + Math.random() * noiseJitter;
        db = Math.max(sigDb, noiseDb);
      } else {
        db = MIN_DB + gainDb + Math.random() * noiseJitter;
      }
      const clampedDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
      const y = SP_H * (1 - (clampedDb - MIN_DB) / (MAX_DB - MIN_DB));
      if (x === 0) spCtx.moveTo(x, y);
      else         spCtx.lineTo(x, y);
    }
    spCtx.stroke();
  }

  // Listen for IQ data events from controls.js
  window.addEventListener("iq-start", (e) => {
    const { bytes, satName } = e.detail;
    // Electron IPC may deliver the Buffer as a plain object {0:byte, 1:byte, ...}
    // instead of a Uint8Array in some versions — normalise it first.
    let raw = bytes;
    if (!(raw instanceof Uint8Array)) raw = new Uint8Array(Object.values(raw));
    // Trim to a 4-byte (float32) boundary before reinterpreting
    const len = raw.byteLength - (raw.byteLength % 4);
    const ab  = raw.buffer.slice(raw.byteOffset, raw.byteOffset + len);
    iqSamples    = new Float32Array(ab);
    iqPos        = 0;
    iqSampleRate = SAT_iqSampleRate[satName] ?? 48_000;
    wfCtx.fillStyle = "#000";
    wfCtx.fillRect(0, WF_AXIS_H, WF_W, WF_H - WF_AXIS_H);
  });

  window.addEventListener("iq-stop", () => {
    iqSamples = null;
    iqPos     = 0;
  });

  // ── Waterfall render loop ─────────────────────────────────────────────────
  function drawWaterfallRow() {
    // scroll existing rows down by wfRowHeight pixels
    const img = wfCtx.getImageData(0, WF_AXIS_H, WF_W, WF_H - WF_AXIS_H - wfRowHeight);
    wfCtx.putImageData(img, 0, WF_AXIS_H + wfRowHeight);
    const row = wfCtx.createImageData(WF_W, 1);

    const noiseSigma     = computeNoiseSigma();
    const wfGainDb       = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, store.getState().gain || 0));
    const wfGainAmp      = 10 ** (wfGainDb / 20);
    const noiseVisual    = Math.min(120, Math.max(25, noiseSigma * wfGainAmp * 1500));
    const beamAtten      = computeBeamAttenuationDb();
    store.setState((s) => ({ ...s, _beamAttenDb: beamAtten }));
    const signalPowerDb  = computeSignalPowerDb();
    const { frequency: _freq, targetSat } = store.getState();
    // Frequency gate: SDR must be tuned within ±(IQ bandwidth/2) of the satellite center
    const freqGateHz  = (toRFMHz(_freq) - getIQCenterMHz()) * 1e6 - satDopplerHz;
    const inFreqRange = Math.abs(freqGateHz) <= iqSampleRate / 2;
    const hasSig = iqSamples !== null && SAT_CENTER_FREQ_MHZ[targetSat] !== undefined &&
                   beamAtten > -60 && inFreqRange;
    if (hasSig) {
      // ── Real FFT spectrogram ──────────────────────────────────────────────
      computeFFTRow();
      const { frequency, bandwidth, gain } = store.getState();
      const bw             = bandwidth || (iqSampleRate / 1e6);
      const gainDb         = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, gain || 0));
      const binHz          = iqSampleRate / FFT_SIZE;
      for (let x = 0; x < WF_W; x++) {
        const displayFreqMHz = frequency + (x / (WF_W - 1) - 0.5) * bw;
        const freqOffsetHz   = (toRFMHz(displayFreqMHz) - getIQCenterMHz()) * 1e6 - satDopplerHz;
        const bin = Math.round(FFT_SIZE / 2 + freqOffsetHz / binHz);
        const taper = bandEdgeTaper(freqOffsetHz);
        const i = x * 4;
        let db = (bin >= 0 && bin < FFT_SIZE && taper > 0) ? fftMag[bin] + signalPowerDb + gainDb + beamAtten + 20 * Math.log10(taper) : MIN_DB - 1;
        // Ensure signal pixels never appear darker than the noise floor
        const noiseDb = MIN_DB + gainDb + Math.random() * noiseVisual * 0.3;
        if (db < noiseDb) db = noiseDb;
        if (db <= MIN_DB) {
          const v = Math.random() * noiseVisual;
          row.data[i] = 0; row.data[i+1] = 0; row.data[i+2] = Math.round(v * 3); row.data[i+3] = 255;
        } else {
          const [r, g, b] = dbToColor(db);
          row.data[i] = r; row.data[i+1] = g; row.data[i+2] = b; row.data[i+3] = 255;
        }
      }
    } else {
      // idle — faint noise floor, no signal (gain still affects noise)
      const { gain } = store.getState();
      const idleGainDb = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, gain || 0));
      for (let x = 0; x < WF_W; x++) {
        const db = MIN_DB + idleGainDb + Math.random() * noiseVisual * 0.3;
        const i = x * 4;
        if (db <= MIN_DB) {
          const v = Math.random() * noiseVisual;
          row.data[i] = 0; row.data[i+1] = 0; row.data[i+2] = Math.round(v * 3); row.data[i+3] = 255;
        } else {
          const [r, g, b] = dbToColor(Math.min(MAX_DB, db));
          row.data[i] = r; row.data[i+1] = g; row.data[i+2] = b; row.data[i+3] = 255;
        }
      }
    }

    for (let r = 0; r < wfRowHeight; r++) wfCtx.putImageData(row, 0, WF_AXIS_H + r);
    drawFreqAxis();
    const noiseJitter = Math.min(15, Math.max(2, noiseSigma / 0.00316 * 4));
    drawSpectrum(hasSig, beamAtten, signalPowerDb, noiseJitter, wfGainDb);

    // ── Real-time recording chunk (80 ms) ─────────────────────────────────
    if (recActive) {
      const NOISE_SIGMA   = computeNoiseSigma();
      const state         = store.getState();
      const clampedGain   = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, state.gain || 0));
      const gainAmp       = 10 ** (clampedGain / 20);
      const signalAmp     = 10 ** (beamAtten / 20);
      const hasSigRec     = iqSamples !== null && SAT_CENTER_FREQ_MHZ[state.targetSat] !== undefined && beamAtten > -60 && inFreqRange;
      const nSrc          = iqSamples ? (iqSamples.length >> 1) : 0;
      recFreqOffsetHz     = (getIQCenterMHz() - toRFMHz(state.frequency || getIQCenterMHz())) * 1e6;
      const totalHz       = satDopplerHz + recFreqOffsetHz;
      const chunkSamples  = Math.round(recTargetRate * wfInterval / 1000);  // one interval worth
      const chunk         = new Float32Array(chunkSamples * 2);
      const phaseStep     = 2 * Math.PI * totalHz / recTargetRate;
      const srcStep       = iqSampleRate / recTargetRate;
      // Signal must be within the Nyquist bandwidth of the recording
      const inBand        = Math.abs(totalHz) <= recTargetRate / 2;
      const sigPowerAmp   = 10 ** (signalPowerDb / 20);

      for (let k = 0; k < chunkSamples; k++) {
        let iOut = gaussRand() * NOISE_SIGMA * gainAmp;
        let qOut = gaussRand() * NOISE_SIGMA * gainAmp;

        if (hasSigRec && inBand) {
          const si0  = Math.floor(recSrcOffset) % nSrc;
          const frac = recSrcOffset - Math.floor(recSrcOffset);
          const si1  = (si0 + 1) % nSrc;
          const iIn  = iqSamples[si0 * 2]     * (1 - frac) + iqSamples[si1 * 2]     * frac;
          const qIn  = iqSamples[si0 * 2 + 1] * (1 - frac) + iqSamples[si1 * 2 + 1] * frac;
          const cosP = Math.cos(recPhase), sinP = Math.sin(recPhase);
          iOut += (iIn * cosP - qIn * sinP) * signalAmp * gainAmp * sigPowerAmp;
          qOut += (iIn * sinP + qIn * cosP) * signalAmp * gainAmp * sigPowerAmp;
        }

        // ADC clipping — simulate saturation at ±1.0
        chunk[k * 2]     = Math.max(-1, Math.min(1, iOut));
        chunk[k * 2 + 1] = Math.max(-1, Math.min(1, qOut));

        // Only advance source position when the signal is actually visible.
        // When hasSig=false the display's iqPos is also frozen, so keeping
        // recSrcOffset in sync avoids phantom extra loops in the recording.
        if (hasSigRec && inBand) {
          recSrcOffset += srcStep;
          if (nSrc > 0 && recSrcOffset >= nSrc) recSrcOffset -= nSrc;
        }
        recPhase += phaseStep;
        if (recPhase >  Math.PI) recPhase -= 2 * Math.PI;
        if (recPhase < -Math.PI) recPhase += 2 * Math.PI;
      }

      // Stream chunk to disk immediately (no memory accumulation)
      if (window.electronAPI?.recChunk) {
        window.electronAPI.recChunk(new Uint8Array(chunk.buffer));
      }
    }
  }
  const wfInterval = 30;
  const wfTimer = setInterval(drawWaterfallRow, wfInterval);

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORDING — IQ capture, Doppler rotation, noise injection, ADC clipping
  // ═══════════════════════════════════════════════════════════════════════════
  let recActive      = false; // true when streaming to disk
  let recTargetRate  = 0;     // sample rate (Hz) snapshotted at REC start
  let recFreqOffsetHz = 0;    // signal frequency offset within captured band (Hz)
  let recSrcOffset   = 0;     // fractional position in source IQ (complex samples)
  let recPhase       = 0;     // accumulated rotation phase for continuity across chunks
  let recMeta        = null;  // SigMF metadata snapshotted at REC start
  let recDir         = null;  // recording output directory

  window.addEventListener("recording-start", async ({ detail: { satName: _satName } }) => {
    const state      = store.getState();
    recTargetRate    = Math.round((state.sampleRate || 0.048) * 1e6);
    recFreqOffsetHz  = 0;  // computed live each chunk
    recSrcOffset     = iqPos;
    recPhase         = 0;
    recDir           = state.recDir || null;
    recMeta          = {
      satellite:    state.targetSat,
      centerFreqHz: toRFMHz(state.frequency || getIQCenterMHz()) * 1e6,
      sampleRate:   recTargetRate,
      gainDb:       state.gain || 0,
      antennaType:  state.antennaType,
      antennaAz:    state.azimuth,
      antennaEl:    state.elevation,
      observerLat:  state.lat,
      observerLon:  state.lon,
      satelliteAz:  satAz,
      satelliteEl:  satEl,
      dopplerHz:    satDopplerHz,
      beamAttenDb:  computeBeamAttenuationDb(),
      datetime:     new Date().toISOString(),
    };
    // Start streaming to disk
    if (window.electronAPI?.recStart) {
      await window.electronAPI.recStart(recDir);
    }
    recActive = true;
  });

  window.addEventListener("recording-save", async ({ detail: { satName, recDir: saveDir } }) => {
    if (!window.electronAPI) return;
    recActive = false;

    const timestamp  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const freqMHz    = ((recMeta?.centerFreqHz ?? 0) / 1e6).toFixed(3).replace(".", "_");
    const safeSat    = satName.replace(/\s+/g, "_").toUpperCase();
    const filename   = `${safeSat}_${freqMHz}MHz_${timestamp}.cf32`;
    try {
      const savedPath = await window.electronAPI.recStop(filename, recMeta, saveDir || recDir);
      window.dispatchEvent(new CustomEvent("recording-saved", { detail: { path: savedPath } }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent("recording-saved", { detail: { error: e.message } }));
    }
  });

  // ── time overlay ──────────────────────────────────────────────────────────

  function formatUTC(ms) {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss} UTC`;
  }

  setInterval(() => {
    const state = store.getState();
    if (state.gpredictTime != null) gpredictTimeOffset = state.gpredictTime - Date.now();
    lblSceneTime.textContent = formatUTC(Date.now() + gpredictTimeOffset);
  }, 1000);

  let prevTime = 0;
  let rafId    = null;

  // ── Uplink mode + amplifier 3D model ──────────────────────────────────────
  let uplinkMode = false;
  let ampSelected = false;
  let ampBlinkOn = false;
  let ampBlinkColor = "#666";  // default gray when no amp selected
  setInterval(() => { ampBlinkOn = !ampBlinkOn; }, 500);

  const AMP_FREQ_COLORS = {
    vhf:   "#00e040",  // bright green
    uhf:   "#2196f3",  // bright blue
    sband: "#ff6600",  // bright orange
    kuband:"#d050ff",  // bright purple
  };

  function buildAmplifierModel() {
    const blinkDotColor = ampBlinkOn ? ampBlinkColor : "#444";
    return [
      // Main body — aluminium box
      ...boxPart({ x: 90, y: -3, z: 8 }, { x: 24, y: 20, z: 16 }, "#a8b0b8"),
      // Top panel — slightly darker to show depth
      ...boxPart({ x: 90, y: -3, z: 16 }, { x: 22, y: 18, z: 2 }, "#909aa2"),
      // Front panel — darker aluminium
      ...boxPart({ x: 102, y: -3, z: 8 }, { x: 2, y: 18, z: 14 }, "#8a929a"),
      // Blinking status LED — on front panel, facing forward
      ...boxPart({ x: 104, y: -1, z: 12 }, { x: 4, y: 6, z: 6 }, blinkDotColor),
      // Wire — amplifier to antenna base (only when amp selected)
      ...(ampSelected ? boxPart({ x: 44, y: -3, z: 8 }, { x: 68, y: 2, z: 2 }, "#222") : []),
    ];
  }

  // ── Satellite state + status panel ──────────────────────────────────────
  const satState = createSatelliteState();
  const ampSpecBox     = container.querySelector("#amp-spec-box");
  const ampSpecName    = container.querySelector("#amp-spec-name");
  const ampSpecFreq    = container.querySelector("#amp-spec-freq");
  const ampSpecPower   = container.querySelector("#amp-spec-power");
  const statusPanel    = container.querySelector("#sat-status-panel");
  const statusLoading  = container.querySelector("#sat-status-loading");
  const statusName     = container.querySelector("#sat-status-name");
  const btnRefreshStatus = container.querySelector("#btn-refresh-status");

  btnRefreshStatus.addEventListener("click", () => {
    if (!satStatusActive) return;
    statusPanel.style.opacity = "0.4";
    setTimeout(() => {
      satState.notify();
      statusPanel.style.opacity = "1";
    }, 500);
  });
  const waterfallOvl   = container.querySelector(".waterfall-overlay");
  const panelBody      = container.querySelector("#sat-panel-body");

  let satStatusActive = false;
  let currentStatusSat = null;
  let fieldEls = {};  // keyed by field source path

  function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${d}d ${h}h ${m}m ${s}s`;
  }

  // Build panel HTML from panel.json
  function buildPanel(panelConfig) {
    fieldEls = {};
    if (!panelConfig || !panelConfig.sections) { panelBody.innerHTML = ""; return; }
    let html = "";
    for (const section of panelConfig.sections) {
      html += `<div class="sat-status-section"><div class="sat-status-section-title">${section.title}</div>`;
      for (const field of section.fields) {
        const key = field.source || (field.sources ? field.sources.join(",") : "");
        html += `<div class="sat-status-row"><span>${field.label}</span>`;
        html += `<span data-field="${key}">—</span>`;
        if (field.bar) html += `<span class="ss-bar"><span class="ss-bar-fill" data-bar="${key}" style="width:0%"></span></span>`;
        if (field.indicator) html += `<span class="ss-ind" data-ind="${key}">—</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    panelBody.innerHTML = html;
    // Cache element refs
    for (const section of panelConfig.sections) {
      for (const field of section.fields) {
        const key = field.source || (field.sources ? field.sources.join(",") : "");
        fieldEls[key] = {
          val: panelBody.querySelector(`[data-field="${key}"]`),
          bar: panelBody.querySelector(`[data-bar="${key}"]`),
          ind: panelBody.querySelector(`[data-ind="${key}"]`),
          field,
        };
      }
    }
  }

  function clearPanel() {
    for (const el of Object.values(fieldEls)) {
      if (el.val) { el.val.textContent = "—"; el.val.style.color = ""; el.val.className = ""; }
      if (el.bar) { el.bar.style.width = "0%"; el.bar.style.background = "#3a4a5a"; }
      if (el.ind) { el.ind.textContent = "—"; el.ind.className = "ss-ind"; }
    }
  }

  function getVal(state, source) {
    return state[source];
  }

  function updatePanel(s) {
    if (!satStatusActive) return;
    const flags = s._flags || {};
    const commStatus = s["comm.status"] || "CONNECTED";

    // Comm disrupted check
    const commDisrupted = satState.isCommDisrupted(commStatus);
    statusPanel.classList.toggle("comm-lost", commDisrupted);

    for (const [key, el] of Object.entries(fieldEls)) {
      const f = el.field;

      // CommStatus field — always update
      if (f.commStatus) {
        el.val.textContent = commStatus;
        const commStyle = satState.getStatusStyle("comm.status", commStatus) || "nominal";
        el.val.className = `ss-ind ${commStyle}`;
        continue;
      }

      // AlwaysShow fields (auth, mode) — update even during comm disruption
      if (f.alwaysShow) {
        const val = getVal(s, f.source);
        el.val.textContent = val ?? "—";
        const style = satState.getStatusStyle(f.source, val);
        el.val.className = style ? `ss-ind ${style}` : "";
        continue;
      }

      // Boolean fields (transponder, stabilization) — always show state
      if (f.boolean && f.dangerWhenFalse !== undefined) {
        const val = getVal(s, f.source);
        el.val.textContent = val ? f.boolean["true"] : f.boolean["false"];
        el.val.className = !val ? "val-danger" : "";
        if (commDisrupted) continue;
      }

      // Freeze other fields during comm disruption
      if (commDisrupted) continue;

      // Single source value
      if (f.source && !f.sources) {
        let val = getVal(s, f.source);
        if (val === undefined || val === null) { el.val.textContent = "—"; continue; }

        // Format
        if (f.format === "uptime") {
          el.val.textContent = formatUptime(val);
        } else if (f.boolean) {
          el.val.textContent = val ? f.boolean["true"] : f.boolean["false"];
          if (f.dangerWhenFalse) el.val.className = !val ? "val-danger" : "";
        } else {
          const decimals = f.decimals !== undefined ? f.decimals : 0;
          const num = typeof val === "number" ? (decimals > 0 ? val.toFixed(decimals) : Math.round(val)) : val;
          el.val.textContent = `${num}${f.unit || ""}`;
        }

        // Color coding
        el.val.style.color = "";
        if (f.dangerBelow !== undefined && val < f.dangerBelow) el.val.style.color = "#f44336";
        else if (f.warnBelow !== undefined && val < f.warnBelow) el.val.style.color = "#ff9800";
        if (f.dangerAbove !== undefined && val > f.dangerAbove) el.val.style.color = "#f44336";
        else if (f.warnAbove !== undefined && val > f.warnAbove) el.val.style.color = "#ff9800";
      }

      // Multi-source values (attitude, antenna)
      if (f.sources) {
        const vals = f.sources.map(src => getVal(s, src));
        if (vals.some(v => v === undefined)) { el.val.textContent = "—"; continue; }
        const decimals = f.decimals !== undefined ? f.decimals : 0;
        let formatted = f.format;
        vals.forEach((v, i) => {
          const num = typeof v === "number" ? (decimals > 0 ? v.toFixed(decimals) : Math.round(v)) : v;
          formatted = formatted.replace(`{${i}}`, num);
        });
        el.val.textContent = formatted;
      }

      // Bar
      if (f.bar && el.bar) {
        const val = getVal(s, f.source) ?? 0;
        el.bar.style.width = `${Math.max(0, val)}%`;
        el.bar.style.background = val > 30 ? "#4caf50" : val > 10 ? "#ff9800" : "#f44336";
      }

      // Indicator
      if (f.indicator && el.ind) {
        const flagVal = flags[f.indicator.source?.replace("_flags.", "")] || false;
        el.ind.textContent = flagVal ? f.indicator.danger : f.indicator.nominal;
        el.ind.className = `ss-ind ${flagVal ? "danger" : "nominal"}`;
        // Also color the value when flagged
        if (el.val) el.val.style.color = flagVal ? "#f44336" : "";
      }
    }
  }

  satState.onChange(updatePanel);

  satState.start(() => satEl);

  let uplinkAntennaType = null;

  window.addEventListener("uplink-antenna-change", (e) => {
    uplinkAntennaType = e.detail.antennaType || null;
  });

  window.addEventListener("uplink-mode", (e) => {
    uplinkMode = e.detail.active;
    ampSelected = !!e.detail.ampKey;
    if (e.detail.ampKey) {
      const band = e.detail.ampKey.split("-")[0];
      ampBlinkColor = AMP_FREQ_COLORS[band] || "#4caf50";
      const amp = AMPLIFIERS[e.detail.ampKey];
      if (amp) {
        ampSpecName.textContent  = amp.label;
        ampSpecFreq.textContent  = `${amp.freqRange[0]}–${amp.freqRange[1]} MHz`;
        ampSpecPower.textContent = `${amp.powerDbm} dBm`;
        ampSpecBox.style.display = "";
      }
    } else {
      ampSpecBox.style.display = "none";
    }
    // Show/hide spectrogram vs status panel
    if (uplinkMode) {
      waterfallOvl.style.display = "none";
      statusPanel.style.display = "";
      statusName.textContent = e.detail.satellite || "—";

      if (e.detail.satellite && e.detail.satellite !== currentStatusSat) {
        currentStatusSat = e.detail.satellite;
        panelBody.innerHTML = "";
        satStatusActive = false;
        statusLoading.style.display = "flex";
        satState.loadSatellite(e.detail.satellite).then(() => {
          buildPanel(satState.getPanelConfig());
          setTimeout(() => {
            statusLoading.style.display = "none";
            satStatusActive = true;
          }, 2000);
        });
      } else if (!e.detail.satellite) {
        currentStatusSat = null;
        panelBody.innerHTML = "";
        satStatusActive = false;
        statusLoading.style.display = "none";
      }
    } else {
      waterfallOvl.style.display = "";
      statusPanel.style.display = "none";
      ampSpecBox.style.display = "none";
      satStatusActive = false;
    }
  });

  const gsOperatorOverlay = container.querySelector("#gs-operator-overlay");
  const gsOperatorFlag    = container.querySelector("#gs-operator-flag");
  const btnGsReconnect    = container.querySelector("#btn-gs-reconnect");
  let gsResetTimer = null;

  function showGsOperator(satellite) {
    // Only show flag if comm was actually disrupted
    const commStatus = satState.getState()["comm.status"] || "CONNECTED";
    const commLost = commStatus !== "CONNECTED" && commStatus !== "REBOOTING";
    if (commLost && window.electronAPI) {
      gsOperatorFlag.style.color = "";
      window.electronAPI.getUplinkFlag(satellite).then(flag => {
        gsOperatorFlag.textContent = flag || "";
      });
    } else {
      gsOperatorFlag.textContent = "";
    }
    gsOperatorOverlay.style.display = "flex";
    satStatusActive = false;

    // Auto-reset after 20 seconds
    if (gsResetTimer) clearTimeout(gsResetTimer);
    gsResetTimer = setTimeout(gsReconnect, 20000);
  }

  function gsReconnect() {
    if (gsResetTimer) { clearTimeout(gsResetTimer); gsResetTimer = null; }
    gsOperatorOverlay.style.display = "none";
    gsOperatorFlag.textContent = "";
    satStatusActive = false;
    // Show loading then reset to normal
    statusLoading.style.display = "flex";
    setTimeout(() => {
      statusLoading.style.display = "none";
      satState.reset();
      satStatusActive = true;
    }, 2000);
  }

  btnGsReconnect.addEventListener("click", gsReconnect);

  const panelMsg = container.querySelector("#sat-panel-msg");

  window.addEventListener("uplink-transmit", (e) => {
    if (e.detail.command === "ping") {
      satState.applyCommand(e.detail.command, e.detail.payload || []);
      panelMsg.textContent = "Pong!";
      panelMsg.style.color = "#44994a";
      setTimeout(() => { panelMsg.textContent = ""; }, 5000);
      return;
    }

    // Multi-command support: apply all commands in sequence
    const commands = e.detail.commands || [{ command: e.detail.command, payload: e.detail.payload }];
    let lastEffect = null;
    let rejected = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      // For multi-command files, apply non-final commands immediately (no base delay)
      // so their state changes are visible to subsequent commands' prerequisite checks
      const immediate = i < commands.length - 1;
      const effect = satState.applyCommand(cmd.command, cmd.payload || [], { immediate });
      if (effect?._rejected) {
        panelMsg.textContent = effect._rejectMessage || "Command rejected";
        panelMsg.style.color = "#ff9800";
        setTimeout(() => { panelMsg.textContent = ""; }, 5000);
        rejected = true;
        break;
      }
      lastEffect = effect;
    }
    if (rejected) return;

    // Show overlay after 15s — gives enough time to see attack effects
    setTimeout(() => showGsOperator(e.detail.satellite), 15000);
  });

  function updateScene(state) {
    const antKey = uplinkMode && uplinkAntennaType ? uplinkAntennaType : state.antennaType;
    const antenna = antennaTypes[antKey];
    renderer.render({
      azimuth:      state.azimuth,
      elevation:    state.elevation,
      antennaParts: antenna.buildModel(state),
      extraParts:   uplinkMode ? buildAmplifierModel() : [],
    });
    roAntenna.textContent      = antenna.label;
    roAz.textContent           = `${Math.round(state.azimuth)}°`;
    roEl.textContent           = `${Math.round(state.elevation)}°`;
    specName.textContent       = antenna.label;
    specDesc.textContent       = antenna.description;
    specBeamwidth.textContent  = `${antenna.beamwidthDeg}°`;
    specGain.textContent       = antenna.peakGainDb > 0 ? `+${antenna.peakGainDb} dB` : `${antenna.peakGainDb} dB`;
    specPol.textContent        = antenna.polarization ?? "linear";

    if (document.activeElement !== sceneLatEl) sceneLatEl.value = state.lat.toFixed(4);
    if (document.activeElement !== sceneLonEl) sceneLonEl.value = state.lon.toFixed(4);
    lblLatDir.textContent = state.lat >= 0 ? "N" : "S";
    lblLonDir.textContent = state.lon >= 0 ? "E" : "W";

    const bc = !!state.bridgeConnected;
    const gc = !!state.gpredictConnected;
    const rc = !!state.radioConnected;

    dotBridge.className     = `status-dot${bc ? " connected" : ""}`;
    lblBridge.textContent   = bc ? "Internal Bridge: connected" : "Internal Bridge: disconnected";

    dotGpredict.className   = `status-dot${gc ? " gpredict" : ""}`;
    lblGpredict.textContent = gc ? "GPredict Tracker: tracking" : "GPredict Tracker: disconnected";

    dotRadio.className      = `status-dot${rc ? " gpredict" : ""}`;
    lblRadio.textContent    = rc ? "GPredict Radio: connected" : "GPredict Radio: disconnected";
  }

  function tick(time) {
    const state = store.getState();

    if (state.autoRotate) {
      if (prevTime === 0) prevTime = time;
      const dt = (time - prevTime) / 1000;
      store.setState((s) => ({
        ...s,
        azimuth: (s.azimuth + s.rotationSpeed * dt) % 360,
      }));
    } else {
      // Still redraw every frame so satellite and other animations keep moving
      updateScene(state);
    }
    prevTime = time;
    rafId = requestAnimationFrame(tick);
  }

  store.subscribe(updateScene);
  rafId = requestAnimationFrame(tick);

  const ro = new ResizeObserver(() => {
    canvas.width  = stage.clientWidth;
    canvas.height = stage.clientHeight;
    updateScene(store.getState());
  });
  ro.observe(stage);

  return () => { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId); clearInterval(satPosInterval); };
}
