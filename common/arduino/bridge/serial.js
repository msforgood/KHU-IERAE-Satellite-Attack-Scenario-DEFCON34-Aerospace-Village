#!/usr/bin/env node
// serial.js — 시리얼 포트 공용 레이어 (macOS · Linux · Windows). 의존성 0.
//
// 왜 필요한가:
//   부스의 시리얼 I/O 가 여기저기 흩어진 채 전부 유닉스 전용이었다 —
//     · start-attacker.sh : `stty -f` + `exec 3<>/dev/cu.xxx` (WHOAMI 탐지·자가진단·모터정지)
//     · bridge.js         : `stty` + fs.createWriteStream("/dev/cu.xxx")
//   Windows 에는 stty 도 /dev/cu.* 도 없고, 포트 이름이 COM3 이라 `[ -e ]`·existsSync 가 전부
//   거짓이 되어 아두이노가 통째로 건너뛰어졌다. 그 구현들을 이 파일 하나로 모으고
//   OS 별 차이(포트 이름·설정 명령·열기 방식)를 여기서만 흡수한다.
//
// Windows 에서 특히 주의한 두 가지(둘 다 조용히 실패하는 함정):
//   ① COM 포트는 CreateFile 의 dwCreationDisposition 이 반드시 OPEN_EXISTING 이어야 한다.
//      Node 의 flags:"w" 는 O_CREAT|O_TRUNC → CREATE_ALWAYS 로 매핑돼 열기 자체가 실패한다.
//      그래서 Windows 에선 flags:"r+"(O_RDWR, 생성·절단 없음)로 연다.
//   ② COM10 이상은 "COM10" 이름으로 못 연다. 반드시 `\\.\COM10` 형태여야 한다.
//
// ── 라이브러리로 쓸 때 ───────────────────────────────────────────────────────
//   const S = require("./serial");
//   S.listPorts() · S.portExists(p) · S.configure(p, baud) · S.openWriter(p)
//
// ── CLI 로 쓸 때 (셸 스크립트용) ─────────────────────────────────────────────
//   node serial.js list                       후보 포트를 줄단위 출력
//   node serial.js boards                     "포트<TAB>FQBN" 줄단위 출력(arduino-cli 있으면 FQBN 포함)
//   node serial.js whoami <port> [baud]       WHOAMI 프로브 → antenna|solar|(빈 출력)
//   node serial.js cmd <port> <baud> <antenna|solar|any> <CMD>
//        역할이 맞을 때만 CMD 전송 + 응답 출력. 종료코드 3 = 그 역할의 보드가 아님.
//   node serial.js send <port> <baud> <ms:LINE> …   각 줄 전송 후 ms 대기
//        예) node serial.js send COM3 9600 2200: 400:TRACK 1600:"AZ 210" 3000:"AZEL 180 50"
//        · 'ms:' 뒤가 비면 '보내지 않고 대기만' — 보드 리셋(포트 열림) 대기용.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const DEFAULT_BAUD = 9600;

// ── 포트 이름 ────────────────────────────────────────────────────────────────
const isComName = (p) => /^COM\d+$/i.test(p || "");

// 실제로 열 때 쓰는 경로. Windows 는 COM10+ 를 위해 반드시 `\\.\COMx` 로 승격한다
// (COM1~9 는 짧은 이름도 되지만, 전부 같은 규칙으로 다루는 편이 사고가 없다).
function devicePath(p) {
  if (!IS_WIN) return p;
  if (isComName(p)) return "\\\\.\\" + p.toUpperCase();
  return p;
}

// 존재 확인. Windows 의 COM 이름은 파일시스템에 없으므로 existsSync 가 항상 false —
// 이름 형태로 판단한다(실제 유효성은 열어 봐야 안다).
function portExists(p) {
  if (!p) return false;
  if (IS_WIN) return isComName(p) || /^\\\\\.\\COM\d+$/i.test(p);
  try { return fs.existsSync(p); } catch { return false; }
}

