"""Linux lifecycle regressions using real launchers and inert loopback children.

Run in WSL/Linux: /usr/bin/python3 tests/test_booth_process_cleanup.py
No application code, Docker, uplink, package installer or production port is used.
The test runner adopts orphaned fixture descendants solely to reap them during
cleanup; assertions run before the independent emergency cleanup in ``finally``.
"""

from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


REPO = Path(__file__).resolve().parents[1]
SCENARIO = "scenario4-constellation-chaos"
PYTHON = "/usr/bin/python3"
SHUTDOWN_TIMEOUT = 8

INERT_CHILD = r'''import json, os, pathlib, signal, socket, time
role = os.environ.get("FIXTURE_ROLE", "attacker")
root = pathlib.Path(os.environ["FIXTURE_STATE"])
if role == "victim" and os.environ.get("FAIL_VICTIM") == "1":
    (root / "victim-failed").touch()
    raise SystemExit(9)
if role == "attacker" and os.environ.get("IGNORE_TERM") == "1":
    def ignore_term(signum, frame):
        (root / "attacker-term-received").touch()
    signal.signal(signal.SIGTERM, ignore_term)
else:
    signal.signal(signal.SIGTERM, lambda signum, frame: exit(0))
signal.signal(signal.SIGINT, lambda signum, frame: exit(0))
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(1)
record = {"pid": os.getpid(), "pgid": os.getpgrp(),
          "port": sock.getsockname()[1]}
pending = root / (role + ".pending")
pending.write_text(json.dumps(record))
pending.replace(root / (role + ".json"))
while not (root / (role + "-exit")).exists():
    time.sleep(0.02)
raise SystemExit(int(os.environ.get("CHILD_EXIT_CODE", "0")))
'''

# Only the preflight numpy import is faked. The real attacker shell still forks
# and waits for an actual /usr/bin/python3 app.py child, reproducing its topology.
VENV_PYTHON = '''#!/bin/bash
if [ "$#" = 2 ] && [ "$1" = -c ] && [ "$2" = 'import numpy' ]; then
    exit 0
fi
exec /usr/bin/python3 "$@"
'''

# Readiness is file based: the inert children only bind and sleep. Never contact
# any service, and never let the real attacker's free_port touch another process.
TOOL_STUB = r'''#!/usr/bin/python3
import os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ["FIXTURE_STATE"])
if name == "lsof":
    raise SystemExit(1)
if name == "curl":
    (root / "readiness-polled").touch()
    if os.environ.get("HOLD_READY") == "1":
        raise SystemExit(1)
    role = "victim" if "/api/state" in sys.argv[-1] else "attacker"
    raise SystemExit(0 if (root / (role + ".json")).exists() else 1)
(root / "unexpected-tool").write_text(name + " " + repr(sys.argv[1:]))
raise SystemExit(97)
'''


