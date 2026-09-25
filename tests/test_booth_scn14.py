"""Offline launcher tests. Run with python3 tests/test_booth_scn14.py in WSL/Linux.

All services, Docker, package operations and HTTP requests are replaced with stubs.
"""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "posix", "run in WSL/Linux")
class BoothTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="booth scripts ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.events = self.root / "events"
        for name in ["run-booth.sh", "common/booth-scn14.sh", "common/booth-process.py"]:
            self.write(name, (REPO / name).read_text())
        self.write("common/proc.sh", 'kill_shell_tree() { kill "$1" 2>/dev/null || true; }\r\n')
        self.env = dict(os.environ, PATH=str(self.root / "bin") + ":/usr/bin:/bin",
                        EVENTS=str(self.events), NO_OPEN="1")
        stub = '''#!/usr/bin/python3
import os,sys,pathlib
name=pathlib.Path(sys.argv[0]).name
if name=='python3' and len(sys.argv)>1 and sys.argv[1].endswith('booth-process.py'):
 os.execv('/usr/bin/python3',['/usr/bin/python3']+sys.argv[1:])
with open(os.environ['EVENTS'],'a') as f: f.write(name+' '+' '.join(sys.argv[1:])+'\\n')
if name=='node' and '-e' in sys.argv and os.environ.get('MISSING_DEPS')=='1': sys.exit(1)
if name=='docker' and sys.argv[1:3]==['image','inspect'] and os.environ.get('MISSING_IMAGES')=='1': sys.exit(1)
'''
        for name in ["node", "npm", "docker", "curl", "python3"]:
            self.write("bin/" + name, stub, executable=True)
        one = "scenario1-eavsdrop-attack"
        self.write(one + "/run/_common.sh", '''SCEN1="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTBASE="$SCEN1"
GP_IMG=gp-image; GN_IMG=gn-image; GP_NAME=gp-container; GN_NAME=gn-container
WEB_PORT=8080; GP_WEB_PORT=16080; GP_CTRL_PORT=16079; GN_WEB_PORT=16081; WS_PORT=4534
''')
        for name in ["vsa-bridge", "gpredict", "gnuradio", "web"]:
            self.write(one + "/run/" + name + ".sh", self.service(name, name in ["vsa-bridge", "web"]))
        (self.root / one / "vsa").mkdir()
        self.write(one + "/signal/enigma34_downlink.cf32", "fixture")
        four = "scenario4-constellation-chaos"
        self.write(four + "/start-victim.sh", self.service("victim", True))
        self.write(four + "/start-attacker.sh", self.service("attacker", False) + '''
if [ "${1:-}" = up ]; then trap 'exit 0' TERM INT; while true; do sleep 0.1; done; fi
''')

    def write(self, name, text, executable=False):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        if executable:
            p.chmod(0o755)

    def service(self, name, persistent):
        text = f'''#!/usr/bin/env bash
echo "{name} $* no_open=${{NO_OPEN:-}} gs=${{GS_URL:-}}" >> "$EVENTS"
[ "${{FAIL_SERVICE:-}}" != "{name}" ] || exit 9
'''
        if persistent:
            text += "trap 'exit 0' TERM INT\nwhile true; do sleep 0.1; done\n"
        return text

    def logged(self):
        return self.events.read_text() if self.events.exists() else ""

    def run_mode(self, *args, ok=True):
        result = subprocess.run(["bash", str(self.root / "run-booth.sh"), *args],
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def run_services(self, scenario, mode="up", expect_failure=False):
        p = subprocess.Popen(["bash", str(self.root / "run-booth.sh"), scenario, mode],
                             env=self.env, text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True)
        try:
            if expect_failure:
                output = p.communicate(timeout=8)[0]
                self.assertNotEqual(p.returncode, 0, output)
            else:
                end = time.monotonic() + 8
                marker = "attacker up" if scenario == "scn4" else "curl --fail --silent --max-time 2 http://localhost:16081/"
                while marker not in self.logged() and p.poll() is None and time.monotonic() < end:
                    time.sleep(.02)
                self.assertIn(marker, self.logged())
                p.terminate()
                p.communicate(timeout=8)
                self.assertEqual(p.returncode, 143)
        finally:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
                p.communicate()

    def test_scn4_prepare_and_check_do_not_start_services(self):
        self.run_mode("scn4", "install")
        self.run_mode("scn4", "check")
        log = self.logged()
        self.assertIn("attacker install", log)
        self.assertIn("attacker check", log)
        self.assertNotIn("victim ", log)
        self.assertNotIn("docker ", log)

    def test_scn4_default_prepares_then_starts_both_with_custom_victim_port(self):
        self.env["GS_HTTP_PORT"] = "58440"
        self.run_services("scn4", "all")
        log = self.logged()
        self.assertLess(log.index("attacker install"), log.index("victim "))
        self.assertLess(log.index("victim "), log.index("attacker up"))
        self.assertIn("attacker up no_open=1 gs=http://localhost:58440", log)

    def test_scn4_up_skips_installation(self):
        self.run_services("scn4")
        self.assertNotIn("attacker install", self.logged())

    def test_scn1_install_prepares_runtime_modules_and_images_only(self):
        self.env.update(MISSING_DEPS="1", MISSING_IMAGES="1")
        self.run_mode("scn1", "install")
        log = self.logged()
        self.assertIn("npm ci --omit=dev --no-audit --no-fund", log)
        self.assertIn("docker build -t gp-image", log)
        self.assertIn("docker build -t gn-image", log)
        self.assertNotIn("vsa-bridge ", log)
        self.assertNotIn("docker rm", log)

    def test_scn1_warm_prepare_reuses_dependencies(self):
        self.run_mode("scn1", "install")
        self.assertNotIn("npm ", self.logged())
        self.assertNotIn("docker build", self.logged())

    def test_scn1_up_starts_services_and_cleans_up_its_containers(self):
        self.run_services("scn1")
        for event in ["vsa-bridge ", "gpredict ", "gnuradio ", "web ",
                      "docker rm -f gp-container", "docker rm -f gn-container"]:
            self.assertIn(event, self.logged())

    def test_scn1_startup_failure_stops_partial_start(self):
        self.env["FAIL_SERVICE"] = "gpredict"
        self.run_services("scn1", expect_failure=True)
        self.assertNotIn("gnuradio ", self.logged())
        self.assertIn("docker rm -f gp-container", self.logged())
        self.assertNotIn("docker rm -f gn-container", self.logged())

    def test_help_and_invalid_mode_do_not_start_services(self):
        self.assertIn("scn1|scn2|scn3|scn4", self.run_mode("--help").stdout)
        self.run_mode("scn4", "bad-mode", ok=False)
        self.assertEqual(self.logged(), "")

    def test_scn1_health_waits_for_slow_container_and_rejects_http_errors(self):
        common = "scenario1-eavsdrop-attack/run/_common.sh"
        self.write(common, (REPO / common).read_text())
        self.write("bin/sleep", "#!/bin/bash\nexit 0\n", executable=True)
        self.write("bin/curl", '''#!/usr/bin/python3
import os,pathlib
p=pathlib.Path(os.environ['EVENTS'])
n=int(p.read_text())+1 if p.exists() else 1
p.write_text(str(n))
print('500' if os.environ.get('HTTP_ERROR') else ('000' if n<3 else '200'))
''', executable=True)
        command = ["bash", "-c", 'source "$1"; check_http 56080 fixture', "_", str(self.root/common)]
        good = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertEqual(self.events.read_text(), "3")
        self.events.unlink()
        bad = subprocess.run(command, env=dict(self.env, HTTP_ERROR="1"), capture_output=True, text=True, timeout=10)
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(self.events.read_text(), "30")


if __name__ == "__main__":
    unittest.main(verbosity=2)
