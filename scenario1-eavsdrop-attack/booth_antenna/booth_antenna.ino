/*
 * booth_antenna.ino — 부스용 안테나 모형 (시리얼 명령 수신형)
 *
 * 브릿지(arduino_bridge.py)로부터 USB 시리얼로 한 글자를 받아 포즈를 바꾼다:
 *   'L' (Lock)   : VSA 안테나가 위성을 가리키고 있음  → 위성 조준 포즈
 *   'U' (Unlock) : 위성을 가리키고 있지 않음           → 전혀 다른 각도
 *
 * 하드웨어: 28BYJ-48 스테퍼 2개 + ULN2003 드라이버 2개 (SatelliteTracker 프로젝트와 동일 배선).
 * AccelStepper로 논블로킹 회전 — 이동 중에도 새 명령을 받는다.
 */
#include <AccelStepper.h>

// ── 방위각(Azimuth) 스테퍼 핀 (ULN2003 IN1..IN4) ──
#define AZmotorPin1 9
#define AZmotorPin2 10
#define AZmotorPin3 11
#define AZmotorPin4 12
// ── 고각(Elevation) 스테퍼 핀 ──
#define ELmotorPin1 2
#define ELmotorPin2 3
#define ELmotorPin3 4
#define ELmotorPin4 5

#define MotorInterfaceType 8   // 4-wire half-step
AccelStepper stepperAZ(MotorInterfaceType, AZmotorPin1, AZmotorPin3, AZmotorPin2, AZmotorPin4);
AccelStepper stepperEL(MotorInterfaceType, ELmotorPin1, ELmotorPin3, ELmotorPin2, ELmotorPin4);

const float ONE_TURN = 4096.0;   // 스텝/회전 (28BYJ-48 half-step)

// 두 포즈 (방위각°, 고각°) — 부스에 맞게 각도만 바꾸면 됨
const float LOCK_AZ   = 0.0, LOCK_EL   = 0.0;   // 위성 조준
const float UNLOCK_AZ = 100.0, UNLOCK_EL = 80.0;   // 딴 데

long azSteps(float deg) { return lround(deg * ONE_TURN / 360.0); }
long elSteps(float deg) { return -lround(deg * ONE_TURN / 360.0); } // 위로 = 음수 (프로젝트 관례)

void gotoPose(float az, float el) {
  stepperAZ.moveTo(azSteps(az));
  stepperEL.moveTo(elSteps(el));
}

void deenergize() {   // 코일 끄기 (정지 시 발열 방지)
  digitalWrite(AZmotorPin1, LOW); digitalWrite(AZmotorPin2, LOW);
  digitalWrite(AZmotorPin3, LOW); digitalWrite(AZmotorPin4, LOW);
  digitalWrite(ELmotorPin1, LOW); digitalWrite(ELmotorPin2, LOW);
  digitalWrite(ELmotorPin3, LOW); digitalWrite(ELmotorPin4, LOW);
}

void setup() {
  Serial.begin(115200);
  stepperAZ.setMaxSpeed(100); stepperAZ.setAcceleration(50);
  stepperEL.setMaxSpeed(100); stepperEL.setAcceleration(50);
  // 시작 자세를 UNLOCK으로 두고 현재 위치를 그에 맞춤
  stepperAZ.setCurrentPosition(azSteps(UNLOCK_AZ));
  stepperEL.setCurrentPosition(elSteps(UNLOCK_EL));
  gotoPose(UNLOCK_AZ, UNLOCK_EL);
  Serial.println("BOOTH-ANTENNA READY");
}

void loop() {
  // 명령 처리 (첫 글자: L=조준, U=딴 데). 나머지 문자는 무시.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'L' || c == 'l')      { gotoPose(LOCK_AZ,   LOCK_EL);   Serial.println("LOCK"); }
    else if (c == 'U' || c == 'u') { gotoPose(UNLOCK_AZ, UNLOCK_EL); Serial.println("UNLOCK"); }
  }

  // 논블로킹 회전
  stepperAZ.run();
  stepperEL.run();

  // 두 축 모두 목표 도달 시 코일 끔 (장시간 부스 운영 시 발열/전력 절약)
  if (stepperAZ.distanceToGo() == 0 && stepperEL.distanceToGo() == 0) {
    deenergize();
  }
}
