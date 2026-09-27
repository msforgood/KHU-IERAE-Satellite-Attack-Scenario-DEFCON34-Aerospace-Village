"""Offline installer regressions: python3 tests/test_start_attacker_installer_recovery.py.

Run under Linux/macOS/WSL with Bash. Every launcher runs in a temporary copy,
with fake package operations; the real-venv smoke test only uses bundled pip.
No application server, codec, browser, transmission, or system install runs.
"""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


LAUNCHER = Path(__file__).resolve().parents[1] / "start-attacker.sh"
BASH = shutil.which("bash")

FAKE_PYTHON = r'''
import json
import os
from pathlib import Path
import sys

state_path = Path(os.environ["INSTALLER_TEST_STATE"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
role = "system" if Path(sys.argv[0]).name == "python3" else "venv"
with Path(os.environ["INSTALLER_TEST_LOG"]).open("a") as log:
    log.write(json.dumps([role, args]) + "\n")

def save():
    state_path.write_text(json.dumps(state))

if role == "system":
    if args[:2] == ["-m", "venv"]:
        target = Path(args[2]) / "bin" / "python"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(Path(__file__).read_text())
        target.chmod(0o755)
        state["python_ok"] = state.get("repair_python_ok", True)
        state["is_venv"] = True
        state["pip_ok"] = state.get("repair_pip_ok", True) and not state.get("venv_fail")
        save()
        if state.get("venv_fail"):
            print("ensurepip is not available", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if args and args[0] == "-c":
        print(state.get("version", "3.10"))
        sys.exit(0)
else:
    if not state.get("python_ok", True):
        sys.exit(126)
    if args and args[0] == "-c":
        if "sys.prefix" in args[1]:
            sys.exit(0 if state.get("is_venv", True) else 1)
        if "import numpy" in args[1]:
            if not state.get("numpy_ok"):
                sys.exit(1)
            if "__version__" in args[1]:
                print("test-numpy")
            sys.exit(0)
    if args[:2] == ["-m", "pip"]:
        if not state.get("pip_ok"):
            sys.exit(1)
        if args[2:] == ["--version"]:
            print("pip test")
            sys.exit(0)
        if args[2:] == ["install", "--quiet", "--upgrade", "pip"]:
            if state.get("upgrade_fail"):
                print("test pip upgrade error", file=sys.stderr)
                sys.exit(1)
            sys.exit(0)
        if args[2:] == ["install", "--quiet", "numpy"]:
            if state.get("numpy_fail"):
                print("test numpy install error", file=sys.stderr)
                sys.exit(1)
            state["numpy_ok"] = True
            save()
            sys.exit(0)
    if args == ["packet-generator/tests/test_roundtrip.py"]:
        print("ALL PASSED")
        sys.exit(0)
    if args == ["app.py"]:
        sys.exit(0)
raise SystemExit("unexpected fake Python invocation: " + repr(args))
'''


