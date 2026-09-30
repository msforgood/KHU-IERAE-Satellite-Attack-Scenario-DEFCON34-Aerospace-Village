'use strict';
// Isolated browser contract tests for the recording UI. No scenario server,
// Docker, RF processing or participant files are used. Uploads contain dummy bytes.
// Run: node --test scenario1-eavsdrop-attack/tests/recording-save-regression.test.cjs
// Requires Python + Playwright + Chromium/Chrome/Edge; optional PLAYWRIGHT_MODULE,
// BROWSER_EXECUTABLE, PYTHON, RECORDING_APP_SOURCE and RECORDING_SHIM_SOURCE.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const app = fs.readFileSync(process.env.RECORDING_APP_SOURCE || path.join(root, 'web-guide/static/app.js'), 'utf8');
const shimFile = process.env.RECORDING_SHIM_SOURCE || path.join(root, 'web-guide/server.py');
// Read the actual Python string literal, without importing or starting the server.
const shim = execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c',
  'import ast, pathlib, sys; t=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")); print(next(ast.literal_eval(n.value) for n in t.body if isinstance(n, ast.Assign) and any(isinstance(x, ast.Name) and x.id=="VSA_IQ_SHIM" for x in n.targets)))', shimFile], { encoding: 'utf8' });
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b);
}
const recorderCode = section(app, 'let recTimer = null;', '// Phase-3 antenna + sample-rate');
const navigationCode = section(app, 'function canGo(id)', 'function refreshStepper()') +
  section(app, 'function show(id)', 'function wireNav()') +
  section(app, 'async function doFullReset()', 'function wireResetAll()');
const shimCode = section(shim, 'var __recBuf = [];', 'function feed(');
const saveCode = section(read('vsa/src/components/rotatorScene.js'),
  'window.addEventListener("recording-save",', '// ── time overlay');