// ── 포트 목록 ────────────────────────────────────────────────────────────────
function listPortsPosix() {
  try {
    return fs.readdirSync("/dev")
      .filter((f) =>
        /^cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)/.test(f) ||  // macOS(정품·CH340/CP210x 클론)
        /^tty(ACM|USB)\d+$/.test(f))                                        // Linux
      .map((f) => "/dev/" + f)
      .sort();
  } catch { return []; }
}

function listPortsWin() {
  // 레지스트리 SERIALCOMM 이 가장 정확하고 빠르다(현재 존재하는 COM 포트만 등재됨).
  try {
    const out = execFileSync("reg", ["query", "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const list = [...out.matchAll(/REG_SZ\s+(COM\d+)/gi)].map((m) => m[1].toUpperCase());
    if (list.length) return [...new Set(list)].sort();
  } catch { /* 레지스트리 접근 실패 → mode 폴백 */ }
  try {
    const out = execFileSync("cmd", ["/c", "mode"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set([...out.matchAll(/\b(COM\d+)\b/gi)].map((m) => m[1].toUpperCase()))].sort();
  } catch { return []; }
}

const listPorts = () => (IS_WIN ? listPortsWin() : listPortsPosix());

// ── 보드 목록(포트 + 추정 FQBN) ──────────────────────────────────────────────
// arduino-cli 가 있으면 그쪽이 정답이다 — 칩 종류와 무관하게 포트를 잡고, 정품 보드는 FQBN 까지
// 준다(예 MKR WiFi 1010 → arduino:samd:mkrwifi1010). FQBN 을 못 얻으면 업로드가 Uno 로 폴백돼
// 엉뚱한 보드에 잘못된 펌웨어를 굽게 되므로 중요하다.
//   ※ 예전에는 이 JSON 을 python3 로 파싱했는데, Windows 에는 'python3' 이름이 없는 설치가
//     흔해서(python.exe 만 있음) 조용히 폴백으로 떨어졌다. 이미 node 는 필수 의존성이므로 node 로 판다.
//   ※ arduino-cli 버전에 따라 '--json'(1.x) 과 '--format json'(구버전), 그리고 응답 형태
//     (detected_ports 객체 / 최상위 배열)가 갈려 둘 다 받아들인다.
function listBoards() {
  const out = runArduinoCliBoardList();
  const rows = out ? parseBoardList(out) : [];
  if (rows.length) return rows;
  return listPorts().map((address) => ({ address, fqbn: "" }));   // arduino-cli 없음 → 이름만
}

function runArduinoCliBoardList() {
  for (const args of [["board", "list", "--json"], ["board", "list", "--format", "json"]]) {
    try {
      const out = execFileSync("arduino-cli", args,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
      if (out && out.trim()) return out;
    } catch { /* 다음 형식 시도 */ }
  }
  return "";
}

function parseBoardList(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { return []; }
  const entries = Array.isArray(d) ? d : (d.detected_ports || []);
  const rows = [];
  for (const e of entries) {
    const p = e.port || e || {};
    if (p.protocol && p.protocol !== "serial") continue;
    const address = p.address || "";
    if (!address) continue;
    const props = p.properties || {};
    const boards = e.matching_boards || e.boards || [];
    const fqbn = (boards[0] && boards[0].fqbn) || "";
    // 블루투스·디버그 포트 같은 잡음 제외: 보드가 매칭됐거나, USB VID/PID 가 있거나, 이름이 USB 시리얼꼴.
    const base = address.split(/[\\/]/).pop();
    const usbish = IS_WIN
      ? isComName(base)
      : /^(cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)|tty(ACM|USB))/.test(base);
    if (boards.length || props.vid || props.pid || usbish) rows.push({ address, fqbn });
  }
  return rows;
}

// ── 포트 설정(보율·8N1·raw) ──────────────────────────────────────────────────
// Windows: mode.com 이 DCB 를 설정하고, 그 설정이 다음 열기의 기본값으로 남는다.
//   to=on(무한 타임아웃)은 '읽기'용이다 — to=off 면 ReadFile 이 0바이트로 즉시 반환할 수 있고,
//   Node 의 읽기 스트림은 0바이트 = EOF 로 보아 응답을 기다리지 않고 끝나 버린다(WHOAMI 실패).
//   반대로 쓰기 전용(브리지)은 to=off 가 안전하다 — 보드가 뽑혀도 WriteFile 이 영원히 안 막힌다.
// POSIX: macOS 는 stty -f, Linux 는 -F. 둘 다 시도한다.
function configure(port, baud = DEFAULT_BAUD, opts = {}) {
  const infinite = !!opts.infiniteTimeout;
  if (IS_WIN) {
    const m = String(port).match(/COM\d+/i);
    if (!m) return false;
    const com = m[0].toUpperCase();
    const args = ["/c", "mode", com + ":", `BAUD=${baud}`, "PARITY=n", "DATA=8", "STOP=1",
      "xon=off", "odsr=off", "octs=off", "rts=on", "dtr=on", `to=${infinite ? "on" : "off"}`];
    try { execFileSync("cmd", args, { stdio: "ignore" }); return true; } catch { return false; }
  }
  // clocal·-hupcl: 모뎀 제어선 무시 + 닫을 때 DTR 로 보드를 리셋하지 않게(불필요한 재부팅 방지)
  const sttyArgs = [String(baud), "cs8", "-cstopb", "-parenb", "-echo", "raw", "clocal", "-hupcl"];
  for (const flag of ["-f", "-F"]) {
    try { execFileSync("stty", [flag, port, ...sttyArgs], { stdio: "ignore" }); return true; } catch { /* 다른 플래그 시도 */ }
  }
  return false;
}

// ── 열기 ─────────────────────────────────────────────────────────────────────
// Windows 는 flags:"r+" 필수(위 주석 ① 참조). POSIX 는 기존 동작 그대로 "w".
function openWriter(port) {
  return fs.createWriteStream(devicePath(port), IS_WIN ? { flags: "r+" } : { flags: "w" });
}

function openReader(port) {
  return fs.createReadStream(devicePath(port), { flags: "r" });
}

// ── WHOAMI 역할 판별 ─────────────────────────────────────────────────────────
// 펌웨어가 심어 둔 ID 문자열로 보드 역할을 가른다(motor.sh · start-attacker.sh 와 동일 계약).
function parseRole(text) {
  if (/id\s*=\s*ANTENNA/i.test(text)) return "antenna";
  if (/id\s*=\s*SOLAR_PANEL/i.test(text) || /SOLAR\s+PANEL/i.test(text)) return "solar";
  return "";
}

// 역할 이름 → 응답에서 찾을 패턴. 'any' 는 아무 응답이나 허용.
const ROLE_PATTERN = { antenna: "ANTENNA", solar: "SOLAR", any: "." };

const BOOT_WAIT_MS = 2200;   // 포트 열림 = Uno 리셋 → 부트로더/USB 재열거 대기

// ── 세션: 열기 → 부팅대기 → WHOAMI → (역할 일치 시) 명령 전송 → 응답 수집 ──────
// whoami 도 motor.sh 의 명령 전송도 전부 이 한 흐름이다. 보드를 두 번 열면(=두 번 리셋)
// 느리고 모터가 덜컥거리므로, 판별과 전송을 '한 번의 열기' 안에서 끝낸다.

// Windows 경로: .NET System.IO.Ports.SerialPort 를 PowerShell 로 구동한다.
// Node 의 파일 스트림으로도 읽을 수는 있지만 COM 타임아웃 처리가 드라이버마다 제각각이라
// '응답이 없으면 영원히 멈추거나, 있는데도 즉시 EOF' 로 갈리기 쉽다. .NET SerialPort 는
// ReadTimeout 을 정확히 지켜 주므로 탐지 신뢰도가 훨씬 높다. 실패하면 Node 폴백으로 내려간다.
function psQuote(s) { return String(s).replace(/'/g, "''"); }   // PowerShell 홑따옴표 이스케이프

function winSession(port, baud, opts) {
  const { probeMs = 2500, command = "", readMs = 1500, requireRole = "any" } = opts || {};
  const com = (String(port).match(/COM\d+/i) || [""])[0].toUpperCase();
  if (!com) return null;
  const pattern = ROLE_PATTERN[requireRole] || ROLE_PATTERN.any;

  const lines = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$p = New-Object System.IO.Ports.SerialPort('${com}',${baud},'None',8,'One')`,
    "$p.ReadTimeout = 500",
    "$p.DtrEnable = $true",
    "$p.RtsEnable = $true",
    "try { $p.Open() } catch { exit 1 }",
    `Start-Sleep -Milliseconds ${BOOT_WAIT_MS}`,
    "$p.DiscardInBuffer()",
    "$p.WriteLine('WHOAMI')",
    "$role = ''",
    `$d1 = (Get-Date).AddMilliseconds(${probeMs})`,
    "while ((Get-Date) -lt $d1) {",
    "  $l = $null",
    "  try { $l = $p.ReadLine() } catch { continue }",
    "  if ($l) { Write-Output $l; if ($l -match 'ANTENNA|SOLAR') { $role = $l; break } }",
    "}",
  ];
  if (command) {
    lines.push(
      `if ($role -notmatch '${psQuote(pattern)}') { $p.Close(); exit 3 }`,   // 역할 불일치 → 명령 안 보냄
      `$p.WriteLine('${psQuote(command)}')`,
      `$d2 = (Get-Date).AddMilliseconds(${readMs})`,
      "while ((Get-Date) -lt $d2) {",
      "  $l = $null",
      "  try { $l = $p.ReadLine() } catch { continue }",
      "  if ($l) { Write-Output $l }",
      "}");
  }
  lines.push("$p.Close()");

  // -Command 로 넘기면 Node 의 Windows 인자 인용 규칙에 걸려 스크립트가 깨질 수 있다 →
  // 임시 .ps1 파일로 떨어뜨리고 -File 로 실행한다(-ExecutionPolicy Bypass 로 정책 우회).
  const tmp = path.join(os.tmpdir(), `demosat-serial-${process.pid}-${com}.ps1`);
  try {
    fs.writeFileSync(tmp, lines.join("\n"), "utf8");
    const out = execFileSync("powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        timeout: BOOT_WAIT_MS + probeMs + readMs + 8000 });
    return { text: out || "", matched: true };
  } catch (e) {
    if (e && e.status === 3) return { text: String(e.stdout || ""), matched: false };  // 역할 불일치
    return null;                                        // null = 이 경로 실패 → 폴백으로
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// POSIX 기본 경로(그리고 Windows 폴백): 포트를 읽기/쓰기로 열고 같은 연결에서 주고받는다.
function streamSession(port, baud, opts) {
  const { probeMs = 2500, command = "", readMs = 1500, requireRole = "any" } = opts || {};
  return new Promise((resolve) => {
    configure(port, baud, { infiniteTimeout: true });
    let reader = null, writer = null;
    let buf = "", role = "", sent = false, done = false, timer = null;
    const finish = () => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { if (reader) reader.destroy(); } catch {}
      try { if (writer) writer.end(); } catch {}
      resolve({ text: buf, matched: !command || sent });
    };
    const arm = (ms) => { if (timer) clearTimeout(timer); timer = setTimeout(finish, ms); };
    try { reader = openReader(port); writer = openWriter(port); }
    catch { return resolve(null); }
    reader.on("error", finish);
    writer.on("error", finish);
    reader.on("end", finish);
    reader.on("data", (c) => {
      buf += c.toString("latin1");
      if (role) return;
      role = parseRole(buf);
      if (!role) return;
      if (!command) return finish();                                  // whoami 만 필요했다
      if (requireRole !== "any" && role !== requireRole) return finish();   // 다른 보드 → 명령 금지
      sent = true;
      try { writer.write(command + "\n"); } catch {}
      arm(readMs);                                                    // 명령 응답을 잠깐 더 수집
    });
    setTimeout(() => { try { writer.write("WHOAMI\n"); } catch {} }, BOOT_WAIT_MS);
    arm(BOOT_WAIT_MS + probeMs);
  });
}

// 세션 실행: Windows 는 PowerShell 우선, 실패하면 스트림 폴백. 그 외는 스트림.
async function session(port, baud, opts) {
  if (!portExists(port)) return null;
  if (IS_WIN) {
    const r = winSession(port, baud, opts);
    if (r !== null) return r;
  }
  return streamSession(port, baud, opts);
}

async function whoami(port, baud = DEFAULT_BAUD, timeoutMs = 2500) {
  const r = await session(port, baud, { probeMs: timeoutMs });
  return r ? parseRole(r.text) : "";
}

// 역할이 맞는 보드에만 명령을 보내고 응답을 돌려준다(motor.sh 용).
// 반환: { text, matched } — matched=false 면 이 포트는 그 역할이 아니라 아무것도 안 보냈다는 뜻.
async function commandRole(port, baud, requireRole, command, readMs = 1500) {
  const r = await session(port, baud, { command, requireRole, readMs });
  return r || { text: "", matched: false };
}

// ── 줄 전송(자가진단·모터정지) ───────────────────────────────────────────────
// steps: [{ ms, line }] — line 을 쓰고 ms 만큼 기다린다. line 이 비면 '대기만'(보드 리셋 대기).
function sendSteps(port, baud, steps) {
  return new Promise((resolve) => {
    if (!portExists(port)) return resolve(false);
    configure(port, baud);
    let writer;
    try { writer = openWriter(port); } catch { return resolve(false); }
    let failed = false;
    writer.on("error", () => { failed = true; });
    let i = 0;
    const step = () => {
      if (failed || i >= steps.length) {
        try { writer.end(); } catch {}
        setTimeout(() => resolve(!failed), 250);   // 마지막 바이트가 빠져나갈 시간
        return;
      }
      const s = steps[i++];
      if (s.line) { try { writer.write(s.line + "\n"); } catch { failed = true; } }
      setTimeout(step, s.ms);
    };
    step();
  });
}

module.exports = {
  IS_WIN, DEFAULT_BAUD, isComName, devicePath, portExists,
  listPorts, listBoards, configure, openWriter, openReader, parseRole,
  session, whoami, commandRole, sendSteps,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fail = (msg) => { console.error("serial.js: " + msg); process.exit(2); };

  if (cmd === "list") {
    listPorts().forEach((p) => console.log(p));
    process.exit(0);
  } else if (cmd === "boards") {
    // 셸이 파싱하는 계약: "포트<TAB>FQBN" 한 줄에 하나 (FQBN 은 비어 있을 수 있다)
    listBoards().forEach((b) => console.log(b.address + "\t" + (b.fqbn || "")));
    process.exit(0);
  } else if (cmd === "whoami") {
    const port = rest[0]; const baud = +(rest[1] || DEFAULT_BAUD);
    if (!port) fail("usage: whoami <port> [baud]");
    whoami(port, baud).then((role) => { if (role) console.log(role); process.exit(0); });
  } else if (cmd === "cmd") {
    // cmd <port> <baud> <antenna|solar|any> <COMMAND …>
    // 역할이 맞을 때만 명령을 보낸다. 종료코드 3 = 이 포트는 그 역할이 아님(motor.sh 가 다음 포트로).
    const port = rest[0]; const baud = +(rest[1] || DEFAULT_BAUD);
    const role = (rest[2] || "any").toLowerCase();
    const line = rest.slice(3).join(" ").trim();
    if (!port || !line) fail("usage: cmd <port> <baud> <antenna|solar|any> <COMMAND>");
    commandRole(port, baud, role, line).then((r) => {
      if (r.text) process.stdout.write(r.text.replace(/\r/g, ""));
      process.exit(r.matched ? 0 : 3);
    });
  } else if (cmd === "send") {
    const port = rest[0]; const baud = +(rest[1] || DEFAULT_BAUD);
    if (!port) fail("usage: send <port> <baud> <ms:LINE> …");
    const steps = rest.slice(2).map((a) => {
      const m = String(a).match(/^(\d+):([\s\S]*)$/);
      return m ? { ms: +m[1], line: m[2] } : { ms: 0, line: String(a) };
    });
    sendSteps(port, baud, steps).then((ok) => process.exit(ok ? 0 : 1));
  } else {
    fail("unknown command '" + (cmd || "") + "' (list | whoami | send)");
  }
}
