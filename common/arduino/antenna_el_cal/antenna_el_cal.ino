// antenna_el_cal.ino — EL(앙각) 모터 방향/범위 캘리브레이션.
// ─────────────────────────────────────────────────────────────────────────────
// 목적: 0°/180° 가 물리적으로 어느 쪽인지 눈으로 확인해 '준비자세'(start-attacker
//       motor_selftest READY_EL)와 '정렬자세'(ENGAGE dish=45°)를 합의하기 위한 도구.
//
// 동작:
//   · 업로드/전원 후 0° 에서 시작 → 2초마다 +10° 씩 0→180 을 '한 번' 천천히 스윕,
//     각 스텝 도달 시 현재 각도를 출력한다:  "EL = 30 deg"
//   · 180° 에 닿으면 자동 스윕을 멈추고 그 자리에서 대기(계속 안 돈다).
//   · 시리얼 모니터(9600)에서 수동 제어 가능:
//       +       +10°
//       -       -10°
//       g<n>    n도로 이동          (예:  g90)
//       r       0→180 자동 스윕 다시 시작
//       s       자동 스윕 정지 토글
//
// 배선·구동은 antenna_gimbal.ino 와 동일(그래서 여기서 정한 각도가 gimbal 에 그대로 맞음):
//   EL 모터(ULN2003 IN1~IN4) → D2,D3,D4,D5  ·  AccelStepper HALF4WIRE, 코일순서 IN1,IN3,IN2,IN4
//   4096 step/rev(half-step)  ·  toStep(deg) = -deg (gimbal 의 elToStep 과 같은 부호)
//
// 업로드: arduino-cli compile --upload -p /dev/cu.xxx --fqbn arduino:samd:mkrwifi1010 \
//           common/arduino/antenna_el_cal

#include <AccelStepper.h>

#define EL_IN1 2
#define EL_IN2 3
#define EL_IN3 4
#define EL_IN4 5
#define HALF4WIRE 8
// gimbal 과 동일하게 pin1,pin3,pin2,pin4 순서로 전달(코일순서 IN1,IN3,IN2,IN4).
AccelStepper el(HALF4WIRE, EL_IN1, EL_IN3, EL_IN2, EL_IN4);

const float   ONE_TURN  = 4096.0;   // half-step steps/rev
const float   MAX_SPEED = 600.0;    // 캘리브레이션은 느긋하게
const float   ACCEL     = 300.0;
const int     STEP_DEG  = 10;       // 한 스텝 = 10°
const int     ANG_MIN   = 0;
const int     ANG_MAX   = 180;
const unsigned long DWELL_MS = 2000;   // 각 스텝 도달 후 머무는 시간(관찰용)

long toStep(int deg) { return -lround((long)deg * ONE_TURN / 360.0); }  // gimbal 과 같은 부호(-)

int  angle     = 0;      // 현재 목표 각도(도)
int  dir       = +1;     // 자동 스윕 방향
bool autoSweep = true;
bool waiting   = false;
unsigned long arrivedAt = 0;
char buf[16];
uint8_t blen = 0;

void handle(char *s);

void gotoAngle(int a) {
  a = constrain(a, ANG_MIN, ANG_MAX);
  angle = a;
  el.moveTo(toStep(a));
  Serial.print(F("→ moving to EL = ")); Serial.print(angle); Serial.println(F(" deg"));
}

void setup() {
  Serial.begin(9600);
  el.setMaxSpeed(MAX_SPEED);
  el.setAcceleration(ACCEL);
  el.setCurrentPosition(toStep(0));       // 시작을 0° 로 정의
  Serial.println(F("EL CAL — 0..180 을 10도씩 스윕하며 각도 출력. cmds: +  -  g<n>  r(재시작)  s(정지)"));
  gotoAngle(0);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') { if (blen) { buf[blen] = 0; handle(buf); blen = 0; } }
    else if (blen < sizeof(buf) - 1) buf[blen++] = c;
  }

  el.run();

  if (el.distanceToGo() == 0) {
    if (!waiting) {                        // 방금 목표 도달 → 현재 각도 출력
      waiting = true; arrivedAt = millis();
      Serial.print(F("EL = ")); Serial.print(angle); Serial.println(F(" deg   (도달)"));
    } else if (autoSweep && millis() - arrivedAt >= DWELL_MS) {
      int next = angle + dir * STEP_DEG;
      if (next > ANG_MAX) { autoSweep = false; Serial.println(F("== 180° 도달 — 자동 스윕 정지(수동 cmd 로 계속) ==")); }
      else { waiting = false; gotoAngle(next); }
    }
  }
}

void handle(char *s) {
  if      (s[0] == '+')                 { autoSweep = false; waiting = false; gotoAngle(angle + STEP_DEG); }
  else if (s[0] == '-')                 { autoSweep = false; waiting = false; gotoAngle(angle - STEP_DEG); }
  else if (s[0] == 'g' || s[0] == 'G')  { autoSweep = false; waiting = false; gotoAngle(atoi(s + 1)); }
  else if (s[0] == 'r' || s[0] == 'R')  { autoSweep = true;  waiting = false; dir = +1; gotoAngle(0); }
  else if (s[0] == 's' || s[0] == 'S')  { autoSweep = !autoSweep; Serial.print(F("autoSweep=")); Serial.println(autoSweep); }
}
