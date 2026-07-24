// antenna_gimbal.ino — Scenario 2 "Uplink Attack" antenna actuator (2-axis).
//
//   Board  : Arduino (Uno / MKR / Nano — anything the Stepper lib runs on)
//   Motors : TWO steppers — one per axis:
//              · AZ 모터 = 방위각(antenna.az)  → 핀 8,10,9,11
//              · EL 모터 = 앙각  (antenna.el)  → 핀 4,6,5,7
//            default target = 28BYJ-48 + ULN2003 driver board (×2)
//
// Mirrors the satellite state engine's `antenna.az` / `antenna.el`. Under an
// uplink attack the satellite tumbles and the angles drift/jitter — the steppers
// physically swing the antenna so it can no longer hold the downlink beam.
//
// Fully testable WITHOUT the bridge: Serial Monitor @ 9600, type the commands.
//
// ── Line protocol (9600 baud, '\n'-terminated) ──────────────────────────────
//   AZEL <az 0-360> <el 0-90>      set BOTH axes (az → AZ 모터, el → EL 모터)
//   AZ <az 0-360>                  set azimuth only  (AZ 모터)
//   EL <el 0-90>                   set elevation only (EL 모터)
//   MODE <0|1>                     0 = nominal / 1 = tumbling — LED effect
//   TRACK                          shortcut: MODE 0 (stops a sweep, holds position)
//   TUMBLE                         shortcut: MODE 1
//   SWEEP / ACQUIRE                acquisition gesture: sweep the AZ head left↔right
//                                  (fired when gpredict locks onto the virtual sat)
//   SPIN / STOP                    AZ 모터 연속 회전 / 정지
//   PING                           replies "ANT READY id=ANTENNA az=<n> el=<n>"
//   WHOAMI                         replies "ID=ANTENNA" (host auto-routing)
//
// ── Wiring (28BYJ-48 + ULN2003, ×2) ─────────────────────────────────────────
//   [AZ 모터]  ULN2003 IN1 → D8   IN2 → D9   IN3 → D10  IN4 → D11
//   [EL 모터]  ULN2003 IN1 → D4   IN2 → D5   IN3 → D6   IN4 → D7
//   각 ULN2003 V+/GND → external 5V supply (motor draws more than USB likes).
//   Tie every supply GND to the Arduino GND.  Status LED → D13 (on-board).
//
//   축↔모터 매칭(az=8..11 / el=4..7)이 실제 배선과 다르면 알려주세요 — 핀만 바꾸면 됩니다.
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
const int  SWEEP_LO_AZ     = 150;    // acquisition sweep: left bound
const int  SWEEP_HI_AZ     = 210;    // acquisition sweep: right bound (head turns ±30°)
const int  EL_MIN          = 0;      // elevation mechanical range (deg)
const int  EL_MAX          = 90;

// 28BYJ-48 coil order via ULN2003 is IN1,IN3,IN2,IN4.
Stepper azMotor(STEPS_PER_REV, 8, 10, 9, 11);   // 방위각 축
Stepper elMotor(STEPS_PER_REV, 4,  6, 5,  7);   // 앙각 축

long targetStepAz  = 0, currentStepAz = 0;   // AZ 모터 위치
long targetStepEl  = 0, currentStepEl = 0;   // EL 모터 위치
int  az            = 180;  // last commanded azimuth   (default antenna.az)
int  el            = 45;   // last commanded elevation (default antenna.el)
int  mode          = 0;    // 0 nominal · 1 tumbling · 2 acquisition sweep · 3 continuous spin
char lineBuf[48];
uint8_t lineLen = 0;

long azToStep(int a) {
  a = ((a % 360) + 360) % 360;               // normalize 0-359
  return (long)a * STEPS_PER_REV / 360L;
}
long elToStep(int e) {
  e = constrain(e, EL_MIN, EL_MAX);          // clamp to the tilt axis range
  return (long)e * STEPS_PER_REV / 360L;     // same deg→step ratio as azimuth
}
void setAzimuth(int a);
void setElevation(int e);
void applyLine(char *line);

