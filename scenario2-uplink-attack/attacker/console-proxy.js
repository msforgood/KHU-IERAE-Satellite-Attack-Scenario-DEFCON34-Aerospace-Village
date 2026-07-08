#!/usr/bin/env node
// console-proxy.js — single-port ③ phase-3 console (pure Node, zero deps).
//
// One port serves the whole targeting screen:
//   /            → attacker/console/   (static; the console page)
//   /vsa/…       → attacker/openvsa/   (static; OpenVSA renderer — ES modules)
//   /gpredict/…  → http://GP_HOST:GP_PORT  (gpredict noVNC: HTTP **and** WebSocket)
//
// gpredict is a Docker noVNC+websockify service on :6080; its VNC stream is a
// WebSocket, so we proxy both plain HTTP (the noVNC assets) and the WS upgrade.
// noVNC must be opened with `?path=gpredict/websockify` so it connects the WS to
// /gpredict/websockify here, which we forward (prefix-stripped) to websockify
// (websockify ignores the WS path and bridges to the VNC target).
//
// The OpenVSA backend WebSocket (ws://localhost:4534) is reached cross-origin by
// the renderer directly — no proxy needed for it.
//
//   env: PORT|CONSOLE_PORT (default 8090) · GP_PORT (6080) · GP_HOST (127.0.0.1)

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const PORT    = +(process.env.PORT || process.env.CONSOLE_PORT || 8090);
const GP_PORT = +(process.env.GP_PORT || 6080);
const GP_HOST = process.env.GP_HOST || "127.0.0.1";

const HERE        = __dirname;                       // attacker/
const CONSOLE_DIR = path.join(HERE, "console");
const OPENVSA_DIR = path.join(HERE, "openvsa");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

function serveStatic(baseDir, rel, res) {
  rel = rel.split("?")[0];
  const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");   // block traversal
  let fp = path.join(baseDir, clean);
  if (!fp.startsWith(baseDir)) { res.writeHead(403); return res.end("forbidden"); }
  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) fp = path.join(fp, "index.html");
    fs.readFile(fp, (e, data) => {
      if (e) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    });
  });
}

// plain-HTTP proxy for gpredict noVNC assets
function proxyHttp(req, res) {
  const outPath = req.url.replace(/^\/gpredict/, "") || "/";
  const preq = http.request(
    { host: GP_HOST, port: GP_PORT, method: req.method, path: outPath, headers: req.headers },
    (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); }
  );
  preq.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("gpredict proxy error — is the gpredict-web Docker container up on :" + GP_PORT + "?");
  });
  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === "/gpredict" || url.startsWith("/gpredict/")) return proxyHttp(req, res);
  if (url === "/vsa")  { res.writeHead(302, { Location: "/vsa/" }); return res.end(); }
  if (url.startsWith("/vsa/")) return serveStatic(OPENVSA_DIR, url.slice("/vsa".length), res);
  const rel = url === "/" ? "/index.html" : url;
  return serveStatic(CONSOLE_DIR, rel, res);
});

// WebSocket upgrade → forward /gpredict/* raw to websockify (prefix-stripped).
server.on("upgrade", (req, socket, head) => {
  if (!(req.url === "/gpredict" || req.url.startsWith("/gpredict/"))) { socket.destroy(); return; }
  const outPath = req.url.replace(/^\/gpredict/, "") || "/";
  const up = net.connect(GP_PORT, GP_HOST, () => {
    const headerLines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    up.write(`${req.method} ${outPath} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[console] single-port phase-3 → http://localhost:${PORT}`);
  console.log(`          /  console   ·   /vsa/  OpenVSA   ·   /gpredict/  gpredict(→ :${GP_PORT}, HTTP+WS)`);
});
