# Scenario 1 and 4 booth launchers

Run these commands at the repository root inside Ubuntu/WSL. Scenario 2 and 3
continue through the original `run-booth.sh` supervisor, unchanged.

```bash
./run-booth.sh scn1           # prepare and start the recorded-downlink demo
./run-booth.sh scn4           # prepare and start both simulator screens
./run-booth.sh scn1 install   # prepare npm runtime modules and Docker images only
./run-booth.sh scn4 install   # prepare/repair the Python environment only
./run-booth.sh scn1 check     # check installed dependencies without starting services
./run-booth.sh scn4 check
./run-booth.sh scn1 up        # start using already prepared dependencies
./run-booth.sh scn4 up
```

Scenario 1 requires Python 3, Node.js, curl and a running Docker installation
with WSL integration. npm is needed when its runtime modules are missing.
The first preparation may download npm packages and build the GPredict/GNU Radio
images. Existing modules and images are reused. The bundled recording
`scenario1-eavsdrop-attack/signal/enigma34_downlink.cf32` must be present.
The guide opens at port 8080; the existing container interfaces use 16080/16081.
Optional Arduino hardware still uses the existing separate Windows launcher.

Scenario 4 uses the prerequisites in its [Setup Guide](../scenario4-constellation-chaos/docs/setup-guide.md).
It starts the victim on 4540, waits for readiness, and then starts the console
on 8000. `GS_HTTP_PORT` also supplies the default console `GS_URL`; an explicit
`GS_URL` remains respected. Its default setup does not need Docker.

Keep the launcher terminal open. Ctrl-C stops the services started by this launcher;
a startup/service failure also cleans up the partial run. `NO_OPEN=1` suppresses
browser opening. Participant resets remain handled by each scenario's application;
these launchers do not consume the restart flag used by scenarios 2 and 3.

Each service runs in its own POSIX process group under `booth-process.py`.
On Ctrl-C, TERM, terminal closure (HUP), or a service failure, the supervisor stops
the entire group, including children left behind by a shell. Children that ignore
TERM receive KILL after a three-second grace period. Linux also reaps adopted
descendants. Container startup commands are stopped before their containers are
removed. The launcher requires Linux/WSL Python; native Windows Python is rejected.
As with other process supervisors, an OS-level SIGKILL of the supervisor itself
cannot run its cleanup handler.

Offline launcher verification (stub services; no Docker builds or real services):

```bash
python3 tests/test_booth_scn14.py
python3 tests/test_booth_process_cleanup.py
```
