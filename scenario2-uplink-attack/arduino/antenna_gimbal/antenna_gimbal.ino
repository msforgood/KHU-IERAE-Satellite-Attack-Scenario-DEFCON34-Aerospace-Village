// antenna_gimbal.ino — Scenario 2 "Uplink Attack" antenna actuator.
//
//   Board  : Arduino (Uno / MKR / Nano — anything the Stepper lib runs on)
//   Motor  : stepper on the antenna azimuth axis
//            default target = 28BYJ-48 + ULN2003 driver board
//
// Mirrors the satellite state engine's `antenna.az`. Under an uplink attack the
// satellite tumbles and `antenna.az` drifts/jitters — the stepper physically
// swings the antenna so it can no longer hold the downlink beam.
//
// Fully testable WITHOUT the bridge: Serial Monitor @ 9600, type the commands.
//
// ── Line protocol (9600 baud, '\n'-terminated) ──────────────────────────────
//   AZEL <az 0-360> <el -90..90>   set azimuth (el is logged; 2-axis-ready)
//   AZ <az 0-360>                  set azimuth only
//   MODE <0|1>                     0 = nominal / 1 = tumbling — LED effect
//   TRACK                          shortcut: MODE 0
//   TUMBLE                         shortcut: MODE 1
//   PING                           replies "ANT READY az=<n>"
//
// ── Wiring (28BYJ-48 + ULN2003) ─────────────────────────────────────────────
//   ULN2003 IN1 → D8   IN2 → D9   IN3 → D10   IN4 → D11
//   ULN2003 V+/GND → external 5V supply (motor draws more than USB likes)
//   Tie the supply GND to the Arduino GND.  Status LED → D13 (on-board).
//
//   >>> Using an A4988 / DRV8825 (step+dir) driver or a NEMA-17 instead?
//       The built-in Stepper lib does NOT drive step/dir pins. Replace the
//       Stepper object with digitalWrite pulses on STEP/DIR, or install the
//       AccelStepper library and swap moveToward() for stepper.moveTo().

#include <Stepper.h>

const int  STEPS_PER_REV   = 2048;   // 28BYJ-48 with internal gearing (~2038-2048)
const int  MAX_STEPS_LOOP  = 12;     // steps moved per loop → keeps serial responsive
const int  STEPPER_RPM     = 12;
const uint8_t LED_PIN      = 13;

// 28BYJ-48 coil order via ULN2003 is IN1,IN3,IN2,IN4 → pins 8,10,9,11.
Stepper motor(STEPS_PER_REV, 8, 10, 9, 11);

long targetStep  = 0;    // desired absolute step position
long currentStep = 0;    // where we are now
int  az          = 180;  // last commanded azimuth (default antenna.az)
int  el          = 45;   // last commanded elevation (logged only)
int  mode        = 0;
char lineBuf[48];
uint8_t lineLen = 0;

long azToStep(int a) {
  a = ((a % 360) + 360) % 360;               // normalize 0-359
  return (long)a * STEPS_PER_REV / 360L;
}
void setAzimuth(int a);
void applyLine(char *line);

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  motor.setSpeed(STEPPER_RPM);
  targetStep = currentStep = azToStep(az);
  Serial.println(F("ANT READY az=180"));
}

void loop() {
  // 1) read serial line-by-line
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) { lineBuf[lineLen] = '\0'; applyLine(lineBuf); lineLen = 0; }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    }
  }

  // 2) step toward target, bounded per loop so serial stays responsive.
  //    Take the short way around the 2048-step ring.
  if (currentStep != targetStep) {
    long diff = targetStep - currentStep;
    // wrap into [-half, +half] so we rotate the short direction
    while (diff >  STEPS_PER_REV / 2) diff -= STEPS_PER_REV;
    while (diff < -STEPS_PER_REV / 2) diff += STEPS_PER_REV;
    int n = (int)constrain(diff, -MAX_STEPS_LOOP, MAX_STEPS_LOOP);
    motor.step(n);
    currentStep = ((currentStep + n) % STEPS_PER_REV + STEPS_PER_REV) % STEPS_PER_REV;
  }

  // 3) LED: solid nominal, blink under tumbling
  if (mode == 1) digitalWrite(LED_PIN, (millis() / 120) % 2);
  else           digitalWrite(LED_PIN, HIGH);
}

void setAzimuth(int a) { az = a; targetStep = azToStep(a); }

void applyLine(char *line) {
  char *sp = line;
  while (*sp && *sp != ' ') { *sp = toupper(*sp); sp++; }

  if (strncmp(line, "AZEL", 4) == 0) {
    // parse two integers after the command
    int a = 0, e = 0;
    if (sscanf(sp, "%d %d", &a, &e) >= 1) { setAzimuth(a); el = e; }
  } else if (strncmp(line, "AZ", 2) == 0 && *sp == ' ') {
    setAzimuth(atoi(sp + 1));
  } else if (strncmp(line, "MODE", 4) == 0 && *sp == ' ') {
    mode = atoi(sp + 1) ? 1 : 0;
  } else if (strncmp(line, "TRACK", 5) == 0) {
    mode = 0;
  } else if (strncmp(line, "TUMBLE", 6) == 0) {
    mode = 1;
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("ANT READY az="));
    Serial.println(az);
  }
}
