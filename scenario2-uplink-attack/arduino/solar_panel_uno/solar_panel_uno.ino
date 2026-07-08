// solar_panel_uno.ino — Scenario 2 "Uplink Attack" solar-panel actuator.
//
//   Board : Arduino Uno (or any AVR/SAMD board with the standard Servo lib)
//   Motor : solar-panel hinge servo. Two options:
//           · standard positional SG90 → panel SWINGS off the sun (0°) on attack.
//           · continuous-rotation servo (FS90R, or an SG90 modded for continuous
//             rotation) → panel SPINS endlessly on attack (SPIN/STOP commands).
//
// Mirrors the satellite state engine's `solar_panel.angle`:
//   90° = optimal, sun-tracking   →   0° = swung off the sun (power collapse).
// During an uplink attack the victim bridge streams the falling angle
// here (positional) or fires SPIN (continuous-rotation panel).
//
// The sketch is fully testable WITHOUT the bridge: open the Serial Monitor at
// 9600 baud and type the commands below.
//
// ── Line protocol (9600 baud, '\n'-terminated) ──────────────────────────────
//   ANG <0-180>   set target servo angle (solar_panel.angle, direct map)
//   MODE <0|1>    0 = nominal (sun-track) / 1 = attack (off-sun) — LED effect
//   SUN           shortcut: ANG 90 + MODE 0
//   OFFSUN        shortcut: ANG 0  + MODE 1
//   SPIN [us]     continuous rotation (needs a continuous-rotation servo); optional
//                 pulse 1000-2000us (1500=stop, 2000=full). Default 2000 = full spin.
//   STOP          leave spin, hold current position
//   PING          replies "SOLAR READY angle=<n> mode=<m>"
//
//   NOTE: a stock SG90 cannot rotate continuously — SPIN just drives it to an end
//   stop and holds. For endless rotation use an FS90R or a continuous-rotation-
//   modified SG90 (remove the stopper tab + fix the feedback pot).
//
// ── Wiring ──────────────────────────────────────────────────────────────────
//   Servo signal → D9      Servo V+ → external 5V (NOT the Uno 5V pin for load)
//   Servo GND    → common GND (Uno GND + external supply GND tied together)
//   Status LED   → D13 (on-board)

#include <Servo.h>

const uint8_t  SERVO_PIN   = 9;
const uint8_t  LED_PIN     = 13;
const int      ANGLE_MIN   = 0;
const int      ANGLE_MAX   = 180;
const int      STEP_PER_LOOP = 2;     // deg moved toward target each loop (smoothing)
const uint16_t LOOP_DELAY_MS = 15;    // servo settle time between micro-steps

const int SPIN_US_DEFAULT = 2000;   // full-speed continuous rotation (1500 = stop)

Servo panel;
int  targetAngle  = 90;   // sun-track default
int  currentAngle = 90;
int  mode         = 0;    // 0 nominal (positional) · 1 attack (positional) · 2 continuous spin
int  spinUs       = SPIN_US_DEFAULT;
char lineBuf[48];
uint8_t lineLen = 0;

void applyLine(char *line);

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  panel.attach(SERVO_PIN);
  panel.write(currentAngle);
  Serial.println(F("SOLAR READY angle=90 mode=0"));
}

void loop() {
  // 1) drain serial into a line buffer, dispatch on newline
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) { lineBuf[lineLen] = '\0'; applyLine(lineBuf); lineLen = 0; }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    }
  }

  // 2) continuous spin (mode 2) drives a constant pulse; otherwise ease the
  //    positional servo toward the target so it never slams.
  if (mode == 2) {
    panel.writeMicroseconds(spinUs);
  } else if (currentAngle != targetAngle) {
    int diff = targetAngle - currentAngle;
    int step = diff;
    if (step >  STEP_PER_LOOP) step =  STEP_PER_LOOP;
    if (step < -STEP_PER_LOOP) step = -STEP_PER_LOOP;
    currentAngle += step;
    panel.write(currentAngle);
  }

  // 3) status LED: solid in nominal, blinking under attack (swing or spin)
  if (mode != 0) digitalWrite(LED_PIN, (millis() / 150) % 2);
  else           digitalWrite(LED_PIN, HIGH);

  delay(LOOP_DELAY_MS);
}

// Parse "<CMD> [arg]" — CMD is case-insensitive on the first token.
void applyLine(char *line) {
  // uppercase the command token in place
  char *sp = line;
  while (*sp && *sp != ' ') { *sp = toupper(*sp); sp++; }
  int arg = 0;
  bool hasArg = (*sp == ' ');
  if (hasArg) arg = atoi(sp + 1);

  if (strncmp(line, "ANG", 3) == 0 && hasArg) {
    targetAngle = constrain(arg, ANGLE_MIN, ANGLE_MAX);
  } else if (strncmp(line, "MODE", 4) == 0 && hasArg) {
    mode = arg ? 1 : 0;
  } else if (strncmp(line, "SUN", 3) == 0) {
    targetAngle = 90; mode = 0;
  } else if (strncmp(line, "OFFSUN", 6) == 0) {
    targetAngle = 0;  mode = 1;
  } else if (strncmp(line, "SPIN", 4) == 0) {
    if (hasArg) spinUs = constrain(arg, 1000, 2000);
    mode = 2;
  } else if (strncmp(line, "STOP", 4) == 0) {
    mode = 0; targetAngle = currentAngle;   // hold where it is
    panel.writeMicroseconds(1500);          // neutral pulse halts a continuous-rotation servo
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("SOLAR READY angle="));
    Serial.print(targetAngle);
    Serial.print(F(" mode="));
    Serial.println(mode);
  }
}
