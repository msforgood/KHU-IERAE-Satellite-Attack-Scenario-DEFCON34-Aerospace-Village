/*
 * booth_antenna.ino - antenna model for the booth (serial command driven)
 *
 * Receives a single character over USB serial from the bridge (arduino_bridge.py) and changes the pose:
 *   'L' (Lock)   : the VSA antenna is pointing at the satellite  -> satellite aiming pose
 *   'U' (Unlock) : the antenna is not pointing at the satellite   -> a completely different angle
 *
 * Hardware: two 28BYJ-48 steppers + two ULN2003 drivers (same wiring as the SatelliteTracker project).
 * Non-blocking rotation with AccelStepper - new commands are accepted even while moving.
 */
#include <AccelStepper.h>

// -- Azimuth stepper pins (ULN2003 IN1..IN4) --
// Note: the original pins 9 to 12 did not drive the stepper (suspected bad pins/header), so they were moved to A0 to A3 (a separate port).
//   -> Rewire the AZ driver as IN1->A0, IN2->A1, IN3->A2, IN4->A3.
#define AZmotorPin1 A0
#define AZmotorPin2 A1
#define AZmotorPin3 A2
#define AZmotorPin4 A3
// -- Elevation stepper pins --
#define ELmotorPin1 2
#define ELmotorPin2 3
#define ELmotorPin3 4
#define ELmotorPin4 5

#define MotorInterfaceType 8   // 4-wire half-step
AccelStepper stepperAZ(MotorInterfaceType, AZmotorPin1, AZmotorPin3, AZmotorPin2, AZmotorPin4);
AccelStepper stepperEL(MotorInterfaceType, ELmotorPin1, ELmotorPin3, ELmotorPin2, ELmotorPin4);

const float ONE_TURN = 4096.0;   // steps per revolution (28BYJ-48 half-step)

// Two poses (azimuth degrees, elevation degrees) - just change the angles to fit the booth
const float LOCK_AZ   = 0.0, LOCK_EL   = 0.0;   // aiming at the satellite
const float UNLOCK_AZ = 100.0, UNLOCK_EL = 80.0;   // pointing elsewhere

long azSteps(float deg) { return lround(deg * ONE_TURN / 360.0); }
long elSteps(float deg) { return -lround(deg * ONE_TURN / 360.0); } // up = negative (project convention)

void gotoPose(float az, float el) {
  stepperAZ.moveTo(azSteps(az));
  stepperEL.moveTo(elSteps(el));
}

void deenergize() {   // turn off the coils (prevents heating while stopped)
  digitalWrite(AZmotorPin1, LOW); digitalWrite(AZmotorPin2, LOW);
  digitalWrite(AZmotorPin3, LOW); digitalWrite(AZmotorPin4, LOW);
  digitalWrite(ELmotorPin1, LOW); digitalWrite(ELmotorPin2, LOW);
  digitalWrite(ELmotorPin3, LOW); digitalWrite(ELmotorPin4, LOW);
}

// -- Diagnostic: drive each IN pin HIGH one at a time to see which driver LED (IN1..IN4) responds --
// (send 'T' from the serial monitor. If the four AZ LEDs do not light up in sequence, that pin-to-driver wiring/pin is the problem)
const uint8_t AZ_PINS[4] = {AZmotorPin1, AZmotorPin2, AZmotorPin3, AZmotorPin4};   // A0,A1,A2,A3
const uint8_t EL_PINS[4] = {ELmotorPin1, ELmotorPin2, ELmotorPin3, ELmotorPin4};   // 2,3,4,5
void pulsePins(const char* name, const uint8_t* pins) {
  for (int i = 0; i < 4; i++) {
    Serial.print(name); Serial.print(" IN"); Serial.print(i + 1);
    Serial.print(" (pin "); Serial.print(pins[i]); Serial.println(") HIGH");
    digitalWrite(pins[i], HIGH); delay(600); digitalWrite(pins[i], LOW); delay(200);
  }
}
void pinTest() {
  Serial.println("== PIN TEST: AZ IN1..4 -> EL IN1..4 (check that each driver LED lights up in sequence) ==");
  pulsePins("AZ", AZ_PINS);
  pulsePins("EL", EL_PINS);
  deenergize();
  Serial.println("== PIN TEST DONE ==");
}

void setup() {
  Serial.begin(115200);
  stepperAZ.setMaxSpeed(100); stepperAZ.setAcceleration(50);
  stepperEL.setMaxSpeed(100); stepperEL.setAcceleration(50);
  // set the starting pose to UNLOCK and align the current position to it
  stepperAZ.setCurrentPosition(azSteps(UNLOCK_AZ));
  stepperEL.setCurrentPosition(elSteps(UNLOCK_EL));
  gotoPose(UNLOCK_AZ, UNLOCK_EL);
  Serial.println("BOOTH-ANTENNA READY");
}

void loop() {
  // Handle commands (first character: L=aim, U=elsewhere). Other characters are ignored.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'L' || c == 'l')      { gotoPose(LOCK_AZ,   LOCK_EL);   Serial.println("LOCK"); }
    else if (c == 'U' || c == 'u') { gotoPose(UNLOCK_AZ, UNLOCK_EL); Serial.println("UNLOCK"); }
    else if (c == 'T' || c == 't') { pinTest(); }   // diagnostic: check pins/wiring
  }

  // Non-blocking rotation
  stepperAZ.run();
  stepperEL.run();

  // Turn off the coils when both axes reach their targets (saves heat/power during long booth operation)
  if (stepperAZ.distanceToGo() == 0 && stepperEL.distanceToGo() == 0) {
    deenergize();
  }
}
