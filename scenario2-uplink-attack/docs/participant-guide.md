# Participant Guide — Hijack a Satellite's Solar Panel

Welcome, operator. You have access to a satellite's command uplink. Everything you
send is a **real, legitimate command format** — but you decide the values.

Your target: **DEMOSAT**, a small satellite whose solar panel tracks the sun to
stay powered. Let's see what one abused command can do.

---

## The mission

```
  STEP 1   On the Command Builder console, pick  [ ADCS ★ ] → adcs_torque
           (this sets the satellite's reaction-wheel torque)

  STEP 2   Drag the torque slider PAST the safe zone (green) into the red.
           Push it to 999 mNm.
           → Watch the CCSDS command frame assemble byte-by-byte on the right.
             This is exactly how a real satellite telecommand is built.

  STEP 3   Press  [ ⚡ GENERATE UPLINK IQ ]
           → Your forged command becomes a radio signal file (attack.cf32).

  STEP 4   On the VSA, load attack.cf32, align the antenna to the satellite,
           and hit TRANSMIT.

  STEP 5   Now watch the ground station screen — and the satellite.
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
Sending a command safely takes more than the right bytes — it takes the right
antenna position, the right angle, and the right RF parameters. Understanding that
command path is the first step to defending it.

---

## Things to try
- Slide the torque back into the **green safe zone** and generate again — a normal
  command. Compare the frame and the (lack of) alarm.
- Explore the other subsystems (POWER / COMM / OBC) in the catalog. Each is a real
  command with its own consequence.

*Ask a booth operator if you'd like a walkthrough of the command structure.*
