#!/usr/bin/env python3
"""Own one booth service's process group, including children left by its shell.

Linux/WSL and other POSIX hosts only. No process-name or port-based termination.
"""
import os
import signal
import subprocess
import sys
import time


def main():
    if os.name != "posix" or len(sys.argv) < 2:
        print("Run the booth launcher inside Linux/WSL with a command to supervise.", file=sys.stderr)
        return 2
    stop_signal = 0

    def request_stop(signum, _frame):
        nonlocal stop_signal
        stop_signal = stop_signal or signum

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGHUP, request_stop)
    # Adopt and reap orphaned grandchildren on Linux rather than leaving zombies
    # with a container/WSL init that may not promptly reap them.
    subreaper = False
    if sys.platform.startswith("linux"):
        import ctypes
        subreaper = ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER

    if stop_signal:
        return 128 + stop_signal
    process = subprocess.Popen(sys.argv[1:], start_new_session=True)

    def reap():
        process.poll()
        if subreaper:
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    break
                if pid == process.pid:
                    process.returncode = os.waitstatus_to_exitcode(status)

    def group_exists():
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def send_group(signum):
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    cleanup_failed = False
    try:
        while not stop_signal and process.poll() is None:
            time.sleep(0.05)
        result = 128 + stop_signal if stop_signal else process.returncode
    finally:
        # Popen returns only after the new session is established, so cancellation
        # during startup cannot race a shell into an untracked process group.
        send_group(signal.SIGTERM)
        deadline = time.monotonic() + 3
        while group_exists() and time.monotonic() < deadline:
            reap()
            time.sleep(0.05)
        if group_exists():
            send_group(signal.SIGKILL)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            cleanup_failed = True
            print("Service did not exit after SIGKILL: PID %s" % process.pid, file=sys.stderr)
        if subreaper:
            deadline = time.monotonic() + 1
            while group_exists() and time.monotonic() < deadline:
                reap()
                time.sleep(0.02)
        reap()
        if group_exists():
            cleanup_failed = True
            print("Service process group still exists after cleanup: %s" % process.pid, file=sys.stderr)
    return 1 if cleanup_failed else (result if result >= 0 else 128 - result)


if __name__ == "__main__":
    sys.exit(main())
