# Scenario 3 — Break a satellite, then impersonate it

Welcome, hacker. 👋🏻 Today we're going to wreck a satellite and keep the ground station from ever noticing. 😎

This demo has two steps. **① Actually break the satellite → ② Disguise a drone as the satellite to hide the damage.** Every command you send is a **real, legitimate format**. You just decide the values.

### STEP 1 — Break the satellite (uplink attack)

The target satellite keeps its solar panel pointed at the sun at all times. We're going to load an **out-of-range value** into that attitude-control command. When the reaction wheels overspin, the satellite loses its attitude and **tumbles endlessly**, the panel loses the sun, and **power collapses**. 💔

**Phase 1**

Read our briefing carefully — once it makes sense, check the box and go carry out the real attack!

**Phase 2**

| #   | Field              | What to do                                                        |
| --- | ------------------ | ----------------------------------------------------------------- |
| ①   | **COMMAND SELECT** | Find the command that can make the satellite spin.                |
| ②   | **COMMAND VALUE**  | What value pushes past the normal range and breaks the satellite? |

Once you've done those two, we'll match the RF Config to the satellite's receiver. (Leave that to me!)

> This torque command is **completely legitimate**. You didn't break any protocol or bypass any security.
> **A legitimate command becomes an attack when it carries an abused value** — that's the whole point.

→ Then press **`⚡ GENERATE UPLINK IQ`** and your forged command turns into a radio-signal file, **`attack.cf32`**.

**Phase 3**

Hold on! Our target satellite isn't in range yet! Just a little longer! ⏱️

Phew. It's finally in range. 😮‍💨 Let's feed the target satellite's values into our antenna. Match the values and the antenna turns to face the satellite. Load the `attack.cf32` you just made into the **Virtual Antenna** → **`TRANSMIT`**

📡 The antenna locks onto the satellite, and once the signal lands the **solar panel loses the sun and spins out of control**. Power collapses and the ground station screams **`ENERGY SUPPLY CRITICAL`**. Check it on the victim's ground-station screen.

We have to kill the alarm before the ground station notices! 😵‍💫 Quick — jump into the drone console with the **`④ DRONE SPOOF → HIDE THE ALARM`** button. The drone will pose as **DEMOSAT** and send a forged "nominal" beacon to the ground station.

### STEP 2 — Impersonate the satellite (telemetry spoofing)

**Phase 4**

| #   | Field        | What to do                                                                                                     |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| ①   | **FORGE**    | Fill every telemetry field with a lie: **NOMINAL · battery 98% · SUN-TRACKING · COMM CONNECTED · no tumbling** |
| ②   | **TRANSMIT** | Send the forged beacon.                                                                                        |

See the ground-station dashboard flip **RED → GREEN** and the alarm go quiet? Nicely done. 😎 **But the real satellite is still tumbling.** 🌀 The physical motors never stopped.

> **How is this possible?** The ground station **never verifies that the beacon really came from DEMOSAT** — no signature, no authentication. It simply trusts whatever beacon it hears. The drone transmits its forged beacon on the same frequency, **closer and stronger** than the satellite. The ground station has no way to tell real from fake, so it accepts the drone's lie as the "latest nominal state."

### Telemetry you can't trust is telemetry you can't defend.
