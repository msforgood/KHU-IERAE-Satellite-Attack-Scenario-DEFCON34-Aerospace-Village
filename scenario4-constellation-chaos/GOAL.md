
## Scenario 4: `Constellation Chaos`

> We don't need to develop "real communication". The uplink is software-simulated,
> the same as scenario 2.

### Equipments

- Laptop
: Participants will use our laptop to try the scenario.
- External monitor
: A second screen connected to the laptop. Monitor 1 is the laptop's own screen (the
  visitor drives it), monitor 2 is the external screen (observation only).

Everything runs in the browser on the one laptop. There is no toy satellite, antenna, or
HackRF in this scenario; the RF step is replaced by a software uplink.

### Scenario

> Same core lesson as last year, but this time the damage spreads from one satellite to a
> whole constellation.

The target is **DEMOSAT**, a single satellite flying just below the **AURORA
constellation** (45 satellites sharing an orbit ring a little higher up). DEMOSAT holds
its slot with tiny station-keeping thruster burns.

1. On monitor 1, read the satellite tracker / orbit planner and see where DEMOSAT sits
   relative to the AURORA ring.
2. Use the orbit simulation to find a thruster burn (delta-v) that raises DEMOSAT's orbit
   into the ring, onto a collision course with a member.
3. Build the command packet by hand, a legitimate `orbit_maneuver` command carrying the
   abused delta-v.
4. Transmit the uplink through the VSA (software-simulated) to DEMOSAT.
5. Watch monitor 2. If DEMOSAT collides, a debris cascade plays and the ground station
   alarms. If the burn misses, a RESET button returns everything to the start so the
   visitor can recompute the angle and try again.

**Flow**
Plan the burn in the orbit simulation
-> assemble the `orbit_maneuver` command with an abused delta-v
-> generate the uplink IQ and TRANSMIT it (software uplink to the ground station)
-> DEMOSAT raises its orbit into the AURORA ring and **collides**
-> the impact scatters debris that strikes other members: **one problem cascades to many**.

### Core Message

- Even a legitimate command can become an attack when it is abused (same as scenario 2).
- In a real space environment full of satellites, one satellite's problem can propagate
  to many others (the main point of this scenario).
- Understand the satellite's command delivery structure, from planning a maneuver to the
  bytes on the wire.

### Two monitors

**Monitor 1 (visitor drives), attacker console, port 8000**
1. Confirm DEMOSAT's position in the satellite tracker.
2. Compute the orbit change needed for a collision using the orbit simulation (find the
   angle / delta-v).
3. Craft the command packet by hand.
4. TRANSMIT the uplink to the satellite through the VSA.
5. If monitor 2 shows no collision, a button sends the visitor back to the start to
   recompute the angle.

**Monitor 2 (no visitor input), victim ground station, port 4540**
1. The satellite simulation (a different view from monitor 1) shows DEMOSAT moving
   according to the maneuver values in the TC packet.
1-1. On collision, a collision effect plays together with a debris-cascade video (a real
   video will be attached later; for now a simple demo clip stands in) showing debris
   scattering and damaging other satellites.
1-2. If there is no collision and the RESET button on monitor 1 is pressed, monitor 2
   resets as well.
2. The ground station web UI raises an alarm depending on whether a collision occurred.

Monitor 1 lets the visitor do every step in the web UI. Monitor 2 puts the satellite
simulation on top and the ground station interface below, so the audience can watch the
satellite's state.

### References

- VSA source: https://github.com/whal-e3/OpenVSA
- Satellite simulation base: `../../satellite-tracker`
- OpenVSA reference implementation: `../../OpenVSA`
- Command spec: `docs/command-spec.md`
- Development plan: `PLAN.md`
