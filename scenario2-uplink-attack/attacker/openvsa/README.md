<p align="center">
  <img src="logo.png" alt="OpenVSA" width="200" />
</p>

<h1 align="center">OpenVSA</h1>

<p align="center"><strong>Open Virtual Satellite Antenna</strong> — A virtual ground station simulator with 3D antenna visualization, satellite tracking, uplink/downlink simulation, and SDR waterfall display.</p>

Load IQ signal files, track satellites with GPredict, simulate uplink commands, and visualize RF reception in real time.

## Features

- **3D Antenna Visualization** — Real-time rendered yagi, dish, dipole, and helix antennas with azimuth/elevation control
- **GPredict Integration** — Connects via Hamlib rotctld (TCP 4533) and rigctld (TCP 4532) for live antenna and radio tracking
- **SDR Display** — FFT spectrum analyzer and waterfall plot from loaded IQ files
- **Signal Recording** — Capture IQ data with SigMF metadata export
- **Uplink Simulation** — Transmit command IQ files to satellites with physics-based link validation (FSPL, beam attenuation, amplifier matching)
- **Satellite State Engine** — Real-time telemetry simulation with attack effects (solar panel, antenna, ADCS, OBC)
- **Multiple Antenna Types** — Yagi, parabolic dish, dipole, and helix with accurate beam patterns

## Screenshot

<p align="center">
  <img src="screenshot.png" alt="OpenVSA Screenshot" />
</p>

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [GPredict](http://gpredict.oz9aec.net/) (optional, for satellite tracking)
- [Python 3](https://www.python.org/) (optional, for uplink command decoding)

### Install & Run

```bash
git clone https://github.com/whal-e3/OpenVSA
cd OpenVSA
npm install
npm run electron
```

### Connect GPredict

1. In GPredict, go to **Edit > Preferences > Interfaces > Rotators**
2. Add a new rotator with host `localhost` and port `4533`
3. Add a radio interface with host `localhost` and port `4532`
4. OpenVSA will receive azimuth/elevation and frequency commands automatically

## Architecture

```
GPredict ──► TCP:4533 ──► server.js ──► WS:4534 ──► Renderer
             rotctld       bridge        internal     (3D + UI)

GPredict ──► TCP:4532 ──► server.js ──► WS:4534 ──► Frequency control
             rigctld       bridge        internal     (auto-tune)

.cf32 file ──► Load IQ ──► FFT ──► Spectrum + Waterfall

Uplink IQ ──► Decode (Python) ──► Physics validation ──► Satellite state engine
```

## License

Dual licensed. See [LICENSE](LICENSE) for details.

- **GPLv3** — Personal, educational, and non-commercial use
- **Commercial License** — Contact the author for commercial use

## Author

SunHyuk Hwang
