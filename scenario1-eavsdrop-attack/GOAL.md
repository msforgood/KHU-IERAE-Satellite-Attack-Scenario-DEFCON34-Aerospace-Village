# Goal: Scenario 1, Eavesdrop Attack

## What it demonstrates

Many satellites broadcast telemetry and payload data in the clear, over well-documented
amateur and civil formats. Anyone under the pass, with an antenna and a software radio,
can receive it. This scenario makes that concrete: a visitor intercepts a cubesat's
image downlink and recovers the picture, without ever transmitting.

The target, ENIGMA-1, is a fictional low-orbit Earth-observation cubesat. It continuously
beacons a packetized image on 433.500 MHz using AX.25 over 9600-baud GFSK with a G3RUH
scrambler, which is a real, common amateur-satellite scheme.

## The narrative

1. A satellite passes overhead. Its position changes fast, so the ground antenna has to
   track it in real time. GPredict computes the orbit from the TLE and aims the antenna.
2. To receive cleanly, the radio must match the satellite's RF: center frequency, symbol
   rate, and Doppler. The visitor confirms these in the VSA and records the IQ.
3. The recording is demodulated with GNU Radio. The demod chain is presented as a puzzle
   so the visitor sees each stage: filter, FSK demod, AX.25 deframe, reassembly.
4. The image the satellite was sending comes back, decoded from nothing but a passive
   capture.

## Core message

Radio links are not private by default. Tracking, tuning, and demodulation are approachable
with open tools. If a downlink is unencrypted, reception is enough to read it.

## Equipment (booth)

- A PC running the web guide, the VSA, GPredict, and GNU Radio (all local).
- An Arduino-driven booth antenna that visibly aims and locks when the receiver acquires
  the signal, so the "tracking" step is physical, not just on screen.

## Notes for the build

- Receive only. There is no uplink, no command interface, and no victim ground station.
- The demodulation is real: the uploaded IQ is decoded by an actual GNU Radio flowgraph,
  and the recovered image is what the flowgraph produces, offsets and all.
