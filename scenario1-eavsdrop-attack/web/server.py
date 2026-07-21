#!/usr/bin/env python3
"""
ENIGMA-1 Downlink Decoder — Scenario 1 web interface (stdlib http.server, no pip deps)

시나리오 2(scn2)의 webapp 패턴(단일 파이썬 stdlib 서버 + templates/static)을 그대로 따르되,
UI 는 scenario2 packet-generator webapp 스타일로 새로 작성했다. 6개 phase 를 한 페이지에서
순차적으로 안내한다:

  PHASE 1  MISSION   위성 신호 수신이 목적 — 안테나 트랙킹 / RF 동기화 / 신호 복조 3단계 설명
  PHASE 2  TARGET    수신 대상 위성(ENIGMA-1) 제원 — VSA 로 확인한 정보
  PHASE 3  TRACK     제원(SAT info)을 상단에 띄운 채 GPredict(좌) + VSA(우) 를 웹으로 임베드
                     · GPredict 창 위에 Reset 버튼 + "Remaining time for communication with SAT"
  PHASE 4  PUZZLE    enigma1_decoder.grc 블록 연결을 퍼즐로 분해 → 사용자가 조립(정답/힌트 버튼)
  PHASE 5  FLOWGRAPH 실물 GNU Radio(noVNC) 로 정답 flowgraph 실행 → 복원 이미지 생성
  PHASE 6  RESULT    복원된 이미지(enigma1_image_org.png) 확인

이 서버는 렌더링과 정적 마운트만 담당한다:
  · scenario1 VSA(VSA-DEFCON2026) 를 /vsa/ 로 정적 마운트 + electronAPI shim 주입
    (일반 브라우저 iframe 에서도 IQ 로드가 되도록. ENIGMA-1 자동선택 + enigma34_downlink.cf32 자동로드)
  · GPredict / GNU Radio 는 환경변수 URL(noVNC)을 iframe 으로 임베드(없으면 안내 placeholder/폴백)
  · gpredict-web 의 time-control 서버(:6079)로 reset-pass / offset 을 프록시

실행:  python3 server.py            # → http://localhost:8080
환경변수:
  PORT          기본 8080
  GPREDICT_URL  GPredict 임베드용 noVNC URL (예: http://localhost:6080/vnc.html?autoconnect=1&resize=remote)
  GNURADIO_URL  GNU Radio Companion 임베드용 noVNC URL (예: http://localhost:6081/vnc.html?...)
  VSA_URL       VSA 임베드 URL (기본: /vsa/index.html — 이 서버가 정적 제공)
  GPREDICT_CONTROL_URL  gpredict-web time-control 서버 (기본 http://localhost:6079)
"""
import os
import sys
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCEN1 = os.path.abspath(os.path.join(HERE, ".."))          # scenario1-eavsdrop-attack/
STATIC_DIR = os.path.join(HERE, "static")
TEMPLATE = os.path.join(HERE, "templates", "index.html")
VSA_DIR = os.path.join(SCEN1, "VSA-DEFCON2026")
GRC_FILE = os.path.join(SCEN1, "postProcess", "enigma1_decoder.grc")
RESULT_IMG = os.path.join(SCEN1, "postProcess", "enigma1_image_org.png")
GRC_OUT_DIR = os.path.join(SCEN1, "gnuradio-out")   # gnuradio-web ▶ Run 결과 png 가 떨어지는 곳
# PHASE 4 에서 업로드한 녹음 → PHASE 5 실물 GNU Radio 의 File Source(gnuradio-web/run.sh 가 마운트).
UPLOAD_DIR = os.path.join(SCEN1, "gnuradio-web", "upload")
UPLOAD_CF32 = os.path.join(UPLOAD_DIR, "uploaded.cf32")
UPLOAD_META = os.path.join(UPLOAD_DIR, "uploaded.json")
UPLOAD_RATE = os.path.join(UPLOAD_DIR, "samp_rate.txt")
MAX_UPLOAD = 200 * 1024 * 1024   # 200 MB

# Per-satellite default IQ the browser VSA auto-loads (see the electronAPI shim).
IQ_FILES = {
    "ENIGMA-1": os.path.join(SCEN1, "enigma34_downlink.cf32"),
}
QTH_FILE = os.path.join(SCEN1, "gpredict-config", "defcon.qth")
ENIGMA_TLE_FILE = os.path.join(SCEN1, "gpredict-config", "enigma1.tle")

