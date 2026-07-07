# Participant Guide — Hijack a Satellite's Solar Panel

Welcome, operator. You have access to a satellite's command uplink. Everything you
send is a **real, legitimate command format** — but you decide the values.

Your target: **DEMOSAT**, a small satellite whose solar panel tracks the sun to
stay powered. Sending a command isn't as simple as pressing a button: you must
assemble **every element of a valid uplink** correctly. Read the **TARGET INTEL**
dossier on the left of the console — it holds the answers.

---

## Assemble the uplink (all 4 must lock ✓)

```
  STEP 1 — TARGET ADDRESSING
    Pick the Spacecraft ID (SCID) that matches DEMOSAT in the dossier.
    Wrong ID → the wrong satellite → your command is ignored.

  STEP 2 — COMMAND SELECT
    Choose the subsystem and command:  [ ADCS ★ ] → adcs_torque
    (the satellite's reaction-wheel torque)

  STEP 3 — COMMAND VALUE
    Drag the torque slider PAST the safe zone (green) into the red — 999 mNm —
    then press CONFIRM VALUE.

  STEP 4 — RF CONFIG
    Match the modulation, baud rate and sample rate to the satellite's receiver
    (see the dossier): OOK · 100 bps · 24 kSa/s.
    Wrong RF → the satellite can't demodulate your signal.

  → When all four lock, UPLINK ARMED. Press  [ ⚡ GENERATE UPLINK IQ ].
    Your forged command becomes a radio signal file (attack.cf32).
```

Watch the **LIVE CCSDS FRAME** on the right assemble byte-by-byte as you go — this
is exactly how a real satellite telecommand is built. Change the SCID and watch the
bytes change: address the wrong bird and it's a different message.

---

## Transmit and watch

```
  Load attack.cf32 into the VSA → align the antenna to the satellite → TRANSMIT.
  Now watch the ground station screen — and the satellite.
  The solar panel loses the sun and spins out of control.
  Power collapses. The ground station screams ENERGY SUPPLY CRITICAL.
```

---

## What just happened?

The torque command is **completely legitimate** — operators use it every day to
point the satellite. You didn't break any protocol or bypass any security. You just
sent a **valid command with an abused value**.

Too much torque → the satellite can't hold its attitude → it tumbles → the solar
panel can no longer face the sun → power generation collapses → the battery drains.

**That is the whole point: a legitimate command becomes an attack when it is abused.**
And notice how much had to line up for the command to even be delivered — the right
spacecraft address, the right command, the right value, and the right RF parameters.
Sending a command safely takes more than the right bytes. Understanding that command
path is the first step to defending it.

---

## Things to try
- Set the torque back into the **green safe zone** and generate again — a normal
  command. Compare the frame and the (lack of) alarm.
- Deliberately pick the **wrong SCID or RF setting** and watch the uplink re-lock —
  the command can't be delivered.
- Explore the other subsystems (POWER / COMM / OBC). Each is a real command with its
  own consequence.

*Ask a booth operator if you'd like a walkthrough of the command structure.*