def process_identity(pid):
    """Include start time so a recycled PID cannot be killed or counted as ours."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (pid, fields[19]), fields[0], int(fields[2])
    except (FileNotFoundError, ProcessLookupError):
        return None


class Fixture:
    def __init__(self, testcase, root, **options):
        self.testcase = testcase
        self.root = root
        self.state = root / "state"
        self.state.mkdir()
        self.token = uuid.uuid4().hex
        self.known = set()
        self.processes = []
        self.output = None
        self.sentinel = None
        self.launcher = None
        for name in ("run-booth.sh", "common/booth-scn14.sh", "common/proc.sh",
                     f"{SCENARIO}/start-attacker.sh"):
            self.write(name, (REPO / name).read_text())
        supervisor = REPO / "common/booth-process.py"
        if supervisor.exists():
            self.write("common/booth-process.py", supervisor.read_text())
        self.write("inert.py", INERT_CHILD)
        self.write(f"{SCENARIO}/attacker/packet-generator/webapp/app.py", INERT_CHILD)
        self.write(f"{SCENARIO}/attacker/packet-generator/webapp/.venv/bin/python",
                   VENV_PYTHON)
        self.write(f"{SCENARIO}/start-victim.sh", '''#!/bin/bash
export FIXTURE_ROLE=victim
exec /usr/bin/python3 "$FIXTURE_ROOT/inert.py"
''')
        for tool in ("node", "curl", "lsof", "docker", "npm", "xdg-open"):
            self.write("bin/" + tool, TOOL_STUB)
        # Isolate inherited operator settings and use only distribution binaries.
        self.env = dict(PATH=str(root / "bin") + ":/usr/bin:/bin",
                        HOME=str(root), LANG="C.UTF-8", NO_OPEN="1",
                        ENABLE_BRIDGE="0", ENABLE_GPREDICT="0",
                        GS_HTTP_PORT="49151", BUILDER_PORT="49152",
                        UPLINK_OUT_DIR=str(root / "unused-output"),
                        FIXTURE_ROOT=str(root), FIXTURE_STATE=str(self.state),
                        BOOTH_TEST_OWNER=self.token, **options)
        # The advertised ports above are used only by the readiness stub; each
        # child atomically asks the kernel for its own unused loopback port.

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        path.chmod(0o755)

    def spawn(self, argv, env, output):
        process = subprocess.Popen(argv, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append(process)
        identity = process_identity(process.pid)
        if identity:
            self.known.add(identity[0])
        return process

    def start(self):
        sentinel_env = dict(self.env, FIXTURE_ROLE="sentinel")
        # Separate session and ownership token: it is intentionally unrelated to
        # the launcher's process tree despite running identical inert app code.
        sentinel_env.pop("BOOTH_TEST_OWNER")
        sentinel_app = self.root / SCENARIO / "attacker/packet-generator/webapp/app.py"
        self.sentinel = self.spawn([PYTHON, str(sentinel_app)],
                                   sentinel_env, subprocess.DEVNULL)
        self.wait_for(lambda: (self.state / "sentinel.json").exists(), "sentinel")
        self.output = (self.root / "launcher.log").open("w+")
        self.launcher = self.spawn(["/bin/bash", str(self.root / "run-booth.sh"),
                                    "scn4", "up"], self.env, self.output)

    def discover(self):
        marker = ("BOOTH_TEST_OWNER=" + self.token).encode() + b"\0"
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                owned = marker in (entry / "environ").read_bytes()
            except OSError:
                continue
            if owned:
                identity = process_identity(int(entry.name))
                if identity:
                    self.known.add(identity[0])

    def reap_adopted(self):
        direct = {p.pid for p in self.processes}
        for pid, started in self.known:
            if pid in direct:
                continue
            current = process_identity(pid)
            if current and current[0] == (pid, started) and current[1] == "Z":
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass

    def log(self):
        path = self.root / "launcher.log"
        return path.read_text() if path.exists() else ""

    def wait_for(self, predicate, description, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.discover()
            self.reap_adopted()
            if predicate():
                return
            time.sleep(0.02)
        self.testcase.fail(f"Timed out waiting for {description}\n{self.log()}")

    def ready(self):
        self.wait_for(lambda: "Ready. Keep this terminal open" in self.log(),
                      "both real launchers to become ready")
        self.testcase.assertIsNone(self.launcher.poll(), self.log())
        for role in ("victim", "attacker"):
            self.testcase.assertTrue((self.state / (role + ".json")).exists())
        # Prove the regression topology: the Python app is not the booth itself.
        self.testcase.assertNotEqual(self.record("attacker")["pid"], self.launcher.pid)

    def record(self, role):
        return json.loads((self.state / (role + ".json")).read_text())

    def owned_remaining(self):
        self.discover()
        self.reap_adopted()
        excluded = {self.sentinel.pid, self.launcher.pid}
        return [pid for pid, started in self.known if pid not in excluded
                and (current := process_identity(pid)) and current[0] == (pid, started)]

    def assert_stopped(self, expected=None):
        self.wait_for(lambda: self.launcher.poll() is not None, "booth shutdown",
                      timeout=SHUTDOWN_TIMEOUT)
        if expected is not None:
            self.testcase.assertEqual(self.launcher.returncode, expected, self.log())
        self.wait_for(lambda: not self.owned_remaining(),
                      "all owned descendants to exit", timeout=1)
        for role in ("victim", "attacker"):
            if (self.state / (role + ".json")).exists():
                with socket.socket() as probe:
                    # No clients ever connect, so there is no TIME_WAIT ambiguity.
                    probe.bind(("127.0.0.1", self.record(role)["port"]))
        self.testcase.assertIsNone(self.sentinel.poll(), "unrelated sentinel was killed")
        with socket.socket() as probe:
            with self.testcase.assertRaises(OSError):
                probe.bind(("127.0.0.1", self.record("sentinel")["port"]))
        self.testcase.assertFalse((self.state / "unexpected-tool").exists(), self.log())

    def cleanup(self):
        # Always run, including on assertion failure. Never use pkill, names or
        # production ports: only freshly verified fixture identities and groups.
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            self.discover()
            groups = set()
            for pid, started in list(self.known):
                current = process_identity(pid)
                if not current or current[0] != (pid, started):
                    continue
                groups.add(current[2])
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for group in groups:
                if group != os.getpgrp():
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            for process in self.processes:
                process.poll()
            self.reap_adopted()
            if not any((current := process_identity(pid)) and current[0] == (pid, start)
                       for pid, start in self.known):
                break
            time.sleep(0.02)
        if self.output:
            self.output.close()
        remaining = [pid for pid, start in self.known
                     if (current := process_identity(pid)) and current[0] == (pid, start)]
        self.testcase.assertEqual(remaining, [], "emergency fixture cleanup failed")


@unittest.skipUnless(sys.platform == "linux" and Path(PYTHON).exists(),
                     "requires Linux/WSL and /usr/bin/python3")
class BoothProcessCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # WSL PID 1 may not reap orphan zombies promptly. Adopt only this runner's
        # descendants, preserving the previous setting for unittest discovery.
        cls.libc = ctypes.CDLL(None, use_errno=True)
        cls.previous_subreaper = ctypes.c_int()
        if cls.libc.prctl(37, ctypes.byref(cls.previous_subreaper), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "PR_GET_CHILD_SUBREAPER failed")
        if cls.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")

    @classmethod
    def tearDownClass(cls):
        cls.libc.prctl(36, cls.previous_subreaper.value, 0, 0, 0)

    @contextmanager
    def fixture(self, **options):
        with tempfile.TemporaryDirectory(prefix="booth lifecycle ") as directory:
            fixture = Fixture(self, Path(directory), **options)
            try:
                fixture.start()
                yield fixture
            finally:
                fixture.cleanup()

    def test_term_cleans_real_attacker_child_and_preserves_sentinel(self):
        with self.fixture() as fixture:
            fixture.ready()
            fixture.launcher.send_signal(signal.SIGTERM)
            fixture.assert_stopped(143)

    def test_sigint_cleans_real_attacker_child(self):
        with self.fixture() as fixture:
            fixture.ready()
            fixture.launcher.send_signal(signal.SIGINT)
            fixture.assert_stopped(130)

    def test_terminal_hangup_cleans_real_attacker_child(self):
        with self.fixture() as fixture:
            fixture.ready()
            fixture.launcher.send_signal(signal.SIGHUP)
            fixture.assert_stopped(129)

    def test_victim_exit_stops_attacker(self):
        with self.fixture() as fixture:
            fixture.ready()
            (fixture.state / "victim-exit").touch()
            fixture.assert_stopped()
            self.assertNotEqual(fixture.launcher.returncode, 0, fixture.log())

    def test_attacker_failure_stops_victim(self):
        with self.fixture(CHILD_EXIT_CODE="9") as fixture:
            fixture.ready()
            (fixture.state / "attacker-exit").touch()
            fixture.assert_stopped()
            self.assertNotEqual(fixture.launcher.returncode, 0, fixture.log())

    def test_victim_startup_failure_exits_without_starting_attacker(self):
        with self.fixture(FAIL_VICTIM="1") as fixture:
            fixture.wait_for(lambda: (fixture.state / "victim-failed").exists(),
                             "victim startup failure")
            fixture.assert_stopped()
            self.assertNotEqual(fixture.launcher.returncode, 0, fixture.log())
            self.assertFalse((fixture.state / "attacker.json").exists())

    def test_term_ignoring_child_is_force_killed_within_bound(self):
        with self.fixture(IGNORE_TERM="1") as fixture:
            fixture.ready()
            started = time.monotonic()
            fixture.launcher.send_signal(signal.SIGTERM)
            fixture.assert_stopped(143)
            self.assertLess(time.monotonic() - started, SHUTDOWN_TIMEOUT)
            self.assertTrue((fixture.state / "attacker-term-received").exists(),
                            "child must receive TERM before forced cleanup")

    def test_cancellation_during_partial_startup(self):
        for signum, expected in ((signal.SIGTERM, 143), (signal.SIGINT, 130)):
            with self.subTest(signal=signum), self.fixture(HOLD_READY="1") as fixture:
                fixture.wait_for(lambda: (fixture.state / "victim.json").exists()
                                 and (fixture.state / "readiness-polled").exists(),
                                 "first child before readiness")
                fixture.launcher.send_signal(signum)
                fixture.assert_stopped(expected)
                self.assertFalse((fixture.state / "attacker.json").exists())

    def test_immediate_cancellation_leaves_no_processes(self):
        # Cover the exec/trap-registration window as well as partial startup.
        for delay in (0, 0.01, 0.04):
            with self.subTest(delay=delay), self.fixture() as fixture:
                time.sleep(delay)
                fixture.launcher.send_signal(signal.SIGTERM)
                fixture.assert_stopped()
                self.assertIn(fixture.launcher.returncode, (-signal.SIGTERM, 143))


if __name__ == "__main__":
    unittest.main(verbosity=2)
