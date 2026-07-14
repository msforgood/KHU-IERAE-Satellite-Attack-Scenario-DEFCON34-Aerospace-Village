// solar_panel_spin.ino — 솔라 패널 무한 회전 (vendor 솔라 트래커 키트 배선 기준)
//
//   Board : Arduino Uno / Nano (CH340 클론 포함)
//   기반  : sample-from-vendor/2-5.SPACE_Solar_thermal 의 배선을 그대로 사용.
//
// ── 배선 (vendor 샘플과 동일) ────────────────────────────────────────────────
//   ServoB(하/베이스축, 방위) 신호 → D11   ← 이 서보가 "솔라 패널"을 무한 회전시킴
//   ServoH(상/고도축)         신호 → D12   ← 중앙(90°)에 고정
//   서보 V+  → 외부 5V (부하 시 Uno의 5V 핀 대신 별도 5V 공급)
//   서보 GND → 공통 GND (Uno GND + 외부 5V GND 함께 묶기)
//   (CDS J1~J4=A0~A3, PV=A4 는 회전 데모에서는 사용하지 않음)
//   상태 LED → D13 (온보드): 회전 중 깜빡, 정지 시 점등
//
// ── 서보 종류에 따른 두 가지 회전 방식 ───────────────────────────────────────
//   · 위치형 SG90 / MG90S (0~180°) → SWEEP : 0↔180 연속 왕복 = 시각적 무한 회전
//                                            (SG90/MG90S는 원리상 진짜 360°가 안 됨)
//   · 연속회전 서보 FS90R / 360°   → SPIN360: 일정 펄스로 진짜 무한 360° 회전
//   아래 CONTINUOUS_SERVO 값만 바꾸면 됩니다. 기본값 0 — vendor 키트(MG90S 위치형) 기준.
//
// ── 동작 ─────────────────────────────────────────────────────────────────────
//   전원 인가 즉시 무한 회전 시작. 별도 명령 불필요.
//   시리얼 모니터 @ 9600 baud (선택):
//     SPIN            회전 시작
//     STOP            정지 (베이스 서보 중립/현위치 유지)
//     SPEED <1-30>    회전 속도 조절 (SWEEP: deg/loop, SPIN360: 중립 기준 세기)
//     PING            상태 출력

#include <Servo.h>

// 0 = 위치형 SG90/MG90S (0↔180 왕복) · 1 = 연속회전 서보(FS90R 등, 진짜 360°)
#define CONTINUOUS_SERVO 0

// 고도축 서보(D12)를 함께 구동할지. 0 = 구동 안 함(전류를 베이스 회전축에 몰아줌 →
// 부들거림/브라운아웃 완화). 두 축을 다 쓰려면 1로.
#define USE_TILT_SERVO 0

const uint8_t SERVO_BASE_PIN = 11;   // ServoB — 베이스(방위) = 무한 회전축
const uint8_t SERVO_TILT_PIN = 12;   // ServoH — 고도축 = 90° 고정
const uint8_t LED_PIN        = 13;

// SWEEP(위치형) 파라미터 — 1↔180 무한 왕복
const int SWEEP_MIN = 1;             // 왕복 하한
const int SWEEP_MAX = 180;           // 왕복 상한
int      sweepAngle = SWEEP_MIN;     // 현재 각도
int      sweepDir   = +1;            // 진행 방향
int      sweepStep  = 1;             // 한 루프당 이동 각도(작을수록 매끄러움)
const uint16_t SWEEP_DELAY_MS = 15;  // 서보 이동 후 정착 시간

// SPIN360(연속회전) 파라미터: 1500=정지, 2000=한쪽 최대 회전
const int SPIN_STOP_US = 1500;
int       spinUs       = 2000;

Servo base;
Servo tilt;
bool  spinning = true;                // 전원 인가 시 바로 회전
char  lineBuf[32];
uint8_t lineLen = 0;

void applyLine(char *line);

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  base.attach(SERVO_BASE_PIN, 600, 2400);  // MG90S 실측 펄스폭 — 끝단 버즈/떨림 완화
#if USE_TILT_SERVO
  tilt.attach(SERVO_TILT_PIN);
  tilt.write(90);                      // 고도축은 중앙 고정
#endif
#if CONTINUOUS_SERVO
  Serial.println(F("SOLAR PANEL SPIN READY mode=SPIN360"));
#else
  base.write(sweepAngle);
  Serial.println(F("SOLAR PANEL SPIN READY mode=SWEEP"));
#endif
}

void loop() {
  // 1) 시리얼 라인 수신
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) { lineBuf[lineLen] = '\0'; applyLine(lineBuf); lineLen = 0; }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    }
  }

  // 2) 회전 구동
  if (spinning) {
#if CONTINUOUS_SERVO
    base.writeMicroseconds(spinUs);            // 진짜 연속 회전
#else
    sweepAngle += sweepDir * sweepStep;              // 1↔180 무한 왕복
    if (sweepAngle >= SWEEP_MAX) { sweepAngle = SWEEP_MAX; sweepDir = -1; }
    if (sweepAngle <= SWEEP_MIN) { sweepAngle = SWEEP_MIN; sweepDir = +1; }
    base.write(sweepAngle);
    delay(SWEEP_DELAY_MS);
#endif
    digitalWrite(LED_PIN, (millis() / 150) % 2);  // 회전 중 깜빡
  } else {
    digitalWrite(LED_PIN, HIGH);                  // 정지 시 점등
  }
}

void applyLine(char *line) {
  char *sp = line;
  while (*sp && *sp != ' ') { *sp = toupper(*sp); sp++; }
  bool hasArg = (*sp == ' ');
  int  arg    = hasArg ? atoi(sp + 1) : 0;

  if (strncmp(line, "SPIN", 4) == 0) {
#if !CONTINUOUS_SERVO
    if (!base.attached()) base.attach(SERVO_BASE_PIN, 600, 2400);  // 재구동
#endif
    spinning = true;
  } else if (strncmp(line, "STOP", 4) == 0) {
    spinning = false;
#if CONTINUOUS_SERVO
    base.writeMicroseconds(SPIN_STOP_US);   // 중립 펄스 → 연속회전 서보 정지
#else
    base.detach();                          // 펄스 차단 → 완전 무음(힘 풀림)
#endif
  } else if (strncmp(line, "SPEED", 5) == 0 && hasArg) {
#if CONTINUOUS_SERVO
    // 1~30 → 중립(1500)에서 벗어나는 세기로 매핑
    spinUs = SPIN_STOP_US + constrain(arg, 1, 30) * 17;   // 최대 ~2010us
#else
    sweepStep = constrain(arg, 1, 30);
#endif
  } else if (strncmp(line, "PING", 4) == 0) {
    Serial.print(F("SOLAR PANEL "));
    Serial.println(spinning ? F("SPINNING") : F("STOPPED"));
  }
}
