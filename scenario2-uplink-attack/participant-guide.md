# Scenario 2 — Break a satellite with a single legitimate command

Welcome, hacker. 👋🏻 Today we're going to wreck a satellite with nothing but a single **legitimate command**. 😎

No hacking, no bypassing security. Every command you send is a **real, legitimate format** — you just decide the values.

### Break the satellite (uplink attack)

The target satellite keeps its solar panel pointed at the sun at all times. We're going to load an **out-of-range value** into that attitude-control command. When the reaction wheels overspin, the satellite loses its attitude and **tumbles endlessly**, the panel loses the sun, and **power collapses**. 💔

**Phase 1**

Read the on-screen briefing (① DEMOSAT · ② RF uplink · ③ a legitimate command, abused · ④ the CCSDS packet · ⑤ the SDR & the IQ file) carefully — once it makes sense, check the box at the bottom and move on with the **`BUILD THE UPLINK →`** button!

**Phase 2**

| #   | Field              | What to do                                                        |
| --- | ------------------ | ----------------------------------------------------------------- |
| ①   | **COMMAND SELECT** | Find the command that can make the satellite spin.                |
| ②   | **COMMAND VALUE**  | What value pushes past the normal range and breaks the satellite? |

Once you've done those two, the CCSDS packet fills in field by field, and our SDR auto-detects the RF off the intercepted carrier and matches it for you. (Leave that to me!)

> This torque command is **completely legitimate**. You didn't break any protocol or bypass any security.
> **A legitimate command becomes an attack when it carries an abused value** — that's the whole point.

→ Then press **`⚡ GENERATE UPLINK IQ`** and your forged command turns into a radio-signal file, **`attack.cf32`**.

**Phase 3**

Hold on! Our target satellite isn't in range yet! Just a little longer! ⏱️

Phew. It's finally in range. 😮‍💨 Let's feed the target satellite's values into our antenna. Match the values and the antenna turns to face the satellite. Load the `attack.cf32` you just made into the **Virtual Antenna** → **`TRANSMIT`**

📡 The antenna locks onto the satellite, and once the signal lands the **solar panel loses the sun and spins out of control**. Power collapses and the ground station screams **`ENERGY SUPPLY CRITICAL`**. Check it on the victim's ground-station screen. 🎉

> So what just happened?
> You didn't hack anything. This was a **legitimate command** that operators use every day. But look at how much had to line up for that one command to reach the satellite — the right command, the right value, the right RF, and the targeting too. Understanding that path is the first step to defending it.

---

### A legitimate command becomes an attack when it's abused.
