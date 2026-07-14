# Participant Guide: Recover a Satellite's Image

You are a ground station. A cubesat named ENIGMA-1 is passing overhead, quietly beaconing
a picture on 433.500 MHz. Nothing is encrypted. Your job is to receive that signal and
rebuild the image, without ever transmitting.

Follow the six phases on screen:

1. MISSION. Read the goal: track the satellite, tune the receiver, demodulate the signal.
2. TARGET. Look over ENIGMA-1's specs. These are the values you will match.
3. TRACK. GPredict aims the antenna at the satellite as it moves. The VSA shows the live
   signal. Press RESET if you want the pass to start again. Record the signal (a `.cf32`
   IQ file) while it is strong.
4. DEMOD PUZZLE. Upload the file you just recorded. Then build the demodulator: drag each
   block into the right slot. Green is correct, red is wrong. When the chain is complete,
   the wires light up.
5. GNU RADIO. The real radio software runs your file. The waterfall shows the signal, and
   the image is rebuilt row by row on the right, live.
6. RESULT. The recovered image, decoded from a passive capture alone.

Takeaway: if a radio link is not encrypted, anyone under the pass with an antenna and open
software can read it. Reception is enough.
