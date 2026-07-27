// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

"use strict";
/**
 * preload.js – sandboxed bridge between the renderer and the main process.
 *
 * In Electron 20+ the renderer sandbox is on by default, so Node.js built-ins
 * (fs) are NOT available here. Instead we relay the work to the main
 * process via IPC and expose the result through contextBridge.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Asks the main process to load a plain IQ file.
   */
  loadIQFile:      (satName) => ipcRenderer.invoke("load-iq", satName),
  getQTH:          () => ipcRenderer.invoke("get-qth"),
  getSatPosition:  (satName, lat, lon, timestamp) =>
    ipcRenderer.invoke("get-sat-position", satName, lat, lon, timestamp),
  chooseRecDir:    () => ipcRenderer.invoke("choose-rec-dir"),
  recStart:        (dir) => ipcRenderer.invoke("rec-start", { dir }),
  recChunk:        (bytes) => ipcRenderer.invoke("rec-chunk", { bytes }),
  recStop:         (filename, meta, dir) => ipcRenderer.invoke("rec-stop", { filename, meta, dir }),
  onQTHUpdated:    (callback) => ipcRenderer.on("qth-updated", (_event, stations) => callback(stations)),
  decodeUplink:    (filePath, satellite, sampleRate) =>
    ipcRenderer.invoke("decode-uplink", { filePath, satellite, sampleRate }),
  chooseUplinkFile: () => ipcRenderer.invoke("choose-uplink-file"),
  getUplinkFlag:   (satellite) => ipcRenderer.invoke("get-uplink-flag", satellite),
  getSatelliteConfig: (satellite, configName) => ipcRenderer.invoke("get-satellite-config", satellite, configName),
});