PORT = int(os.environ.get("PORT", "8080"))
GPREDICT_URL = os.environ.get("GPREDICT_URL", "")
GNURADIO_URL = os.environ.get("GNURADIO_URL", "")
VSA_URL = os.environ.get("VSA_URL", "/vsa/index.html")
GPREDICT_CONTROL_URL = os.environ.get("GPREDICT_CONTROL_URL", "http://localhost:6079")


def read_qth():
    """Ground-station location from gpredict-config/defcon.qth (lon +E). The VSA
    shim and the Phase-3 'remaining time' countdown use this so the observer matches
    gpredict's."""
    lat, lon, alt, name = 36.12881986648643, -115.15156849623858, 620.0, "DEFCON Booth"
    try:
        for line in open(QTH_FILE, encoding="utf-8"):
            if line.startswith("LAT="):
                lat = float(line.split("=", 1)[1])
            elif line.startswith("LON="):
                lon = float(line.split("=", 1)[1])
            elif line.startswith("ALT="):
                alt = float(line.split("=", 1)[1])
            elif line.startswith("LOCATION="):
                name = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return {"lat": lat, "lon": lon, "alt": alt, "name": name}


def read_enigma_tle():
    try:
        lines = [l.rstrip("\n") for l in open(ENIGMA_TLE_FILE, encoding="utf-8") if l.strip()]
        return lines[:3]
    except OSError:
        return []


# ── ENIGMA-1 dossier — scenario1 VSA(satellite-info.js)에서 확인한 제원 ────────────
SATELLITE = {
    "name": "ENIGMA-1",
    "status": "Active",
    "tagline": "LEO Earth-observation cubesat · AX.25 image beacon (G3RUH 9600)",
    "identity": {
        "NORAD Catalog ID": "90001",
        "Type": "Earth-observation cubesat (LEO)",
        "Regime": "Sun-synchronous · 98.5° inclination",
    },
    "rf": {
        "Downlink freq": "433.500 MHz (UHF)",
        "Modulation": "GFSK, Gaussian BT = 0.5",
        "Symbol rate": "9600 baud",
        "Deviation": "±2.4 kHz (h = 0.5)",
        "Occupied BW": "~14 kHz",
        "Polarization": "RHCP",
        "Framing": "AX.25 UI · G3RUH scrambler (1+x^12+x^17) · HDLC · CRC-16",
    },
    "sdr": {
        "Center frequency": "433.500 MHz",
        "Sample rate": "0.096 MSps",
        "Display bandwidth": "0.096 MHz",
        "Gain": "20 – 30 dB",
        "Antenna": "70-cm Helix, RHCP, ≥10 dBi",
    },
    "passes": {
        "Doppler shift @433.5 MHz": "±10 kHz peak",
        "Doppler rate at TCA": "~−110 Hz/s",
    },
    "tle": [
        "ENIGMA-1",
        "1 90001U 26200A   26195.00000000  .00001500  00000-0  70000-4 0  1004",
        "2 90001  98.5000 100.0000 0010000  90.0000 270.0000 16.40000000  1006",
    ],
    "notes": [
        "Continuous, unencrypted AX.25 UI beacon — a passive-intercept target. No uplink, no command interface.",
        "Broadcasts a packetized image across ~29 AX.25 frames on a 7.22 s loop; one capture spanning a full burst is enough to decode.",
        "Decode with gr-satellites: FSK demodulator (9600 baud) → AX.25 deframer (G3RUH scrambler on) → reassemble the Info fields by sequence number.",
        "Sun-synchronous 98.5° inclination → visible from any latitude; only the pass times differ.",
        "Its TLE is installed into GPredict so GPredict can track it and drive the rotator over rotctld/rigctld.",
    ],
}