const controls = read('vsa/src/components/controls.js');
const buttonCode = section(controls, 'btnRecord.addEventListener("click",', '// ── store → UI');
const savedLabelCode = section(controls, 'window.addEventListener("recording-saved",', '// ── recording save folder');
const parentHTML = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>
  <button id="btnRecord">Record</button><span id="btnRecordStat"></span>
  <button id="toAnalyze">Analyze</button><button id="resetAllBtn">Reset</button><button id="restart">Restart</button>
  <iframe id="vsaFrame" src="/iframe"></iframe><script>
  const $ = s => document.querySelector(s);
  const state = { recorded: true, phase: 'track', reached: { analyze: true }, recUploaded: true };
  const PHASES = []; function refreshStepper() {} function refreshBanner() {}
  let confirmCalls = 0; window.confirm = () => { confirmCalls++; return false; };
  ${navigationCode}
  ${recorderCode}
  wireRecord();
  document.querySelector('#resetAllBtn').onclick = doFullReset;
  </script></body></html>`;
const iframeHTML = `<!doctype html><html><body>
  <button id="btn-record-iq">Record</button><span id="label"></span><span id="status"></span><script>
  ${shimCode}
  let recActive = false, recMeta = { sampleRate: 50000, centerFreqHz: 0 }, recDir = null;
  window.addEventListener('recording-start', async () => {
    await window.electronAPI.recStart(); await window.electronAPI.recChunk(new Uint8Array(4096));
  });
  ${saveCode}
  const btnRecord = document.querySelector('#btn-record-iq'), recLabel = document.querySelector('#label');
  let isRecording = false;
  const store = { getState: () => ({ targetSat: 'UI test fixture' }) };
  function setStatus(text, error) { document.querySelector('#status').textContent = (error ? 'ERROR: ' : '') + text; }
  ${savedLabelCode}
  ${buttonCode}
  </script></body></html>`;

let browser, server, origin, config;
const pendingResponses = new Set();
function loadPlaywright() {
  for (const module of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core',
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
    try { return require(module); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('Playwright unavailable; set PLAYWRIGHT_MODULE. Tests must not silently skip.');
}
before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/iframe' || req.url === '/style.css') {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(req.url === '/' ? parentHTML : req.url === '/iframe' ? iframeHTML : read('web-guide/static/style.css'));
      return;
    }
    const current = config;
    if (req.url.startsWith('/api/upload') && req.method === 'GET') {
      current.gets++; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(current.stored || { exists: false })); return;
    }
    if (req.url.startsWith('/api/upload') && req.method === 'POST') {
      current.posts++;
      let bytes = 0; for await (const chunk of req) bytes += chunk.length;
      current.bytes = bytes;
      const reply = () => {
        pendingResponses.delete(reply);
        if (res.destroyed) return;
        if (current.mode === 'disconnect') { res.destroy(); return; }
        res.setHeader('Content-Type', 'application/json');
        if (current.mode === 'http-error') { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'Fixture disk full' })); return; }
        if (current.mode === 'invalid-json') { res.end('<html>invalid JSON</html>'); return; }
        if (current.mode === 'logical-error') { res.end(JSON.stringify({ ok: false, error: 'Fixture write rejected' })); return; }
        const result = { ok: true, exists: true, size: bytes, uploadedAt: (Date.now() + current.offset) / 1000 };
        if (current.mode === 'size-mismatch') result.size = bytes - 8;
        if (current.mode === 'missing-file') result.exists = false;
        current.stored = result; res.end(JSON.stringify(result));
      };
      if (current.hold) { current.release = reply; pendingResponses.add(reply); }
      else reply();
      return;
    }
    if (req.url.startsWith('/api/reset')) current.resets++;
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.BROWSER_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
  browser = await loadPlaywright().chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  console.log(`Browser: ${browser.version()}; isolated recording UI + in-memory upload fixture only.`);
});
after(async () => {
  for (const reply of pendingResponses) reply();
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
async function fixture(t, changes = {}) {
  config = { mode: 'success', offset: 0, hold: false, posts: 0, gets: 0, resets: 0, ...changes };
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'Unexpected browser errors'));
  await page.goto(origin);
  await page.frameLocator('#vsaFrame').locator('#btn-record-iq').waitFor();
  return page;
}
async function record(page, embedded = false) {
  const button = embedded ? page.frameLocator('#vsaFrame').locator('#btn-record-iq') : page.locator('#btnRecord');
  await button.click();
  assert.equal(await page.locator('#toAnalyze').isDisabled(), true, 'Previous recording must not count as this save');
  await button.click();
}
async function waitResult(page, saved) {
  await page.waitForFunction(() => /passstat (ok|err)/.test(document.querySelector('#btnRecordStat').className)
    && !document.querySelector('#btnRecordStat').textContent.startsWith('●'), null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => state.recorded), saved);
  assert.equal(await page.locator('#toAnalyze').isDisabled(), !saved);
  assert.equal(await page.locator('#btnRecord').isDisabled(), false);
  return page.locator('#btnRecordStat').textContent();
}

test('server clock far behind still confirms this successful upload', async t => {
  const page = await fixture(t, { offset: -86400000 });
  await record(page); assert.match(await waitResult(page, true), /Saved to server/);
  assert.equal(config.posts, 1); assert.equal(config.gets, 0); assert.equal(config.bytes, 4096);
});
test('server clock ahead and browser wall-clock jumps do not affect saving', async t => {
  const page = await fixture(t, { offset: 86400000 });
  await page.evaluate(() => { Date.now = () => 0; });
  await record(page); await waitResult(page, true); assert.equal(config.gets, 0);
});
test('save beyond the old polling window remains pending and then succeeds', async t => {
  const page = await fixture(t, { hold: true });
  await record(page); await page.waitForTimeout(9000);
  assert.match(await page.locator('#btnRecordStat').textContent(), /saving to the server/);
  assert.equal(await page.evaluate(() => state.recorded), false);
  assert.equal(await page.locator('#btnRecord').isDisabled(), true);
  config.release(); await waitResult(page, true); assert.equal(config.gets, 0);
});
test('long wait is not reported as a failed save', async t => {
  const page = await fixture(t, { hold: true });
  await page.clock.install(); await record(page); await page.clock.fastForward(31000);
  assert.match(await page.locator('#btnRecordStat').textContent(), /taking longer/);
  assert.equal(await page.evaluate(() => recordingSavePending), true);
  config.release(); await waitResult(page, true);
});
for (const [mode, expected] of [
  ['http-error', /Fixture disk full/], ['logical-error', /Fixture write rejected/],
  ['invalid-json', /confirmation unavailable/], ['size-mismatch', /expected file size/],
  ['missing-file', /expected file size/], ['disconnect', /server may have received/]
]) {
  test(`${mode}: an old uploaded file cannot hide this save error`, async t => {
    const page = await fixture(t, { mode, stored: { exists: true, size: 4096, uploadedAt: Date.now() / 1000 } });
    await record(page); assert.match(await waitResult(page, false), expected);
    assert.equal(config.gets, 0);
    assert.match(await page.frameLocator('#vsaFrame').locator('#status').textContent(), /ERROR:/);
  });
}
test('saving blocks repeated recording, navigation and reset', async t => {
  const page = await fixture(t, { hold: true }); await record(page);
  assert.equal(await page.frameLocator('#vsaFrame').locator('#btn-record-iq').isDisabled(), true);
  assert.equal(await page.locator('#resetAllBtn').isDisabled(), true);
  assert.equal(await page.locator('#restart').isDisabled(), true);
  await page.evaluate(async () => {
    document.querySelector('#btnRecord').dispatchEvent(new MouseEvent('click'));
    show('analyze'); await doFullReset();
  });
  assert.equal(await page.evaluate(() => state.phase), 'track');
  assert.equal(await page.evaluate(() => canGo('analyze')), false);
  assert.equal(await page.evaluate(() => confirmCalls), 0);
  assert.equal(config.posts, 1); assert.equal(config.resets, 0);
  config.release(); await waitResult(page, true);
  assert.equal(await page.locator('#resetAllBtn').isDisabled(), false);
});
test('embedded recorder and repeated saves reuse the existing completion event', async t => {
  const page = await fixture(t);
  await record(page, true); await waitResult(page, true);
  await page.evaluate(() => wireRecord());
  await record(page); await waitResult(page, true);
  assert.equal(config.posts, 2); assert.equal(config.gets, 0);
});
test('iframe reload releases controls without claiming a successful save', async t => {
  const page = await fixture(t, { hold: true }); await record(page);
  await page.waitForFunction(() => recordingSavePending);
  const previousReply = config.release;
  await page.evaluate(() => { document.querySelector('#vsaFrame').src = '/iframe'; });
  assert.match(await waitResult(page, false), /reloaded during saving/);
  config.hold = false;
  await record(page); await waitResult(page, true);
  previousReply();
  assert.equal(config.posts, 2); assert.equal(config.gets, 0);
});
test('reload while idle and repeated binding do not duplicate upload handlers', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { document.querySelector('#vsaFrame').src = '/iframe'; });
  await page.frameLocator('#vsaFrame').locator('#btn-record-iq').waitFor();
  await record(page); await waitResult(page, true); assert.equal(config.posts, 1);
});