// step a motor toward its target the short way around the ring, bounded per loop.
void stepToward(Stepper &m, long &current, long target) {
  if (current == target) return;
  long diff = target - current;
  while (diff >  STEPS_PER_REV / 2) diff -= STEPS_PER_REV;
  while (diff < -STEPS_PER_REV / 2) diff += STEPS_PER_REV;
  int n = (int)constrain(diff, -MAX_STEPS_LOOP, MAX_STEPS_LOOP);
  m.step(n);
  current = ((current + n) % STEPS_PER_REV + STEPS_PER_REV) % STEPS_PER_REV;
}

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  azMotor.setSpeed(STEPPER_RPM);
  elMotor.setSpeed(STEPPER_RPM);
  targetStepAz = currentStepAz = azToStep(az);
  targetStepEl = currentStepEl = elToStep(el);
  Serial.println(F("ANT READY id=ANTENNA az=180 el=45"));
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

  // 2a) drive the AZ motor (supports sweep + continuous spin gestures).
  if (mode == 3) {
    // continuous spin: keep stepping one direction endlessly (진짜 무한 회전)
    azMotor.step(MAX_STEPS_LOOP);
    currentStepAz = (currentStepAz + MAX_STEPS_LOOP) % STEPS_PER_REV;
    targetStepAz  = currentStepAz;           // keep target synced so exit is clean
  } else if (currentStepAz != targetStepAz) {
    stepToward(azMotor, currentStepAz, targetStepAz);
  } else if (mode == 2) {
    // acquisition sweep: bound reached → head to the other side (left↔right)
    long hiStep = azToStep(SWEEP_HI_AZ);
    targetStepAz = (targetStepAz == hiStep) ? azToStep(SWEEP_LO_AZ) : hiStep;
  }

  // 2b) drive the EL motor — always tracks its target (no sweep/spin on this axis).
  stepToward(elMotor, currentStepEl, targetStepEl);

  // 3) LED: solid nominal · fast blink tumbling · slow blink sweep · blink spin
  if      (mode == 1) digitalWrite(LED_PIN, (millis() / 120) % 2);
  else if (mode == 2) digitalWrite(LED_PIN, (millis() / 300) % 2);
  else if (mode == 3) digitalWrite(LED_PIN, (millis() / 150) % 2);
  else                digitalWrite(LED_PIN, HIGH);
}

void setAzimuth(int a)   { az = a; targetStepAz = azToStep(a); }
void setElevation(int e) { el = e; targetStepEl = elToStep(e); }

void applyLine(char *line) {
  char *sp = line;
  while (*sp && *sp != ' ') { *sp = toupper(*sp); sp++; }

  if (strncmp(line, "AZEL", 4) == 0) {
    // parse two integers after the command: az drives AZ 모터, el drives EL 모터
    int a = 0, e = 0;
    int got = sscanf(sp, "%d %d", &a, &e);
    if (got >= 1) setAzimuth(a);
    if (got >= 2) setElevation(e);
  } else if (strncmp(line, "AZ", 2) == 0 && *sp == ' ') {
    setAzimuth(atoi(sp + 1));
  } else if (strncmp(line, "EL", 2) == 0 && *sp == ' ') {
    setElevation(atoi(sp + 1));
  } else if (strncmp(line, "MODE", 4) == 0 && *sp == ' ') {
    mode = atoi(sp + 1) ? 1 : 0;
  } else if (strncmp(line, "TRACK", 5) == 0) {
    mode = 0;
  } else if (strncmp(line, "TUMBLE", 6) == 0) {
    mode = 1;
  } else if (strncmp(line, "SWEEP", 5) == 0 || strncmp(line, "ACQUIRE", 7) == 0) {
    mode = 2;
    targetStepAz = azToStep(SWEEP_HI_AZ);   // kick the head toward one side to start
  } else if (strncmp(line, "SPIN", 4) == 0) {
    mode = 3;                             // continuous rotation
  } else if (strncmp(line, "STOP", 4) == 0) {
    mode = 0;                             // stop spinning / hold
  } else if (strncmp(line, "WHOAMI", 6) == 0) {
    Serial.println(F("ID=ANTENNA"));      // role identity for host auto-routing
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("ANT READY id=ANTENNA az="));
    Serial.print(az);
    Serial.print(F(" el="));
    Serial.print(el);
    Serial.print(F(" mode="));            // 0 nominal·1 tumble·2 sweep·3 spin
    Serial.println(mode);
  }
}
