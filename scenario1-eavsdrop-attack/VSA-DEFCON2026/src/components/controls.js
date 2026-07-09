// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

import { SATELLITES } from "../data/satellites.js";
import { SATELLITE_INFO } from "../data/satellite-info.js";
import { AMPLIFIERS } from "../data/amplifiers.js";
import { validateUplink } from "../lib/uplink.js";

export function createControls({ container, store, antennaTypes }) {
  const disabledAntennas = new Set([]);
  const typeOptions = Object.entries(antennaTypes)
    .map(([k, v]) => {
      const disabled = disabledAntennas.has(k);
      return `<option value="${k}"${disabled ? ' disabled style="color:#666"' : ''}>${v.label}${disabled ? ' (coming soon)' : ''}</option>`;
    })
    .join("");

  container.innerHTML = `
    <div class="controls-header">VSA</div>

    <div class="tab-toggle">
      <button id="tab-downlink" class="tab-btn tab-active">DOWNLINK</button>
      <button id="tab-uplink" class="tab-btn">UPLINK</button>
      <button id="tab-satellite" class="tab-btn">SATELLITE</button>
    </div>

    <div id="panel-downlink">
    <div class="control-section">
      <p class="section-title">Target Satellite</p>
      <select id="ctrl-sat" class="sat-input">
        <option value="" disabled selected>Select your satellite</option>
        ${Object.entries(SATELLITES).filter(([, s]) => !s.uplink).map(([name]) => `<option value="${name}">${name}</option>`).join("\n        ")}
      </select>
      <p id="iq-load-status" class="iq-load-status"></p>
    </div>

    <hr class="divider" />

    <div class="control-section">
      <div class="section-title-row">
        <p class="section-title">Virtual SDR</p>
        <div class="record-btn-group">
          <button id="btn-record-iq" class="btn-record" title="Record IQ"></button>
          <span class="record-label">REC</span>
        </div>
      </div>
      <p id="rec-status" class="rec-status"></p>

      <div class="control-row control-row--inline rec-dir-row">
        <label>Save folder</label>
        <div class="rec-dir-group">
          <span id="rec-dir-label" class="rec-dir-label" title="">~/recordings</span>
          <button id="btn-rec-dir" class="btn-step" title="Choose folder">…</button>
        </div>
      </div>

      <div class="control-row control-row--inline">
        <label for="ctrl-freq">Frequency (MHz)</label>
        <input type="number" id="ctrl-freq" min="1" max="6000" step="0.1" />
      </div>

      <div class="control-row control-row--inline">
        <label for="ctrl-samplerate">Sample Rate (MSps)</label>
        <input type="number" id="ctrl-samplerate" min="0" max="20" step="0.1" />
      </div>

      <div class="control-row control-row--inline">
        <label for="ctrl-bandwidth">Bandwidth (MHz)</label>
        <input type="number" id="ctrl-bandwidth" min="0" step="0.001" disabled />
      </div>

      <div class="control-row control-row--inline">
        <label for="ctrl-gain">Gain (0 – 50 dB)</label>
        <div class="input-btn-group">
          <button id="btn-gain-down" class="btn-step">−</button>
          <input type="number" id="ctrl-gain" step="1" min="0" max="50" />
          <button id="btn-gain-up" class="btn-step">+</button>
        </div>
      </div>
    </div>

    <hr class="divider" id="lnb-divider" />

    <div class="control-section" id="lnb-section">
      <div class="section-title-row">
        <p class="section-title">Down Converter (LNB)</p>
        <label class="toggle-switch">
          <input type="checkbox" id="ctrl-downconv" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="control-row control-row--inline">
        <label for="ctrl-downconv-lo">LNB Preset</label>
        <select id="ctrl-downconv-lo">
          <option value="9750">Ku-band low — 9750 MHz</option>
          <option value="10600">Ku-band high — 10600 MHz</option>
          <option value="5150">C-band — 5150 MHz</option>
        </select>
      </div>
    </div>

    <hr class="divider" />

    <div class="control-section">
      <p class="section-title">Mount</p>

      <div class="control-row">
        <label>Antenna type</label>
        <select id="ctrl-type">${typeOptions}</select>
      </div>

      <div class="control-row control-row--inline" id="feed-section">
        <label for="ctrl-dish-feed">Dish Feed</label>
        <select id="ctrl-dish-feed">
          <option value="lband">L-band (1.5–1.8 GHz)</option>
          <option value="sband">S-band (2.0–2.5 GHz)</option>
          <option value="ku" selected>Ku-band (10.7–12.7 GHz)</option>
        </select>
      </div>

      <div class="control-row">
        <label>Azimuth <span id="lbl-az">0°</span></label>
        <input type="range" id="ctrl-az" min="0" max="360" step="0.1" value="131" />
      </div>

      <div class="control-row">
        <label>Elevation <span id="lbl-el">0°</span></label>
        <input type="range" id="ctrl-el" min="0" max="90" step="0.1" value="47" />
      </div>
    </div>

    <hr class="divider" />

    <div class="control-section">
      <p class="section-title">Motion</p>

      <div class="checkbox-row">
        <input type="checkbox" id="ctrl-auto" />
        <label for="ctrl-auto">Auto-rotate azimuth</label>
      </div>

      <div class="control-row">
        <label>Speed <span id="lbl-speed">12°/s</span></label>
        <input type="range" id="ctrl-speed" min="2" max="60" step="1" value="12" />
      </div>
    </div>

    </div><!-- end panel-downlink -->

    <div id="panel-uplink" style="display:none">
    <div class="control-section">
      <p class="section-title">Target Satellite</p>
      <select id="ctrl-sat-uplink" class="sat-input">
        <option value="" disabled selected>Select target satellite</option>
        ${Object.entries(SATELLITES).filter(([, s]) => s.uplink).map(([name]) => `<option value="${name}">${name}</option>`).join("\n        ")}
      </select>
    </div>

    <hr class="divider" />

    <div class="control-section">
      <p class="section-title">Uplink Transmission</p>

      <div class="control-row control-row--inline">
        <label for="ctrl-uplink-freq">Uplink Freq (MHz)</label>
        <input type="number" id="ctrl-uplink-freq" step="0.001" />
      </div>

      <div class="control-row control-row--inline">
        <label for="ctrl-uplink-purpose">Channel</label>
        <input type="text" id="ctrl-uplink-purpose" disabled value="—" />
      </div>

      <div class="control-row">
        <label>Command IQ file</label>
        <div class="rec-dir-group">
          <span id="uplink-file-label" class="rec-dir-label">No file loaded</span>
          <button id="btn-load-uplink" class="btn-step" title="Load .cf32 uplink IQ file">…</button>
        </div>
      </div>

      <button id="btn-transmit" class="btn-transmit" disabled title="Transmit command to satellite">TRANSMIT</button>
      <p id="tx-status" class="tx-status"></p>
    </div>

    <hr class="divider" />

    <div class="control-section">
      <p class="section-title">Mount</p>
      <div class="control-row">
        <label>Antenna type</label>
        <select id="ctrl-type-uplink">${typeOptions}</select>
      </div>
      <div class="control-row">
        <label>Azimuth <span id="lbl-az-uplink">0°</span></label>
        <input type="range" id="ctrl-az-uplink" min="0" max="360" step="0.1" value="0" />
      </div>
      <div class="control-row">
        <label>Elevation <span id="lbl-el-uplink">0°</span></label>
        <input type="range" id="ctrl-el-uplink" min="0" max="90" step="0.1" value="0" />
      </div>
      <div class="control-row">
        <label>Power Amplifier</label>
        <select id="ctrl-amplifier">
          <option value="" disabled selected>Select amplifier</option>
          ${Object.entries(AMPLIFIERS).map(([k, v]) => `<option value="${k}">${v.label} (${v.freqRange[0]}-${v.freqRange[1]} MHz)</option>`).join("\n          ")}
        </select>
      </div>
      <div class="control-row control-row--inline">
        <label>TX Power</label>
        <input type="text" id="ctrl-tx-power" disabled value="—" />
      </div>
    </div>
    </div><!-- end panel-uplink -->

    <div id="panel-satellite" style="display:none"></div>

    <p class="credit">
      VSA — DEF CON Las Vegas 2026 Edition<br />
      Designed &amp; developed by SunHyuk Hwang<br />
      © 2026 SunHyuk Hwang. All rights reserved.
    </p>
  `;

  // ── tab toggle ────────────────────────────────────────────────────────────
  const tabDownlink  = container.querySelector("#tab-downlink");
  const tabUplink    = container.querySelector("#tab-uplink");
  const tabSatellite = container.querySelector("#tab-satellite");
  const panelDL      = container.querySelector("#panel-downlink");
  const panelUL      = container.querySelector("#panel-uplink");
  const panelSat     = container.querySelector("#panel-satellite");

  const TABS = [
    { btn: tabDownlink,  panel: panelDL },
    { btn: tabUplink,    panel: panelUL },
    { btn: tabSatellite, panel: panelSat },
  ];

  // Show only the clicked tab's panel and mark only its button active.
  function showTab(active) {
    for (const t of TABS) {
      const on = t === active;
      t.panel.style.display = on ? "" : "none";
      t.btn.classList.toggle("tab-active", on);
    }
  }

  tabDownlink.addEventListener("click", () => {
    showTab(TABS[0]);
    window.dispatchEvent(new CustomEvent("uplink-mode", { detail: { active: false } }));
  });
  tabUplink.addEventListener("click", () => {
    showTab(TABS[1]);
    // Sync az/el sliders with current antenna position
    const s = store.getState();
    uplinkAzEl.value = s.azimuth;
    uplinkElEl.value = s.elevation;
    lblAzUplink.textContent = `${Math.round(s.azimuth)}°`;
    lblElUplink.textContent = `${Math.round(s.elevation)}°`;
    updateUplinkPanel();
    window.dispatchEvent(new CustomEvent("uplink-mode", {
      detail: { active: true, ampKey: uplinkAmpEl.value || null, satellite: uplinkSatEl.value || null },
    }));
  });
  tabSatellite.addEventListener("click", () => {
    showTab(TABS[2]);
    renderSatelliteInfo();
    // Read-only datasheet — not a transmit mode; leave the RX/TX pipeline in RX.
    window.dispatchEvent(new CustomEvent("uplink-mode", { detail: { active: false } }));
  });

  // ── uplink panel refs ────────────────────────────────────────────────────
  const uplinkSatEl     = container.querySelector("#ctrl-sat-uplink");
  const uplinkFreqEl     = container.querySelector("#ctrl-uplink-freq");
  const uplinkPurposeEl  = container.querySelector("#ctrl-uplink-purpose");
  const uplinkTypeEl     = container.querySelector("#ctrl-type-uplink");
  const uplinkAmpEl      = container.querySelector("#ctrl-amplifier");
  const uplinkTxPowerEl  = container.querySelector("#ctrl-tx-power");
  const uplinkAzEl       = container.querySelector("#ctrl-az-uplink");
  const uplinkElEl       = container.querySelector("#ctrl-el-uplink");
  const lblAzUplink      = container.querySelector("#lbl-az-uplink");
  const lblElUplink      = container.querySelector("#lbl-el-uplink");

  uplinkAzEl.addEventListener("input", () => {
    const az = parseFloat(uplinkAzEl.value);
    lblAzUplink.textContent = `${Math.round(az)}°`;
    store.setState((s) => ({ ...s, azimuth: az }));
  });
  uplinkElEl.addEventListener("input", () => {
    const el = parseFloat(uplinkElEl.value);
    lblElUplink.textContent = `${Math.round(el)}°`;
    store.setState((s) => ({ ...s, elevation: el }));
  });
  const uplinkFileLabel  = container.querySelector("#uplink-file-label");
  const btnLoadUplink    = container.querySelector("#btn-load-uplink");
  const btnTransmit      = container.querySelector("#btn-transmit");
  const txStatus         = container.querySelector("#tx-status");

  let uplinkFilePath = null;

  function updateUplinkPanel() {
    const satName = uplinkSatEl.value;
    const sat = satName ? SATELLITES[satName] : null;
    const ampKey = uplinkAmpEl.value;
    const amp = ampKey ? AMPLIFIERS[ampKey] : null;

    uplinkTxPowerEl.value = amp ? `${amp.powerDbm} dBm (${amp.label})` : "—";

    if (sat && sat.uplink) {
      uplinkPurposeEl.value = sat.uplink.purpose;
      btnTransmit.disabled = !uplinkFilePath;
    } else {
      uplinkFreqEl.value = "";
      uplinkPurposeEl.value = satName ? "No uplink available" : "—";
      btnTransmit.disabled = true;
    }
  }

  uplinkSatEl.addEventListener("change", () => {
    updateUplinkPanel();
    window.dispatchEvent(new CustomEvent("uplink-mode", {
      detail: { active: true, ampKey: uplinkAmpEl.value || null, satellite: uplinkSatEl.value || null },
    }));
  });
  uplinkTypeEl.addEventListener("change", () => {
    updateUplinkPanel();
    window.dispatchEvent(new CustomEvent("uplink-antenna-change", {
      detail: { antennaType: uplinkTypeEl.value },
    }));
  });
  uplinkAmpEl.addEventListener("change", () => {
    updateUplinkPanel();
    window.dispatchEvent(new CustomEvent("uplink-mode", {
      detail: { active: true, ampKey: uplinkAmpEl.value || null, satellite: uplinkSatEl.value || null },
    }));
  });

  btnLoadUplink.addEventListener("click", async () => {
    if (!window.electronAPI) return;
    const filePath = await window.electronAPI.chooseUplinkFile();
    if (filePath) {
      uplinkFilePath = filePath;
      uplinkFileLabel.textContent = filePath.split(/[/\\]/).pop();
      uplinkFileLabel.title = filePath;
      updateUplinkPanel();
    }
  });

  btnTransmit.addEventListener("click", async () => {
    const state = store.getState();
    const satName = uplinkSatEl.value;
    const sat = SATELLITES[satName];
    const antKey = uplinkTypeEl.value;
    const ant = antennaTypes[antKey];
    const ampKey = uplinkAmpEl.value;
    const amp = ampKey ? AMPLIFIERS[ampKey] : null;
    const uplinkFreq = parseFloat(uplinkFreqEl.value) || 0;

    if (!satName || !sat) return;
    if (!uplinkFilePath) return;
    if (!uplinkFreq) return;
    if (!amp) {
      txStatus.textContent = "Amp not connected";
      txStatus.style.color = "#cc4444";
      setTimeout(() => { txStatus.textContent = ""; }, 3000);
      return;
    }

    // Amplifier frequency range check
    if (uplinkFreq < amp.freqRange[0] || uplinkFreq > amp.freqRange[1]) return;

    txStatus.textContent = "Tx attempted";
    txStatus.style.color = "#44994a";
    setTimeout(() => { txStatus.textContent = ""; }, 3000);
    btnTransmit.disabled = true;

    // Step 1: Get uplink satellite position
    let satPos = null;
    try {
      if (window.electronAPI) {
        satPos = await window.electronAPI.getSatPosition(
          satName, state.lat, state.lon, Date.now()
        );
      }
    } catch { /* ignore */ }

    // Step 2: Compute beam attenuation for uplink antenna vs satellite position
    let uplinkBeamAtten = -60;
    if (satPos && satPos.el !== null) {
      const antAzRad = (state.azimuth ?? 0) * Math.PI / 180;
      const antElRad = (state.elevation ?? 0) * Math.PI / 180;
      const satAzRad = (satPos.az ?? 0) * Math.PI / 180;
      const satElRad = (satPos.el ?? 0) * Math.PI / 180;
      const cosTheta = Math.sin(antElRad) * Math.sin(satElRad)
                     + Math.cos(antElRad) * Math.cos(satElRad) * Math.cos(antAzRad - satAzRad);
      const thetaDeg = Math.acos(Math.max(-1, Math.min(1, cosTheta))) * 180 / Math.PI;
      const beamLoss = -12 * (thetaDeg / (ant.beamwidthDeg || 25)) ** 2;
      const peakGain = ant.peakGainDb ?? 0;
      uplinkBeamAtten = Math.max(-60, peakGain + beamLoss);
    }

    // Step 3: Validate physics
    const physResult = validateUplink({
      satellite:   satName,
      frequency:   uplinkFreq,
      antennaType: antKey,
      antenna:     ant,
      amplifier:   amp,
      beamAttenDb: uplinkBeamAtten,
      satRangeKm:  satPos?.rangeKm ?? null,
      satEl:       satPos?.el ?? null,
    });

    console.log("[uplink] physics:", physResult, "satPos:", satPos, "beamAtten:", uplinkBeamAtten);

    if (!physResult.success) {
      console.log("[uplink] physics FAILED:", physResult.reason);
      btnTransmit.disabled = false;
      return;
    }

    // Step 3: Decode uplink IQ file
    try {
      const sampleRate = sat.uplink?.sampleRate || sat.iqSampleRate || 24000;
      const decodeResult = await window.electronAPI.decodeUplink(
        uplinkFilePath, satName, sampleRate
      );

      if (decodeResult.success) {
        window.dispatchEvent(new CustomEvent("uplink-transmit", {
          detail: {
            satellite: satName,
            frequency: parseFloat(uplinkFreqEl.value),
            command:   decodeResult.command,
            opcode:    decodeResult.opcode,
            payload:   decodeResult.payload,
            commands:  decodeResult.commands,
            purpose:   sat.uplink.purpose,
          },
        }));
      }
    } catch { /* silent */ }
    btnTransmit.disabled = false;
  });

  // ── element refs ──────────────────────────────────────────────────────────
  const typeEl    = container.querySelector("#ctrl-type");
  const azEl      = container.querySelector("#ctrl-az");
  const elEl      = container.querySelector("#ctrl-el");
  const autoEl    = container.querySelector("#ctrl-auto");
  const speedEl   = container.querySelector("#ctrl-speed");
  const lblAz     = container.querySelector("#lbl-az");
  const lblEl     = container.querySelector("#lbl-el");
  const lblSpeed  = container.querySelector("#lbl-speed");
  const satEl       = container.querySelector("#ctrl-sat");
  const freqEl        = container.querySelector("#ctrl-freq");
  const sampleRateEl  = container.querySelector("#ctrl-samplerate");
  const bandwidthEl   = container.querySelector("#ctrl-bandwidth");
  const gainEl        = container.querySelector("#ctrl-gain");
  const btnGainUp     = container.querySelector("#btn-gain-up");
  const btnGainDown   = container.querySelector("#btn-gain-down");
  const dishFeedEl    = container.querySelector("#ctrl-dish-feed");
  const feedSection   = container.querySelector("#feed-section");
  const downconvEl    = container.querySelector("#ctrl-downconv");
  const downconvLOEl  = container.querySelector("#ctrl-downconv-lo");
  const lnbSection    = container.querySelector("#lnb-section");
  const lnbDivider    = container.querySelector("#lnb-divider");

  // ── events → store ────────────────────────────────────────────────────────
  typeEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, antennaType: typeEl.value })));

  azEl.addEventListener("input", () =>
    store.setState((s) => ({ ...s, azimuth: parseFloat(azEl.value) })));

  elEl.addEventListener("input", () =>
    store.setState((s) => ({ ...s, elevation: parseFloat(elEl.value) })));

  autoEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, autoRotate: autoEl.checked })));

  speedEl.addEventListener("input", () =>
    store.setState((s) => ({ ...s, rotationSpeed: parseFloat(speedEl.value) })));

  const iqLoadStatus = container.querySelector("#iq-load-status");
  let iqStatusTimer = null;

  function showIQStatus(msg, ok) {
    clearTimeout(iqStatusTimer);
    iqLoadStatus.textContent = msg;
    iqLoadStatus.className = `iq-load-status ${ok ? "iq-load-ok" : "iq-load-err"}`;
    iqStatusTimer = setTimeout(() => { iqLoadStatus.textContent = ""; }, 4000);
  }

  async function loadSatIQ(satName) {
    window.dispatchEvent(new CustomEvent("iq-stop"));
    if (!window.electronAPI) return;
    try {
      const { bytes, path: filePath } = await window.electronAPI.loadIQFile(satName);
      window.dispatchEvent(new CustomEvent("iq-start", { detail: { bytes, satName } }));
      showIQStatus(filePath, true);
    } catch (err) {
      showIQStatus(err?.message || "No signal file loaded", false);
    }
  }

  satEl.addEventListener("change", () => {
    const sat = satEl.value.trim();
    if (!sat) return;
    store.setState((s) => ({ ...s, targetSat: sat }));
    loadSatIQ(sat);
  });

  freqEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, frequency: parseFloat(freqEl.value) || s.frequency })));

  sampleRateEl.addEventListener("change", () => {
    const v = parseFloat(sampleRateEl.value) || null;
    if (v) store.setState((s) => ({ ...s, sampleRate: v, bandwidth: v }));
  });

  gainEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, gain: Math.max(0, Math.min(50, parseFloat(gainEl.value) || s.gain)) })));

  btnGainUp.addEventListener("click", () =>
    store.setState((s) => ({ ...s, gain: Math.min(50, s.gain + 1) })));

  btnGainDown.addEventListener("click", () =>
    store.setState((s) => ({ ...s, gain: Math.max(0, s.gain - 1) })));

  dishFeedEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, dishFeed: dishFeedEl.value })));

  downconvEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, downconvEnabled: downconvEl.checked })));

  downconvLOEl.addEventListener("change", () =>
    store.setState((s) => ({ ...s, downconvLO: parseFloat(downconvLOEl.value) })));


  window.addEventListener("recording-saved", ({ detail }) => {
    if (detail.error) {
      setStatus(detail.error, true);
    } else {
      setStatus(`Saved: ${detail.path}`);
    }
  });

  // ── recording save folder ──────────────────────────────────────────────
  const recDirLabel = container.querySelector("#rec-dir-label");
  const btnRecDir   = container.querySelector("#btn-rec-dir");
  let   recDir      = null;   // null = default ~/recordings

  btnRecDir.addEventListener("click", async () => {
    if (!window.electronAPI) return;
    const chosen = await window.electronAPI.chooseRecDir();
    if (chosen) {
      recDir = chosen;
      recDirLabel.textContent = chosen;
      recDirLabel.title       = chosen;
    }
  });

  const btnRecord   = container.querySelector("#btn-record-iq");
  const recLabel    = container.querySelector(".record-label");
  const recStatus   = container.querySelector("#rec-status");
  let   isRecording = false;

  let statusTimer = null;
  function setStatus(msg, isError = false) {
    recStatus.textContent = msg;
    recStatus.style.color = isError ? "#cc4444" : "#44994a";
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { recStatus.textContent = ""; }, 10_000);
  }

  btnRecord.addEventListener("click", async () => {
    if (!isRecording) {
      // ── Start recording ──────────────────────────────────────
      isRecording = true;
      btnRecord.classList.add("recording");
      recLabel.classList.add("recording");
      btnRecord.title = "Recording — click to stop";
      window.dispatchEvent(new CustomEvent("recording-start", {
        detail: { satName: store.getState().targetSat },
      }));
    } else {
      // ── Stop recording ───────────────────────────────────────
      isRecording = false;
      btnRecord.classList.remove("recording");
      recLabel.classList.remove("recording");
      btnRecord.title = "Record IQ";
      setStatus("Saving…");
      window.dispatchEvent(new CustomEvent("recording-save", {
        detail: { satName: store.getState().targetSat, recDir },
      }));
    }
  });

  // ── store → UI ────────────────────────────────────────────────────────────
  // ── satellite datasheet (read-only SATELLITE tab) ──────────────────────────
  let lastRenderedSat = null;

  function satsheetKV(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `<div class="sheet-row"><span class="sheet-key">${k}</span><span class="sheet-val">${v}</span></div>`)
      .join("");
  }

  // Ordered (title → data key). Any section absent from the data is skipped,
  // so a satellite can omit whatever isn't relevant to solving it.
  const SHEET_SECTIONS = [
    ["Identity", "identity"],
    ["Orbit", "orbit"],
    ["RF / Signal", "rf"],
    ["Recommended SDR", "sdr"],
    ["Pass Characteristics", "passes"],
  ];

  function renderSatelliteInfo() {
    const name = store.getState().targetSat || satEl.value || Object.keys(SATELLITES)[0];
    lastRenderedSat = name;
    const info = name ? SATELLITE_INFO[name] : null;
    if (!info) {
      panelSat.innerHTML = `<div class="control-section"><p class="sheet-empty">No reference info for ${name || "—"}.</p></div>`;
      return;
    }
    const section = (title, obj) => `
      <div class="control-section">
        <p class="section-title">${title}</p>
        <div class="sheet-dl">${satsheetKV(obj)}</div>
      </div>`;
    const sectionsHtml = SHEET_SECTIONS
      .filter(([, key]) => info[key] && Object.keys(info[key]).length)
      .map(([title, key]) => section(title, info[key]))
      .join("");
    const tleHtml = info.tle && info.tle.length ? `
      <div class="control-section">
        <div class="section-title-row">
          <p class="section-title">TLE</p>
          <button id="btn-copy-tle" class="sheet-copy" title="Copy TLE to clipboard">Copy TLE</button>
        </div>
        <pre class="sheet-tle">${info.tle.join("\n")}</pre>
      </div>` : "";
    const notesHtml = info.notes && info.notes.length ? `
      <div class="control-section">
        <p class="section-title">Notes</p>
        <ul class="sheet-notes">${info.notes.map((n) => `<li>${n}</li>`).join("")}</ul>
      </div>` : "";
    const heroHtml = info.image
      ? `<img class="sheet-hero" src="${info.image}" alt="${name}" />`
      : "";
    panelSat.innerHTML = `
      ${heroHtml}
      <div class="sheet-header">
        <p class="sheet-name">${name}<span class="sheet-status">${info.status}</span></p>
        <p class="sheet-tagline">${info.tagline}</p>
      </div>
      ${sectionsHtml}
      ${tleHtml}
      ${notesHtml}`;
  }

  // Copy TLE — event-delegated so it survives panel re-renders.
  panelSat.addEventListener("click", async (e) => {
    const btn = e.target.closest("#btn-copy-tle");
    if (!btn) return;
    const info = lastRenderedSat ? SATELLITE_INFO[lastRenderedSat] : null;
    if (!info || !info.tle) return;
    try {
      await navigator.clipboard.writeText(info.tle.join("\n"));
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    } catch {
      btn.textContent = "Copy failed";
    }
  });

  store.subscribe((state) => {
    typeEl.value  = state.antennaType;
    azEl.value    = state.azimuth;
    elEl.value    = state.elevation;
    autoEl.checked = state.autoRotate;
    speedEl.value = state.rotationSpeed;

    if (document.activeElement !== satEl)  satEl.value  = state.targetSat;
    // Keep the SATELLITE datasheet in sync when the target changes.
    if (state.targetSat !== lastRenderedSat) renderSatelliteInfo();
    freqEl.disabled = state.radioControlled;
    if (state.radioControlled) {
      freqEl.value = state.frequency;
      freqEl.title = "Controlled by GPredict radio";
    } else {
      freqEl.title = "";
      if (document.activeElement !== freqEl) freqEl.value = state.frequency;
    }
    if (document.activeElement !== sampleRateEl) sampleRateEl.value = state.sampleRate;
    if (document.activeElement !== bandwidthEl)  bandwidthEl.value  = state.bandwidth;
    if (document.activeElement !== gainEl)       gainEl.value       = state.gain;
    const isDish = state.antennaType === "dish";
    const isKuFeed = state.dishFeed === "ku";
    feedSection.style.display = isDish ? "" : "none";
    lnbSection.style.display = isDish && isKuFeed ? "" : "none";
    lnbDivider.style.display = isDish && isKuFeed ? "" : "none";
    if (document.activeElement !== dishFeedEl) dishFeedEl.value = state.dishFeed;
    downconvEl.checked = state.downconvEnabled;
    if (document.activeElement !== downconvLOEl) downconvLOEl.value = state.downconvLO;


    lblAz.textContent    = `${Math.round(state.azimuth)}°`;
    lblEl.textContent    = `${Math.round(state.elevation)}°`;

    // Sync uplink sliders
    if (document.activeElement !== uplinkAzEl) {
      uplinkAzEl.value = state.azimuth;
      lblAzUplink.textContent = `${Math.round(state.azimuth)}°`;
    }
    if (document.activeElement !== uplinkElEl) {
      uplinkElEl.value = state.elevation;
      lblElUplink.textContent = `${Math.round(state.elevation)}°`;
    }
    lblSpeed.textContent = `${state.rotationSpeed}°/s`;

  });
}