@unittest.skipUnless(os.name == "posix" and BASH, "requires POSIX Bash (use WSL on Windows)")
class InstallerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="installer recovery ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.launcher = self.root / "start-attacker.sh"
        self.launcher.write_bytes(LAUNCHER.read_bytes())
        self.venv = self.root / "attacker/packet-generator/webapp/.venv"
        self.venv.parent.mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Restrict PATH so a missing-python test cannot find the host's Python.
        for command in ("dirname", "grep", "mkdir", "sleep"):
            (self.bin / command).symlink_to(shutil.which(command))
        self.fake = "#!" + sys.executable + "\n" + FAKE_PYTHON
        self.write_executable(self.bin / "python3", self.fake)
        self.state_path = self.root / "state.json"
        self.log_path = self.root / "calls.jsonl"
        self.state_path.write_text(json.dumps({"numpy_ok": False, "pip_ok": False}))
        self.env = dict(os.environ, PATH=str(self.bin), NO_OPEN="1",
                        ENABLE_BRIDGE="0", ENABLE_GPREDICT="0",
                        UPLINK_OUT_DIR=str(self.root / "output"),
                        INSTALLER_TEST_STATE=str(self.state_path),
                        INSTALLER_TEST_LOG=str(self.log_path),
                        PIP_NO_INDEX="1", PIP_DISABLE_PIP_VERSION_CHECK="1")
        for name in ("PYTHONHOME", "PYTHONPATH", "BASH_ENV"):
            self.env.pop(name, None)

    @staticmethod
    def write_executable(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o755)

    def state(self, **changes):
        value = json.loads(self.state_path.read_text())
        value.update(changes)
        self.state_path.write_text(json.dumps(value))

    def existing(self, **changes):
        self.write_executable(self.venv / "bin/python", self.fake)
        self.state(python_ok=True, is_venv=True, pip_ok=True, numpy_ok=True)
        self.state(**changes)

    def run_launcher(self, *mode, success=True):
        result = subprocess.run([BASH, str(self.launcher), *mode], cwd=self.root,
                                env=self.env, capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        if success:
            self.assertEqual(result.returncode, 0, output)
        else:
            self.assertNotEqual(result.returncode, 0, output)
        return output

    def calls(self):
        return [json.loads(line) for line in self.log_path.read_text().splitlines()]

    def assert_repaired(self):
        self.assertIn(["system", ["-m", "venv", "packet-generator/webapp/.venv"]], self.calls())

    def assert_no_package_install(self):
        self.assertFalse(any(args[:3] == ["-m", "pip", "install"] for _, args in self.calls()))

    def test_missing_venv_creates_and_installs(self):
        self.assertIn("setup done", self.run_launcher("install"))
        self.assert_repaired()
        self.assertIn(["venv", ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]], self.calls())
        self.assertIn(["venv", ["-m", "pip", "install", "--quiet", "numpy"]], self.calls())

    def test_empty_venv_repairs_without_removing_contents(self):
        self.venv.mkdir()
        sentinel = self.venv / "keep.txt"
        sentinel.write_text("preserve me")
        self.run_launcher("install")
        self.assert_repaired()
        self.assertEqual(sentinel.read_text(), "preserve me")

    def test_missing_python_repairs(self):
        self.venv.joinpath("bin").mkdir(parents=True)
        self.run_launcher("install")
        self.assert_repaired()

    def test_nonworking_python_triggers_repair(self):
        self.existing(python_ok=False)
        self.run_launcher("install")
        self.assert_repaired()

    def test_nonexecutable_python_triggers_repair(self):
        self.existing()
        (self.venv / "bin/python").chmod(0o644)
        self.run_launcher("install")
        self.assert_repaired()

    def test_python_outside_venv_is_detected_and_repaired(self):
        self.existing(is_venv=False)
        self.run_launcher("install")
        self.assert_repaired()

    def test_missing_pip_repairs_even_when_numpy_imports(self):
        self.existing(pip_ok=False)
        self.run_launcher("install")
        self.assert_repaired()
        self.assert_no_package_install()

    def test_failed_ensurepip_then_prerequisite_rerun_succeeds(self):
        self.state(venv_fail=True)
        output = self.run_launcher("install", success=False)
        self.assertIn("ensurepip is not available", output)
        self.assertIn("sudo apt install python3.10-venv", output)
        self.assertIn("rerun './start-attacker.sh install'", output)
        self.assertTrue((self.venv / "bin/python").exists())
        self.assert_no_package_install()
        self.state(venv_fail=False)
        self.run_launcher("install")
        self.assertTrue(json.loads(self.state_path.read_text())["numpy_ok"])

    def test_package_diagnostic_matches_selected_python(self):
        self.state(venv_fail=True, version="3.12")
        self.assertIn("sudo apt install python3.12-venv", self.run_launcher("install", success=False))

    def test_missing_python_has_prerequisite_diagnostic(self):
        (self.bin / "python3").unlink()
        self.assertIn("sudo apt install python3 python3-venv", self.run_launcher("install", success=False))

    def test_successful_venv_command_still_requires_working_python(self):
        self.state(repair_python_ok=False)
        self.assertIn("venv Python is not usable after setup", self.run_launcher("install", success=False))
        self.assert_no_package_install()

    def test_successful_venv_command_still_requires_working_pip(self):
        self.state(repair_pip_ok=False)
        self.assertIn("venv pip is not usable after setup", self.run_launcher("install", success=False))
        self.assert_no_package_install()

    def test_healthy_warm_path_checks_pip_without_installing(self):
        self.existing()
        self.assertIn("already present -> skip pip", self.run_launcher("install"))
        self.assertIn(["venv", ["-m", "pip", "--version"]], self.calls())
        self.assertTrue(all(role == "venv" for role, _ in self.calls()))
        self.assert_no_package_install()

    def test_pip_upgrade_failure_stops_before_numpy(self):
        self.existing(numpy_ok=False, upgrade_fail=True)
        output = self.run_launcher("install", success=False)
        self.assertIn("test pip upgrade error", output)
        self.assertIn("pip upgrade failed", output)
        self.assertNotIn(["venv", ["-m", "pip", "install", "--quiet", "numpy"]], self.calls())

    def test_numpy_install_failure_reports_error(self):
        self.existing(numpy_ok=False, numpy_fail=True)
        output = self.run_launcher("install", success=False)
        self.assertIn("test numpy install error", output)
        self.assertIn("numpy install failed", output)
        self.assertNotIn("setup done", output)

    def test_default_mode_stops_before_app_when_setup_fails(self):
        self.state(venv_fail=True)
        self.run_launcher(success=False)
        self.assertFalse(any(args == ["app.py"] for _, args in self.calls()))

    def test_existing_modes_remain_available(self):
        self.existing()
        self.assertIn("check passed", self.run_launcher("check"))
        self.run_launcher("up")
        self.run_launcher("all")
        self.run_launcher()  # default all
        self.assert_no_package_install()
        self.assertEqual(sum(args == ["app.py"] for _, args in self.calls()), 3)

    def test_real_without_pip_venv_repairs_offline_and_preserves_files(self):
        if importlib.util.find_spec("ensurepip") is None:
            self.skipTest("real smoke test needs this Python's venv/ensurepip package")
        (self.bin / "python3").unlink()
        (self.bin / "python3").symlink_to(sys.executable)
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(self.venv)], check=True)
        py = self.venv / "bin/python"
        site = Path(subprocess.check_output([str(py), "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], text=True).strip())
        (site / "numpy.py").write_text("__version__ = 'offline-test'\n")
        sentinel = self.venv / "keep.txt"
        sentinel.write_text("preserve me")
        output = self.run_launcher("install")
        self.assertIn("numpy offline-test already present -> skip pip", output)
        self.assertEqual(sentinel.read_text(), "preserve me")
        subprocess.run([str(py), "-m", "pip", "--version"], check=True, capture_output=True)
        self.assertNotIn("creating or repairing", self.run_launcher("install"))
        for missing in ("bin/python", "pyvenv.cfg"):
            with self.subTest(missing=missing):
                (self.venv / missing).unlink()
                self.assertIn("creating or repairing", self.run_launcher("install"))
                self.assertEqual(sentinel.read_text(), "preserve me")


if __name__ == "__main__":
    unittest.main(verbosity=2)
