// antenna_gimbal.ino — Scenario 2 "Uplink Attack" antenna actuator (2-axis).
//
//   Board  : Arduino MKR WiFi 1010 (SAMD)  ※ AVR Uno/Nano 도 같은 코드로 동작
//   Motors : TWO 28BYJ-48 steppers via ULN2003 (×2), half-step (AccelStepper)
//              · AZ 모터 = 방위각(antenna.az) → A0,A1,A2,A3  (ULN2003 IN1,IN2,IN3,IN4)
//              · EL 모터 = 앙각  (antenna.el) → D2,D3,D4,D5  (ULN2003 IN1,IN2,IN3,IN4)
//
//   ★ 실제 배선·구동 방식은 검증된 antenna_selftest.ino(= scn1 booth_antenna)와 '완전히 동일':
//     AccelStepper HALF4WIRE(type 8) · 코일순서 IN1,IN3,IN2,IN4 · 4096 step/rev(half-step).
//     (예전 8,10,9,11 / 4,6,5,7 + Stepper 라이브러리는 이 배선과 안 맞아 모터가 안 돌았다.)
//
//   Mirrors the satellite state engine's `antenna.az` / `antenna.el`. Under an
//   uplink attack the satellite tumbles and the angles drift/jitter — the steppers
//   physically swing the antenna so it can no longer hold the downlink beam.
//
//   ⚠ 28BYJ-48 는 외부 5~6V 로 구동하고 외부 GND ↔ 보드 GND 를 반드시 공통으로 묶는다.
//     보드 5V/USB 만으론 전류가 부족해 "지지직"거리기만 하고 안 도는 경우가 많다.
//
// ── Line protocol (bridge 호환, 9600 baud, '\n'-terminated) ──────────────────
//   AZEL <az 0-360> <el 0-90>   set BOTH axes (az → AZ 모터, el → EL 모터)
//   AZ <az 0-360>               set azimuth only
//   EL <el 0-90>                set elevation only
//   MODE <0|1>                  0 = nominal / 1 = tumbling
//   TRACK / TUMBLE              MODE 0 / MODE 1 shortcut
//   SWEEP / ACQUIRE             acquisition gesture: sweep AZ head left↔right (±30°)
//   SPIN / STOP                 AZ 연속 회전 / 정지
//   PING                        replies "ANT READY id=ANTENNA az=<n> el=<n> mode=<m>"
//   WHOAMI                      replies "ID=ANTENNA"  (host auto-routing)
//
// 필요 라이브러리: AccelStepper  (arduino-cli lib install AccelStepper)

#include <AccelStepper.h>

// ── 핀 (검증된 배선: AZ=A0~A3 / EL=D2~D5) ────────────────────────────────────
#define AZ_IN1 A0
#define AZ_IN2 A1
#define AZ_IN3 A2
#define AZ_IN4 A3
#define EL_IN1 2
#define EL_IN2 3
#define EL_IN3 4
#define EL_IN4 5

#define HALF4WIRE 8                 // 28BYJ-48 4-wire half-step
// 코일순서 IN1,IN3,IN2,IN4 — selftest/scn1 과 동일하게 pin1,pin3,pin2,pin4 순으로 전달.
AccelStepper azMotor(HALF4WIRE, AZ_IN1, AZ_IN3, AZ_IN2, AZ_IN4);
AccelStepper elMotor(HALF4WIRE, EL_IN1, EL_IN3, EL_IN2, EL_IN4);

const float   ONE_TURN   = 4096.0;  // half-step steps/rev
const float   MAX_SPEED  = 700.0;   // half-step/s (28BYJ-48 탈조 한계 근처)
const float   ACCEL      = 400.0;   // steps/s^2
const float   SPIN_SPEED = 550.0;   // 연속 회전(mode 3) 속도
const uint8_t LED_PIN    = LED_BUILTIN;
const int     SWEEP_LO_AZ = 150;    // acquisition sweep 좌측 경계
const int     SWEEP_HI_AZ = 210;    // acquisition sweep 우측 경계(±30°)
const int     EL_MIN = 0, EL_MAX = 90;

int  az   = 180;   // 마지막 명령 방위각(도) — PING 출력용
int  el   = 45;    // 마지막 명령 앙각(도)
int  mode = 0;     // 0 nominal · 1 tumble · 2 sweep · 3 spin
bool sweepGoingHi = true;
char lineBuf[48];
uint8_t lineLen = 0;

long azToStep(int a) { a = ((a % 360) + 360) % 360; return lround(a * ONE_TURN / 360.0); }
long elToStep(int e) { e = constrain(e, EL_MIN, EL_MAX); return -lround(e * ONE_TURN / 360.0); } // up = 음수(scn1 관례)

