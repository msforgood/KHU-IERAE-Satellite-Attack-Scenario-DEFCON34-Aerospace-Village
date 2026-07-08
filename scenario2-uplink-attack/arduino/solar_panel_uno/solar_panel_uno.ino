// solar_panel_uno.ino — Scenario 2 "Uplink Attack" solar-panel actuator.
//
//   Board : Arduino Uno (or any AVR/SAMD board with the standard Servo lib)
//   Motor : standard hobby servo (SG90) on the solar-panel hinge
//
// Mirrors the satellite state engine's `solar_panel.angle`:
//   90° = optimal, sun-tracking   →   0° = swung off the sun (power collapse).
// During an uplink attack the ground-station bridge streams the falling angle
// here and the servo physically swings the panel off the sun.
//
// The sketch is fully testable WITHOUT the bridge: open the Serial Monitor at
// 9600 baud and type the commands below.
//
// ── Line protocol (9600 baud, '\n'-terminated) ──────────────────────────────
//   ANG <0-180>   set target servo angle (solar_panel.angle, direct map)
//   MODE <0|1>    0 = nominal (sun-track) / 1 = attack (off-sun) — LED effect
//   SUN           shortcut: ANG 90 + MODE 0
//   OFFSUN        shortcut: ANG 0  + MODE 1
//   PING          replies "SOLAR READY angle=<n> mode=<m>"
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

Servo panel;
int  targetAngle  = 90;   // sun-track default
int  currentAngle = 90;
int  mode         = 0;    // 0 nominal, 1 attack
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

  // 2) ease the servo toward the target so it never slams
  if (currentAngle != targetAngle) {
    int diff = targetAngle - currentAngle;
    int step = diff;
    if (step >  STEP_PER_LOOP) step =  STEP_PER_LOOP;
    if (step < -STEP_PER_LOOP) step = -STEP_PER_LOOP;
    currentAngle += step;
    panel.write(currentAngle);
  }

  // 3) status LED: solid in nominal, blinking under attack
  if (mode == 1) digitalWrite(LED_PIN, (millis() / 150) % 2);
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
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("SOLAR READY angle="));
    Serial.print(targetAngle);
    Serial.print(F(" mode="));
    Serial.println(mode);
  }
}
