# Participant Guide, Crash a Satellite into a Constellation

Welcome, operator. You have access to a satellite's command uplink. Everything you send is
a **real, legitimate command format**, but you decide the values.

Your target: **DEMOSAT**, a single satellite flying just below the **AURORA
constellation**, a ring of 45 satellites sharing an orbit a little higher up. DEMOSAT holds
its distance with tiny **station-keeping** thruster burns. Your job is to abuse one of
those burns so DEMOSAT climbs into the ring and hits a neighbour. Read the **TARGET INTEL**
dossier on the left of the console, it holds the answers you need.

You work on two screens. **Monitor 1** (in front of you) is where you plan and build.
**Monitor 2** (the big screen) is the satellite and the ground station, where you watch it
happen.

---

## Step 1, plan the burn (orbit planner)

```
  Look at the ORBIT PLANNER. DEMOSAT (inner orbit) sits below the AURORA ring (outer).
  Raise the PROGRADE thrust (delta-v, in m/s) using the input box or the +/- buttons.
  Watch the predicted orbit rise as you increase it.

  Too small  -> the orbit falls SHORT of the ring.
  Too large  -> the orbit OVERSHOOTS above the ring.
  Just right -> the status reads  COLLISION COURSE.   (try around 15 to 30 m/s)
```

The predicted orbit updates live as you change the numbers. Prograde pushes DEMOSAT along
its direction of travel, which raises the far side of its orbit. Radial (the second value)
you can leave at 0. Note the prograde value that puts you on a collision course, you will
enter it in Step 4.

---

## Step 2, assemble the uplink (all 4 must lock)

```
  STEP 1 - TARGET ADDRESSING
    Pick the Spacecraft ID (SCID) that matches DEMOSAT in the dossier.
    Wrong ID -> the wrong satellite -> your command is ignored.

  STEP 2 - COMMAND SELECT
    Choose the subsystem and command:  [ PROP ★ ] -> orbit_maneuver
    (the satellite's station-keeping thruster burn)

  STEP 3 - COMMAND VALUE
    Enter the PROGRADE delta-v you found in the planner (m/s), leave RADIAL at 0,
    then CONFIRM VALUE. A safe burn is only a couple of m/s, so your value is
    clearly beyond a normal station-keeping burn.

  STEP 4 - RF CONFIG
    Match the modulation, baud rate and sample rate to the satellite's receiver
    (see the dossier): OOK, 100 bps, 24 kSa/s.
    Wrong RF -> the satellite can't demodulate your signal.

  -> When all four lock, UPLINK ARMED. Press  [ GENERATE UPLINK IQ ].
    Your command becomes a radio signal file (attack.cf32).
```

Watch the **CCSDS PACKET** on the right assemble byte-by-byte as you go, this is exactly
how a real satellite telecommand is built. Change the SCID and watch the bytes change:
address the wrong satellite and it is a different message.

---

## Step 3, transmit and watch

```
  Press  [ TRANSMIT UPLINK -> DEMOSAT ].
  Now look at Monitor 2.
  DEMOSAT fires its thruster and its orbit climbs toward the AURORA ring.
  It reaches the ring and COLLIDES with a member.
  Debris scatters. The ground station screams CONSTELLATION COLLISION.
```

If the burn misses, Monitor 2 says "no collision, reset to retry". Press **RESET
SIMULATION** on your console, go back to the planner, and adjust the prograde value.

---

## What just happened?

The maneuver command is **completely legitimate**, operators use it every day to keep a
satellite in its slot. You didn't break any protocol or bypass any security. You just sent
a **valid command with an abused value**.

A small burn keeps DEMOSAT where it belongs. Your oversized burn raised its orbit until it
crossed into the AURORA ring, where it hit a neighbour. And the damage doesn't stop at two
satellites: the impact throws off a cloud of **debris** that keeps orbiting and can strike
**other members** of the constellation.

**That is the whole point: one satellite's problem cascades to many.** A single abused
command, in a sky full of satellites, becomes everyone's problem. Understanding how that
command is planned and delivered is the first step to defending against it.

---

## Things to try
- Set the prograde delta-v back to a **safe couple of m/s** and generate again, a normal
  station-keeping burn. Compare the planner status and the (lack of) collision.
- Deliberately pick the **wrong SCID or RF setting** and watch the uplink re-lock, the
  command can't be delivered.
- Try a burn that **overshoots** the ring instead of hitting it, then reset and dial it
  back onto a collision course.

*Ask a booth operator if you'd like a walkthrough of the command structure.*