// AZ 목표를 '현재 위치에서 가장 가까운 등가각'으로 잡아 최단경로로 돈다(0↔360 랩어라운드 처리).
void setAzTarget(int a) {
  long base = azToStep(a);                              // 0..4095
  long cur  = azMotor.currentPosition();
  long turn = (long)ONE_TURN;
  long k    = lround((double)(cur - base) / turn);      // cur 에 가장 가까운 회전수
  azMotor.moveTo(base + k * turn);
}

void setAzimuth(int a)   { az = a; if (mode != 3) setAzTarget(a); }
void setElevation(int e) { el = e; elMotor.moveTo(elToStep(e)); }

// 모드 전환. 연속 회전(3)에서 빠져나올 때는 목표를 현재 위치로 고정해 갑작스런 장거리 이동을 막는다.
void setMode(int m) {
  if (mode == 3 && m != 3) {
    azMotor.setCurrentPosition(azMotor.currentPosition());  // 속도 0 리셋 + 위치 유지
    azMotor.moveTo(azMotor.currentPosition());
  }
  mode = m;
}

void applyLine(char *line);

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  azMotor.setMaxSpeed(MAX_SPEED); azMotor.setAcceleration(ACCEL);
  elMotor.setMaxSpeed(MAX_SPEED); elMotor.setAcceleration(ACCEL);
  azMotor.setCurrentPosition(azToStep(az));
  elMotor.setCurrentPosition(elToStep(el));
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

  // 2) AZ 모터 — spin(3)은 등속 연속 회전, 그 외(0/1/2)는 목표각 추종.
  if (mode == 3) {
    azMotor.setSpeed(SPIN_SPEED);
    azMotor.runSpeed();
  } else {
    if (mode == 2 && azMotor.distanceToGo() == 0) {
      sweepGoingHi = !sweepGoingHi;                       // 경계 도달 → 반대편으로
      setAzTarget(sweepGoingHi ? SWEEP_HI_AZ : SWEEP_LO_AZ);
    }
    azMotor.run();
  }

  // 3) EL 모터 — 항상 목표 앙각 추종(스윕/스핀 없음).
  elMotor.run();

  // 4) LED: solid nominal · fast blink tumbling · slow blink sweep · blink spin
  if      (mode == 1) digitalWrite(LED_PIN, (millis() / 120) % 2);
  else if (mode == 2) digitalWrite(LED_PIN, (millis() / 300) % 2);
  else if (mode == 3) digitalWrite(LED_PIN, (millis() / 150) % 2);
  else                digitalWrite(LED_PIN, HIGH);
}

void applyLine(char *line) {
  char *sp = line;
  while (*sp && *sp != ' ') { *sp = toupper(*sp); sp++; }

  if (strncmp(line, "AZEL", 4) == 0) {
    int a = 0, e = 0;
    int got = sscanf(sp, "%d %d", &a, &e);
    if (got >= 1) setAzimuth(a);
    if (got >= 2) setElevation(e);
  } else if (strncmp(line, "AZ", 2) == 0 && *sp == ' ') {
    setAzimuth(atoi(sp + 1));
  } else if (strncmp(line, "EL", 2) == 0 && *sp == ' ') {
    setElevation(atoi(sp + 1));
  } else if (strncmp(line, "MODE", 4) == 0 && *sp == ' ') {
    setMode(atoi(sp + 1) ? 1 : 0);
  } else if (strncmp(line, "TRACK", 5) == 0) {
    setMode(0);
  } else if (strncmp(line, "TUMBLE", 6) == 0) {
    setMode(1);
  } else if (strncmp(line, "SWEEP", 5) == 0 || strncmp(line, "ACQUIRE", 7) == 0) {
    setMode(2);
    sweepGoingHi = true;
    setAzTarget(SWEEP_HI_AZ);              // 한쪽으로 킥해서 스윕 시작
  } else if (strncmp(line, "SPIN", 4) == 0) {
    setMode(3);                            // continuous rotation
  } else if (strncmp(line, "STOP", 4) == 0) {
    setMode(0);                            // stop spinning / hold
  } else if (strncmp(line, "WHOAMI", 6) == 0) {
    Serial.println(F("ID=ANTENNA"));       // role identity for host auto-routing
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("ANT READY id=ANTENNA az="));
    Serial.print(az);
    Serial.print(F(" el="));
    Serial.print(el);
    Serial.print(F(" mode="));             // 0 nominal·1 tumble·2 sweep·3 spin
    Serial.println(mode);
  }
}