# electronAPI + IQ shim injected into /vsa/index.html so the VSA works in a plain
# browser iframe (it normally loads IQ via Electron's window.electronAPI, absent here).
# It (1) provides loadIQFile()/getSatPosition()/getQTH() over HTTP + satellite.js,
# (2) auto-selects ENIGMA-1 and auto-loads its default recording, (3) tunes the SDR
# to the satellite centre so a signal appears without manual steps.
VSA_IQ_SHIM = """
<style id="vsa-embed-fit">
  /* iframe 임베드용: VSA 기본 레이아웃(controls 좌 / scene 우)을 좁은 폭에서도 유지.
     VSA styles.css 의 @media(max-width:860px) 단일컬럼 붕괴를 무력화하고 사이드바를 좁힘. */
  html, body { overflow: hidden !important; height: 100dvh !important; }
  .app-layout { grid-template-columns: 236px minmax(0,1fr) !important;
    grid-template-rows: 1fr !important; height: 100dvh !important; overflow: hidden !important; }
  .panel--controls { border-right: 1px solid #2e3f50 !important; border-bottom: none !important;
    padding: 12px 10px !important; gap: 7px !important; }
  .panel--scene { min-width: 0 !important; }
  /* 좁아진 사이드바에서 입력/슬라이더가 넘치지 않게 */
  .panel--controls input, .panel--controls select { max-width: 100% !important; }
</style>
<script src="/static/vendor/satellite.min.js"></script>
<script>
(function(){
  var QTH=null, TLES={}, fakeOffsetMs=0, CENTER_HZ={'ENIGMA-1':433.5e6};
  function ingestQTH(a){ if(a&&a[0]){ QTH=a[0];
    if(a[0].tle && a[0].tle.length>=3) TLES[a[0].tle[0].trim()]=[a[0].tle[1],a[0].tle[2]]; } }
  fetch('/api/qth').then(function(r){return r.json();}).then(ingestQTH).catch(function(){});
  // poll gpredict's faketime offset so VSA computes the sat at the SAME time as gpredict
  (function poll(){ fetch('/api/offset').then(function(r){return r.json();})
    .then(function(j){ if(j&&typeof j.offsetMs==='number') fakeOffsetMs=j.offsetMs; })
    .catch(function(){}).then(function(){ setTimeout(poll,2500); }); })();

  function satPos(satName, lat, lon){
    var S=window.satellite; if(!S) return null;
    var tle=TLES[satName]; if(!tle){ var k=Object.keys(TLES); if(k.length) tle=TLES[k[0]]; }
    if(!tle) return null;
    try{
      var t=new Date(Date.now()+fakeOffsetMs);
      var rec=S.twoline2satrec(tle[0],tle[1]);
      var pv=S.propagate(rec,t); if(!pv||!pv.position) return null;
      var ecf=S.eciToEcf(pv.position,S.gstime(t));
      var obs={longitude:S.degreesToRadians(lon),latitude:S.degreesToRadians(lat),height:0.01};
      var look=S.ecfToLookAngles(obs,ecf);
      var t2=new Date(t.getTime()+1000);
      var pv2=S.propagate(rec,t2); var ecf2=S.eciToEcf(pv2.position,S.gstime(t2));
      var e2=0.00669437999014, a=6378.137, latr=obs.latitude, lonr=obs.longitude, h=obs.height;
      var Nn=a/Math.sqrt(1-e2*Math.pow(Math.sin(latr),2));
      var o={x:(Nn+h)*Math.cos(latr)*Math.cos(lonr),y:(Nn+h)*Math.cos(latr)*Math.sin(lonr),z:(Nn*(1-e2)+h)*Math.sin(latr)};
      function d(p,q){return Math.sqrt(Math.pow(p.x-q.x,2)+Math.pow(p.y-q.y,2)+Math.pow(p.z-q.z,2));}
      var rr=d(ecf2,o)-d(ecf,o);
      var dop=-(CENTER_HZ[satName]||433.5e6)*rr/299792.458;
      return {az:S.radiansToDegrees(look.azimuth), el:S.radiansToDegrees(look.elevation),
              rangeKm:look.rangeSat, dopplerHz:dop};
    }catch(e){ return null; }
  }

  var __recBuf = [];   // 브라우저 IQ 녹음 누적 (cf32 청크)
  if (!window.electronAPI) {
    window.electronAPI = {
      loadIQFile: async (satName) => {
        const r = await fetch('/vsa-iq/' + encodeURIComponent(satName) + '.cf32', {cache:'no-store'});
        if (!r.ok) throw new Error('no default IQ for ' + satName);
        const ab = await r.arrayBuffer();
        return { bytes: new Uint8Array(ab), path: 'default IQ · ' + satName + ' (' + ab.byteLength + ' B)' };
      },
      getQTH: async () => { if(!QTH){ try{ ingestQTH(await (await fetch('/api/qth')).json()); }catch(e){} }
                            return QTH ? [{lat:QTH.lat, lon:QTH.lon, name:QTH.name}] : []; },
      getSatPosition: async (satName, lat, lon) => satPos(satName, lat, lon),
      // ── 브라우저 IQ 녹음: 청크를 모아 REC 종료 시 cf32(+SigMF 메타)로 다운로드 ──
      chooseRecDir: async () => null,
      recStart: async () => { __recBuf = []; return {}; },
      recChunk: async (bytes) => { __recBuf.push(new Uint8Array(bytes)); return {}; },
      recStop: async (filename, meta) => {
        var total = 0, i;
        for (i = 0; i < __recBuf.length; i++) total += __recBuf[i].length;
        var all = new Uint8Array(total), off = 0;
        for (i = 0; i < __recBuf.length; i++) { all.set(__recBuf[i], off); off += __recBuf[i].length; }
        __recBuf = [];
        var name = filename || ('vsa_recording_' + Date.now() + '.cf32');
        function dl(blob, fn) { var u = URL.createObjectURL(blob); var a = document.createElement('a');
          a.href = u; a.download = fn; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function(){ URL.revokeObjectURL(u); }, 6000); }
        dl(new Blob([all], {type:'application/octet-stream'}), name);                          // IQ (cf32)
        try { if (meta) dl(new Blob([JSON.stringify(meta, null, 2)], {type:'application/json'}),
                          name.replace(/\\.cf32$/, '') + '.sigmf-meta.json'); } catch(e){}      // 메타데이터
        return '\\u2b07 다운로드됨: ' + name + ' (' + all.length + ' B, cf32) — 브라우저 Downloads 폴더';
      },
      onQTHUpdated: () => {}, decodeUplink: async () => ({}),
      chooseUplinkFile: async () => null, getUplinkFlag: async () => null,
      getSatelliteConfig: async () => null,
    };
  }
  function feed(bytes, label, satName){
    window.dispatchEvent(new CustomEvent('iq-stop'));
    window.dispatchEvent(new CustomEvent('iq-start', {detail:{bytes, satName}}));
    var s=document.getElementById('vsa-iq-status'); if(s) s.textContent='\\u25B6 '+label;
  }
  function selectEnigma(){
    // auto-select ENIGMA-1 in the satellite dropdown (VSA renderer builds #ctrl-sat)
    var el=document.getElementById('ctrl-sat')||document.querySelector('select');
    if(el){
      for(var i=0;i<el.options.length;i++){
        if(/enigma/i.test(el.options[i].value)||/enigma/i.test(el.options[i].textContent)){
          if(el.selectedIndex!==i){ el.selectedIndex=i; el.dispatchEvent(new Event('change',{bubbles:true})); }
          return el.options[i].value;
        }
      }
    }
    return (el&&el.value)||'ENIGMA-1';
  }
  function curSat(){ var el=document.getElementById('ctrl-sat')||document.querySelector('select');
    return (el&&el.value)||'ENIGMA-1'; }

  window.addEventListener('DOMContentLoaded', function(){
    var bar=document.createElement('div');
    bar.style.cssText='position:fixed;left:12px;bottom:12px;z-index:99999;display:flex;gap:10px;'
      +'align-items:center;background:rgba(15,22,32,.92);border:1px solid #1e2b3a;border-radius:9px;'
      +'padding:9px 12px;font:12px ui-monospace,monospace;color:#c7d3e0';
    bar.innerHTML='<b style="color:#39c5ff;letter-spacing:.1em">IQ</b>'
      +'<button id="vsa-iq-default" style="cursor:pointer;background:#39c5ff;color:#001018;border:0;'
      +'border-radius:6px;padding:5px 10px;font:inherit;font-weight:700">\\uAE30\\uBCF8 \\uB85C\\uB4DC</button>'
      +'<label style="cursor:pointer;color:#39c5ff;border:1px solid #1e2b3a;border-radius:6px;padding:5px 10px">'
      +'\\uB85C\\uCEEC .cf32<input id="vsa-iq-file" type="file" accept=".cf32,.bin,.iq" style="display:none"></label>'
      +'<span id="vsa-iq-status" style="color:#7f92a6"></span>';
    document.body.appendChild(bar);
    document.getElementById('vsa-iq-default').onclick=async function(){ await autoLoad(); };
    document.getElementById('vsa-iq-file').onchange=function(ev){
      var f=ev.target.files[0]; if(!f) return;
      var rd=new FileReader();
      rd.onload=function(){ feed(new Uint8Array(rd.result), f.name+' ('+f.size+' B)', curSat()); };
      rd.readAsArrayBuffer(f);
    };

    async function autoLoad(){
      var sat=curSat();
      try{ var r=await window.electronAPI.loadIQFile(sat); feed(r.bytes,r.path,sat); }
      catch(e){ var s=document.getElementById('vsa-iq-status'); if(s) s.textContent='\\u2717 '+e.message; }
    }
    function setInput(id, val){
      var el=document.getElementById(id); if(!el) return;
      el.value=String(val); el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    // auto-select ENIGMA-1, tune to its centre + usable gain, and auto-load its IQ
    setTimeout(function(){
      selectEnigma();             // ENIGMA-1 자동 선택 (freq/gain 은 VSA store 기본값 0 유지)
      autoLoad();                 // 입력 파일(enigma34_downlink.cf32) 자동 선택
      var rl=document.getElementById('rec-dir-label');   // 웹에선 폴더가 아니라 브라우저 다운로드
      if(rl){ rl.textContent='브라우저 Downloads'; rl.title='웹에서는 REC 종료 시 브라우저 다운로드로 저장됩니다'; }
    }, 1800);
    // ENIGMA-1 위성 선택만 유지 — freq/gain 은 사용자가 입력한 값을 존중(강제 안 함)
    setInterval(function(){
      var sel=document.getElementById('ctrl-sat');
      if(sel && !/enigma/i.test(sel.value||'')) selectEnigma();
    }, 1500);
  });
})();
</script>
"""

MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
}


def mime_for(path):
    return MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def read_grc():
    try:
        with open(GRC_FILE, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return "# enigma1_decoder.grc not found"


def latest_decoded():
    """gnuradio-out/ 에서 가장 최근 .png 경로 (없으면 None). gnuradio-web ▶ Run 산출물."""
    best = None
    try:
        for f in os.listdir(GRC_OUT_DIR):
            if f.lower().endswith(".png"):
                fp = os.path.join(GRC_OUT_DIR, f)
                m = os.path.getmtime(fp)
                if best is None or m > best[1]:
                    best = (fp, m)
    except OSError:
        pass
    return best


def uploaded_status():
    """PHASE 4 에서 업로드된 녹음(있으면 PHASE 5 File Source)의 상태."""
    try:
        if os.path.isfile(UPLOAD_CF32):
            meta = {}
            try:
                with open(UPLOAD_META, encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                meta = {}
            size = os.path.getsize(UPLOAD_CF32)
            return {"exists": True, "name": meta.get("name", "uploaded.cf32"),
                    "size": size, "samples": size // 8,
                    "sampleRate": int(meta.get("sampleRate", 50000)),
                    "uploadedAt": meta.get("uploadedAt", os.path.getmtime(UPLOAD_CF32))}
    except OSError:
        pass
    return {"exists": False}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8", json.dumps(obj).encode())

    def _file(self, fp):
        if os.path.isfile(fp):
            with open(fp, "rb") as f:
                return self._send(200, mime_for(fp), f.read())
        self._send(404, "text/plain; charset=utf-8", b"not found")

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            return self._file(TEMPLATE)

        if path == "/api/config":
            return self._json({
                "gpredictUrl": GPREDICT_URL,
                "gnuradioUrl": GNURADIO_URL,
                "vsaUrl": VSA_URL,
            })
        if path == "/api/satellite":
            return self._json(SATELLITE)
        if path == "/api/grc":
            return self._json({"filename": os.path.basename(GRC_FILE), "text": read_grc()})
        # GS location + ENIGMA-1 TLE for the browser VSA + Phase-3 remaining-time countdown.
        if path == "/api/qth":
            q = read_qth()
            return self._json([{"lat": q["lat"], "lon": q["lon"], "alt": q["alt"],
                                "name": q["name"], "tle": read_enigma_tle()}])

        # proxy to gpredict-web time-control server (reset to next pass / faked offset)
        if path in ("/api/reset-pass", "/api/realtime", "/api/offset", "/api/remaining"):
            import urllib.request
            target = GPREDICT_CONTROL_URL.rstrip("/") + path.replace("/api", "")
            try:
                with urllib.request.urlopen(target, timeout=8) as r:
                    return self._send(r.status, "application/json; charset=utf-8", r.read())
            except Exception as e:
                return self._json({"ok": False, "error": f"gpredict control unreachable: {e}"}, 502)

        if path == "/assets/result.png":
            return self._file(RESULT_IMG)

        # 실물 GNU Radio 출력(gnuradio-out/*.png) — 있으면 재조합 패널이 실사용
        if path == "/api/decoded":
            d = latest_decoded()
            return self._json({"exists": bool(d), "name": os.path.basename(d[0]) if d else None,
                               "mtime": d[1] if d else 0})
        # PHASE 4 업로드 녹음 상태(= PHASE 5 GNU Radio File Source)
        if path == "/api/upload":
            return self._json(uploaded_status())
        if path == "/decoded.png":
            d = latest_decoded()
            if d:
                return self._file(d[0])
            return self._send(404, "text/plain; charset=utf-8", b"no output")

        # Default IQ recording for the browser VSA (per-satellite).
        if path.startswith("/vsa-iq/"):
            sat = os.path.splitext(path[len("/vsa-iq/"):])[0]
            fp = IQ_FILES.get(sat) or IQ_FILES.get("ENIGMA-1")
            if fp and os.path.isfile(fp):
                with open(fp, "rb") as f:
                    return self._send(200, "application/octet-stream", f.read())
            return self._send(404, "text/plain; charset=utf-8", b"no IQ")

        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            fp = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if fp.startswith(STATIC_DIR):
                return self._file(fp)
            return self._send(403, "text/plain; charset=utf-8", b"forbidden")

        # Mount the scenario1 VSA app as static files so it can be iframed. index.html
        # gets the electronAPI/IQ shim injected so it runs in a plain browser.
        if path.startswith("/vsa/"):
            rel = path[len("/vsa/"):] or "index.html"
            fp = os.path.normpath(os.path.join(VSA_DIR, rel))
            if not fp.startswith(VSA_DIR) or not os.path.isfile(fp):
                return self._send(404, "text/plain; charset=utf-8", b"not found")
            if os.path.basename(fp) == "index.html":
                with open(fp, "rb") as f:
                    html = f.read()
                if b"</body>" in html:
                    html = html.replace(b"</body>", VSA_IQ_SHIM.encode() + b"</body>", 1)
                else:
                    html += VSA_IQ_SHIM.encode()
                return self._send(200, "text/html; charset=utf-8", html)
            return self._file(fp)

        self._send(404, "text/plain; charset=utf-8", b"not found")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/upload":
            return self._handle_upload()
        self._send(404, "text/plain; charset=utf-8", b"not found")

    def _handle_upload(self):
        """PHASE 4 업로드 녹음(.cf32)을 gnuradio-web/upload/ 에 저장 → PHASE 5 File Source."""
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        name = os.path.basename((q.get("name", ["uploaded.cf32"])[0]))[:200] or "uploaded.cf32"
        try:
            rate = int(q.get("sampleRate", ["50000"])[0])
        except ValueError:
            rate = 50000
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            return self._json({"ok": False, "error": "invalid content-length"}, 400)
        buf = bytearray()
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            buf += chunk
            remaining -= len(chunk)
        if len(buf) < 4096 or len(buf) % 8 != 0:
            return self._json({"ok": False, "error": "not a complex float32 (cf32) IQ file"}, 400)
        try:
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            with open(UPLOAD_CF32, "wb") as f:
                f.write(buf)
            meta = {"name": name, "size": len(buf), "samples": len(buf) // 8,
                    "sampleRate": rate, "uploadedAt": time.time()}
            with open(UPLOAD_META, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            with open(UPLOAD_RATE, "w", encoding="utf-8") as f:
                f.write(str(rate))
        except OSError as e:
            return self._json({"ok": False, "error": f"save failed: {e}"}, 500)
        st = uploaded_status()
        st["ok"] = True
        return self._json(st)


def main():
    # Windows consoles default to a legacy codec (cp949/cp1252) that can't encode the
    # log glyphs; force UTF-8 and never let a print() crash the server.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    print(f"ENIGMA-1 Downlink Decoder (Scenario 1) -> http://localhost:{PORT}")
    print(f"  Virtual Antenna mounted at  /vsa/   (from {VSA_DIR})")
    print(f"  GPredict embed: {GPREDICT_URL or '(none - placeholder/polar-preview shown)'}")
    print(f"  GNURadio embed: {GNURADIO_URL or '(none - static answer flowgraph rendered)'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[guide] 종료")
        sys.exit(0)
