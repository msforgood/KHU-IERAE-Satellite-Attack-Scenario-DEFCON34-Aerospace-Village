# Isolated gpredict + noVNC. Nothing installs on the host — everything lives in
# this container. Streams the real gpredict UI to the browser at :6080.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gpredict xvfb x11vnc novnc websockify openbox ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV GEOM=1280x900x24 VNC_PORT=5900 WEB_PORT=6080 ROTCTLD_HOST=host.docker.internal
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 6080
CMD ["/start.sh"]
