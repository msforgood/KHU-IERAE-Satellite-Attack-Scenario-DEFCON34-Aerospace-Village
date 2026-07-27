// antenna_selftest.ino — 안테나 스텝퍼 배선 점검용 (시리얼 명령·브리지 불필요)
// ─────────────────────────────────────────────────────────────────────────────
// scn1 의 검증된 booth_antenna.ino 를 그대로 참고했다(라이브러리·핀·하프스텝·코일순서
// 동일). 전원만 넣으면 AZ·EL 두 28BYJ-48 이 두 자세를 계속 왕복한다. 명령 불필요.
//   · 여기서 돌면 배선·드라이버·전원 정상 → 문제는 상위(명령 미도달/목표각 불변).
//   · 여기서도 안 돌면 배선·핀·전원 문제 → 시리얼 모니터(115200)에서 'T' 를 보내
//     핀 테스트로 어느 IN 핀이 죽었는지 ULN2003 LED 로 확인한다.
//
// ⚠ 핀은 scn1 과 동일하게 옮겨져 있다(원래 D9~D12 가 스텝퍼를 못 돌려 A0~A3 로 이동):
//   [AZ 모터]  ULN2003 IN1→A0  IN2→A1  IN3→A2  IN4→A3
//   [EL 모터]  ULN2003 IN1→D2  IN2→D3  IN3→D4  IN4→D5
//   (antenna_gimbal.ino 의 8,10,9,11 / 4,6,5,7 과 다르다 — 실제 배선은 이쪽이다)
//
// ⚠ 28BYJ-48 는 외부 5V 로 구동하고, 외부 GND 와 Uno GND 를 공통으로 묶는다.
//   Uno 5V 핀만으로는 전류가 부족해 "지지직"거리기만 하고 안 도는 경우가 많다.
//
// 필요 라이브러리: AccelStepper  (arduino-cli lib install AccelStepper)
// 업로드: arduino-cli compile --upload -p /dev/cu.xxx --fqbn arduino:avr:uno \
//           common/arduino/antenna_selftest

#include <AccelStepper.h>

// -- AZ (방위각) 핀: scn1 과 동일하게 A0~A3 --
#define AZmotorPin1 A0
#define AZmotorPin2 A1
#define AZmotorPin3 A2
#define AZmotorPin4 A3
// -- EL (앙각) 핀: scn1 과 동일하게 D2~D5 --
#define ELmotorPin1 2
#define ELmotorPin2 3
#define ELmotorPin3 4
#define ELmotorPin4 5

#define MotorInterfaceType 8   // 4-wire half-step (28BYJ-48)
// 코일순서 IN1,IN3,IN2,IN4 — scn1 과 동일
AccelStepper stepperAZ(MotorInterfaceType, AZmotorPin1, AZmotorPin3, AZmotorPin2, AZmotorPin4);
AccelStepper stepperEL(MotorInterfaceType, ELmotorPin1, ELmotorPin3, ELmotorPin2, ELmotorPin4);

const float ONE_TURN = 4096.0;   // steps/rev (28BYJ-48 half-step)

// 왕복할 두 자세(도) — 눈에 크게 보이도록 넉넉히 벌린다.
const float POSE_A_AZ = 0.0,   POSE_A_EL = 0.0;
const float POSE_B_AZ = 120.0, POSE_B_EL = 70.0;

long azSteps(float deg) { return lround(deg * ONE_TURN / 360.0); }
long elSteps(float deg) { return -lround(deg * ONE_TURN / 360.0); } // up = 음수(scn1 관례)

void gotoPose(float az, float el) {
  stepperAZ.moveTo(azSteps(az));
  stepperEL.moveTo(elSteps(el));
}

// -- 진단: 각 IN 핀을 하나씩 HIGH → ULN2003 IN1..IN4 LED 가 순서대로 켜지는지 확인 --
// (시리얼 모니터에서 'T' 전송. 4개 LED 가 순서대로 안 켜지면 그 핀↔드라이버 배선/핀 문제)
const uint8_t AZ_PINS[4] = {AZmotorPin1, AZmotorPin2, AZmotorPin3, AZmotorPin4};
const uint8_t EL_PINS[4] = {ELmotorPin1, ELmotorPin2, ELmotorPin3, ELmotorPin4};
void pulsePins(const char* name, const uint8_t* pins) {
  for (int i = 0; i < 4; i++) {
    Serial.print(name); Serial.print(" IN"); Serial.print(i + 1);
    Serial.print(" (pin "); Serial.print(pins[i]); Serial.println(") HIGH");
    digitalWrite(pins[i], HIGH); delay(600); digitalWrite(pins[i], LOW); delay(200);
  }
}
void pinTest() {
  Serial.println(F("== PIN TEST: AZ IN1..4 -> EL IN1..4 (드라이버 LED 순차 점등 확인) =="));
  pulsePins("AZ", AZ_PINS);
  pulsePins("EL", EL_PINS);
  Serial.println(F("== PIN TEST DONE =="));
}

// 연속 회전 속도(half-step/s). 28BYJ-48 는 대략 500~700 이상이면 토크 부족으로 탈조.
const float AZ_SPEED = 500.0;    // AZ: 정방향 연속 회전
const float EL_SPEED = -400.0;   // EL: 역방향 연속 회전(두 축 구분 쉽게)

unsigned long lastBeat = 0;

void setup() {
  Serial.begin(115200);
  // 연속 회전 모드: 가속 없이 일정 속도로 끝없이 돈다(runSpeed).
  stepperAZ.setMaxSpeed(1000); stepperAZ.setSpeed(AZ_SPEED);
  stepperEL.setMaxSpeed(1000); stepperEL.setSpeed(EL_SPEED);
  Serial.println(F("ANTENNA SELFTEST (scn1 기반) — AZ·EL 무한 연속 회전. 'T' 로 핀 테스트."));
}

void loop() {
  // 'T' 오면 핀 진단(그 외 무시). 회전 자체는 명령 없이 계속.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'T' || c == 't') {
      pinTest();
      stepperAZ.setSpeed(AZ_SPEED);   // 핀테스트 후 속도 재설정
      stepperEL.setSpeed(EL_SPEED);
    }
  }

  // 매 loop 마다 한 스텝씩 → 끊김 없는 연속 회전. 전원만 살아있으면 무조건 돈다.
  stepperAZ.runSpeed();
  stepperEL.runSpeed();

  // 2초마다 살아있음 표시(스텝 카운트가 늘면 펌웨어는 정상 구동 중).
  unsigned long now = millis();
  if (now - lastBeat >= 2000) {
    lastBeat = now;
    Serial.print(F("spinning... AZ steps=")); Serial.print(stepperAZ.currentPosition());
    Serial.print(F("  EL steps="));           Serial.println(stepperEL.currentPosition());
  }
}
