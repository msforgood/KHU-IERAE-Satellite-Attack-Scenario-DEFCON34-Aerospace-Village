# Isolated gpredict + noVNC. Nothing installs on the host — everything lives in
# this container. Streams the real gpredict UI to the browser at :6080.
#
# libfaketime + python3-ephem power the time-control server (:6079) that places
# DEMOSAT just before a grazing pass over the Las Vegas QTH (see control.py).
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gpredict xvfb x11vnc novnc websockify openbox ca-certificates \
      libfaketime python3 python3-ephem procps \
      xdotool scrot \
    && rm -rf /var/lib/apt/lists/*

ENV GEOM=1280x900x24 VNC_PORT=5900 WEB_PORT=6080 CTRL_PORT=6079 \
    ROTCTLD_HOST=host.docker.internal FAKETIME_FILE=/tmp/faketime.rc \
    PASS_LEAD=30 RESET_INTERVAL=300 MIN_PASS_ALT=15 MAX_PASS_ALT=45 \
    IN_RANGE_ELEV=0 AUTOPILOT=/autopilot.sh
COPY start.sh /start.sh
COPY control.py /control.py
COPY passloop.py /passloop.py
COPY autopilot.sh /autopilot.sh
RUN chmod +x /start.sh /autopilot.sh
EXPOSE 6080 6079
CMD ["/start.sh"]
