# Isolated GNU Radio Companion + noVNC. Nothing installs on the host — everything
# lives in this container. Streams the REAL GNU Radio Companion GTK UI to the
# browser at :6081, opened on the answer flowgraph enigma1_decoder.grc.
# (Scenario 1 · ENIGMA-1 decoder — same pattern as gpredict-web.)
#
# Ubuntu 24.04 ships GNU Radio 3.10.9 (≥ the .grc's 3.10.7 → blocks_throttle2 present).
FROM ubuntu:24.04

# gnuradio = GRC + core blocks; gr-satellites = FSK Demodulator / AX.25 Deframer.
# gir1.2-gtk-3.0 + python3-gi = the GTK3 bindings GRC's GUI needs (without these
# gnuradio-companion fails "Namespace Gtk not available" and shows a black screen).
# dbus-x11 = session bus for GtkApplication. xvfb/x11vnc/novnc/websockify/openbox
# = the headless X + web stream.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      gnuradio gr-satellites python3-pil \
      gir1.2-gtk-3.0 python3-gi python3-gi-cairo gir1.2-pango-1.0 gir1.2-gdkpixbuf-2.0 \
      dbus-x11 xterm xvfb x11vnc novnc websockify openbox ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV GEOM=1600x1000x24 VNC_PORT=5900 WEB_PORT=6081 GRC_FILE=/grc/enigma1_decoder.grc
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 6081
CMD ["/start.sh"]
