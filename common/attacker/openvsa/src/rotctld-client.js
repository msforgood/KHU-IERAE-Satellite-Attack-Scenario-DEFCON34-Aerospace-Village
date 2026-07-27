// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

const WS_URL = "ws://localhost:4534";

/**
 * Opens a WebSocket connection to the rotctld bridge server and keeps it alive.
 * Updates the store whenever GPredict sends a new position or connection status.
 */
export function connectRotctld(store) {
  let ws = null;

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener("open", () => {
      store.setState((s) => ({ ...s, bridgeConnected: true }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "position") {
        store.setState((s) => ({
          ...s,
          azimuth: msg.az,
          elevation: msg.el,
          gpredictTime: msg.time ?? null,
        }));
      } else if (msg.type === "target") {
        store.setState((s) => ({ ...s, targetSat: msg.name }));
      } else if (msg.type === "location") {
        store.setState((s) => ({ ...s, lat: msg.lat, lon: msg.lon }));
      } else if (msg.type === "status") {
        store.setState((s) => ({
          ...s,
          gpredictConnected: msg.gpredictConnected,
        }));
      } else if (msg.type === "frequency") {
        store.setState((s) => ({
          ...s,
          frequency: msg.freqHz / 1e6,
          radioControlled: true,
        }));
      } else if (msg.type === "radioStatus") {
        store.setState((s) => ({
          ...s,
          radioConnected: msg.radioConnected,
          radioControlled: msg.radioConnected,
        }));
      }
    });

    ws.addEventListener("close", () => {
      store.setState((s) => ({
        ...s,
        bridgeConnected: false,
        gpredictConnected: false,
      }));
      // Auto-reconnect
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.addEventListener("error", () => {
      // handled by the 'close' event that follows
    });
  }

  // Forward uplink commands from the renderer to the bridge server
  window.addEventListener("uplink-transmit", ({ detail }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "uplink-transmit", ...detail }));
    }
  });

  connect();
}
