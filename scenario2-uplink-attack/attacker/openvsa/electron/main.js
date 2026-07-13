// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

"use strict";
/**
 * main.js – Electron main process.
 *
 * Handles plain IQ file loading, SGP4 orbit propagation
 * (satellite position, Doppler), IQ recording file I/O, GPredict
 * ground station location sync, uplink command decoding (Python),
 * satellite config loading, and the application window lifecycle.
 */
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path      = require("path");
const crypto    = require("crypto");
const fs        = require("fs");
const os        = require("os");
const satellite = require("satellite.js");

const TLE_FILE = path.join(__dirname, "..", "tle.txt");
const { SATELLITES, ANT_INFO, UPLINK_FLAGS } = require("./config.js");

// ── Plain IQ file loader with SHA-256 validation ─────────────────────────
ipcMain.handle("load-iq", async (_event, satName) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:      `Load IQ file for ${satName}`,
    filters:    [{ name: "IQ files", extensions: ["cf32", "iq"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) throw new Error(`No IQ file selected`);
  const filePath = filePaths[0];
  const bytes = fs.readFileSync(filePath);

  // Verify file integrity against the known hash
  const expectedHash = SATELLITES[satName]?.iqFileHash;
  if (expectedHash) {
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Hash mismatch for ${satName} — file may be corrupted or wrong.\nExpected: ${expectedHash}\nGot:      ${actualHash}`);
    }
  }

  return { bytes, path: filePath };
});

// ── Satellite position (SGP4 via TLE) ─────────────────────────────────────
function parseTLEForSat(satName) {
  // Normalize: strip trailing "(…)" descriptor if present, and uppercase for matching
  const needle = satName.replace(/\s*\(.*\)\s*$/, "").trim().toUpperCase();
  const lines  = fs.readFileSync(TLE_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l);
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!lines[i].startsWith("1 ") && !lines[i].startsWith("2 ")) {
      const tleName = lines[i].replace(/\s*\(.*\)\s*$/, "").trim().toUpperCase();
      if (tleName === needle && lines[i+1].startsWith("1 ") && lines[i+2].startsWith("2 ")) {
        return { line1: lines[i+1], line2: lines[i+2] };
      }
    }
  }
  return null;
}

ipcMain.handle("get-sat-position", (_event, satName, lat, lon, timestamp) => {
  try {
    const tle = parseTLEForSat(satName);
    if (!tle) return null;

    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    const date   = new Date(timestamp);
    const { position } = satellite.propagate(satrec, date);
    if (!position) return null;

    const gmst        = satellite.gstime(date);
    const positionEcf = satellite.eciToEcf(position, gmst);
    const observerGd  = {
      longitude: satellite.degreesToRadians(lon),
      latitude:  satellite.degreesToRadians(lat),
      height:    0.01,   // km
    };
    const look = satellite.ecfToLookAngles(observerGd, positionEcf);

    // Observer ECF via WGS84 (manual, avoids sign ambiguity in geodeticToEcf).
    const e2 = 0.00669437999014, a_km = 6378.137;
    const lat_r = observerGd.latitude, lon_r = observerGd.longitude, h = observerGd.height;
    const N = a_km / Math.sqrt(1 - e2 * Math.sin(lat_r) ** 2);
    const obsEcf = {
      x: (N + h) * Math.cos(lat_r) * Math.cos(lon_r),
      y: (N + h) * Math.cos(lat_r) * Math.sin(lon_r),
      z: (N * (1 - e2) + h) * Math.sin(lat_r),
    };
    // Range rate via 1-second numerical differentiation.
    const date2    = new Date(timestamp + 1000);
    const { position: pos2 } = satellite.propagate(satrec, date2);
    const posEcf2  = satellite.eciToEcf(pos2, satellite.gstime(date2));
    const d = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
    const rangeRateKmS = d(posEcf2, obsEcf) - d(positionEcf, obsEcf); // +ve = receding
    const centerHz     = SATELLITES[satName]?.centerFreqHz ?? 145.825e6;
    const dopplerHz    = -centerHz * rangeRateKmS / 299792.458;        // -ve when receding
    console.log(`[doppler] el=${satellite.radiansToDegrees(look.elevation).toFixed(1)}° rate=${rangeRateKmS.toFixed(3)}km/s shift=${dopplerHz.toFixed(0)}Hz`);

    return {
      az:           satellite.radiansToDegrees(look.azimuth),
      el:           satellite.radiansToDegrees(look.elevation),
      aboveHorizon: look.elevation > 0,
      dopplerHz,
      rangeKm:      look.rangeSat,
    };
  } catch (e) {
    console.error("[sat-pos]", e.message);
    return null;
  }
});

// ── Let the user pick a save directory ────────────────────────────────────
ipcMain.handle("choose-rec-dir", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:      "Choose recording save folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// ── Streaming recording — chunks written to disk as they arrive ───────────
let recStream   = null;  // active write stream
let recTempPath = null;  // temp file path during recording

ipcMain.handle("rec-start", (_event, { dir: customDir }) => {
  const dir = customDir || path.join(os.homedir(), "recordings");
  fs.mkdirSync(dir, { recursive: true });
  recTempPath = path.join(dir, `.rec-${Date.now()}.tmp`);
  recStream = fs.createWriteStream(recTempPath);
  console.log(`[rec] Started streaming to ${recTempPath}`);
  return true;
});

ipcMain.handle("rec-chunk", (_event, { bytes }) => {
  if (!recStream) return;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  recStream.write(buf);
});

ipcMain.handle("rec-stop", (_event, { filename, meta, dir: customDir }) => {
  if (!recStream) return null;
  recStream.end();
  recStream = null;

  const dir = customDir || path.join(os.homedir(), "recordings");
  const outPath = path.join(dir, filename);

  // Rename temp file to final filename
  try {
    fs.renameSync(recTempPath, outPath);
  } catch {
    // Cross-device rename fallback
    fs.copyFileSync(recTempPath, outPath);
    fs.unlinkSync(recTempPath);
  }
  recTempPath = null;

  if (meta) {
    const ant = ANT_INFO[meta.antennaType] ?? {};
    const sigmf = {
      "global": {
        "core:datatype":    "cf32_le",
        "core:sample_rate": meta.sampleRate,
        "core:version":     "1.0.0",
        "core:hw":          `Virtual Antenna Simulator / ${meta.antennaType}`,
      },
      "captures": [{
        "core:sample_start": 0,
        "core:frequency":    meta.centerFreqHz,
        "core:datetime":     meta.datetime,
      }],
      "annotations": [{
        "core:sample_start":                    0,
        "core:comment":                         `${meta.satellite} recording`,
        "virtual_antenna:satellite":            meta.satellite,
        "virtual_antenna:satellite_az_deg":     meta.satelliteAz,
        "virtual_antenna:satellite_el_deg":     meta.satelliteEl,
        "virtual_antenna:doppler_hz":           meta.dopplerHz,
        "virtual_antenna:antenna_type":         meta.antennaType,
        "virtual_antenna:antenna_az_deg":       meta.antennaAz,
        "virtual_antenna:antenna_el_deg":       meta.antennaEl,
        "virtual_antenna:antenna_beamwidth_deg":ant.beamwidthDeg,
        "virtual_antenna:antenna_peak_gain_db": ant.peakGainDb,
        "virtual_antenna:beam_atten_db":        meta.beamAttenDb,
        "virtual_antenna:gain_db":              meta.gainDb,
        "virtual_antenna:observer_lat":         meta.observerLat,
        "virtual_antenna:observer_lon":         meta.observerLon,
      }],
    };
    fs.writeFileSync(outPath.replace(/\.cf32$/, ".sigmf-meta"),
                     JSON.stringify(sigmf, null, 2));
  }

  console.log(`[rec] Saved: ${outPath}`);
  return outPath;
});

// ── GPredict ground station reader ────────────────────────────────────────
ipcMain.handle("get-qth", async () => {
  const dir = path.join(os.homedir(), ".config", "Gpredict");
  console.log("[get-qth] scanning", dir);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".qth"));
    console.log("[get-qth] found files:", files);
  } catch (e) {
    console.error("[get-qth] failed to read dir:", e.message);
    return [];
  }
  const stations = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      let lat = null, lon = null, name = null;
      for (const line of content.split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key === "LAT")      lat  = parseFloat(val);
        if (key === "LON")      lon  = parseFloat(val);
        if (key === "LOCATION") name = val;
      }
      if (lat !== null && lon !== null) stations.push({ name: name || file, lat, lon });
    } catch (e) { console.error("[get-qth] failed to parse", file, e.message); }
  }
  console.log("[get-qth] returning:", JSON.stringify(stations));
  return stations;
});

// ── Auto-watch GPredict .qth files for location changes ──────────────────
const QTH_DIR = path.join(os.homedir(), ".config", "Gpredict");

function readQTHStations() {
  try {
    const files = fs.readdirSync(QTH_DIR).filter(f => f.endsWith(".qth"));
    const stations = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(QTH_DIR, file), "utf8");
        let lat = null, lon = null, name = null;
        for (const line of content.split("\n")) {
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          const key = line.slice(0, eq).trim();
          const val = line.slice(eq + 1).trim();
          if (key === "LAT")      lat  = parseFloat(val);
          if (key === "LON")      lon  = parseFloat(val);
          if (key === "LOCATION") name = val;
        }
        if (lat !== null && lon !== null) stations.push({ name: name || file, lat, lon });
      } catch {}
    }
    return stations;
  } catch { return []; }
}

try {
  fs.watch(QTH_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith(".qth")) return;
    console.log(`[qth-watch] ${filename} changed, reloading location`);
    const stations = readQTHStations();
    if (stations.length > 0) {
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send("qth-updated", stations);
      });
    }
  });
  console.log("[qth-watch] Watching", QTH_DIR);
} catch (e) {
  console.error("[qth-watch] Could not watch dir:", e.message);
}

// ── Uplink flag retrieval ─────────────────────────────────────────────────
ipcMain.handle("get-uplink-flag", (_event, satellite) => {
  return UPLINK_FLAGS[satellite] || null;
});

// ── Satellite config loading ─────────────────────────────────────────────
ipcMain.handle("get-satellite-config", (_event, satellite, configName) => {
  const configPath = path.join(__dirname, "..", "satellites", satellite.toLowerCase(), configName);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch { return null; }
});

// ── Uplink file chooser ───────────────────────────────────────────────────
ipcMain.handle("choose-uplink-file", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title:      "Load uplink command IQ file",
    filters:    [{ name: "IQ files", extensions: ["cf32", "iq"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// ── Uplink command decoder ─────────────────────────────────────────────────
const { execFile } = require("child_process");

ipcMain.handle("decode-uplink", async (_event, { filePath, satellite, sampleRate }) => {
  let decoderPath = path.join(__dirname, "..", "satellites", satellite.toLowerCase(), "decoder.py");
  // child_process can't read from .asar — use .asar.unpacked path
  decoderPath = decoderPath.replace("app.asar", "app.asar.unpacked");
  if (!fs.existsSync(decoderPath)) {
    return { success: false, error: `No decoder found for ${satellite}` };
  }

  return new Promise((resolve) => {
    const args = [decoderPath, filePath, String(sampleRate || 24000)];
    execFile("python3", args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr?.trim() || err.message });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ success: false, error: "Decoder returned invalid output" });
      }
    });
  });
});

// Start the TCP/WebSocket bridge in this same Node process.
// server.js binds TCP :4533 (GPredict) and WS :4534 (browser) on require.
require("../server.js");

function createWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 740,
    title:  "OpenVSA",
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
