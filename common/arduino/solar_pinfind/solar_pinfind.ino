// solar_pinfind.ino — 태양광 서보(MG90S) 신호핀 찾기 + 전원 판별 진단
// ─────────────────────────────────────────────────────────────────────────────
// 서보가 안 움직일 때: 실제 신호선이 어느 핀에 꽂혔는지 모를 수 있다(안테나도 핀이
// 문서와 달랐다). 후보 핀을 하나씩 서보로 잡아 0-180 를 두 번 스윕한다.
//   · 특정 핀 차례에 서보가 움직이면 → 그 핀이 정답(시리얼에 핀 번호가 찍힌다).
//   · 어느 핀에서도 안 움직이면 → 전원 문제(외부 5V·GND 공통) 또는 서보 불량.
//
// Servo 라이브러리는 아무 디지털 핀이나 구동 가능하므로 D2~D11 을 모두 훑는다.
// 업로드: arduino-cli compile --upload -p /dev/cu.xxx --fqbn arduino:avr:uno \
//           common/arduino/solar_pinfind
// 모니터: arduino-cli monitor -p /dev/cu.xxx -c baudrate=9600

#include <Servo.h>

const uint8_t LED_PIN = 13;
// 흔히 쓰는 서보 핀을 앞쪽에 두고 D2~D11 전체를 훑는다.
const uint8_t CANDIDATE_PINS[] = {9, 10, 11, 6, 5, 3, 2, 4, 7, 8};
const uint8_t N = sizeof(CANDIDATE_PINS) / sizeof(CANDIDATE_PINS[0]);

Servo panel;

void sweepOnce() {
  for (int a = 0;   a <= 180; a += 6) { panel.write(a); delay(15); }
  for (int a = 180; a >= 0;   a -= 6) { panel.write(a); delay(15); }
}

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  Serial.println(F("SOLAR PIN FINDER — 후보 핀을 순서대로 스윕. 서보가 움직이는 순간의 핀이 정답."));
}

void loop() {
  for (uint8_t i = 0; i < N; i++) {
    uint8_t pin = CANDIDATE_PINS[i];
    Serial.print(F(">> now driving D")); Serial.print(pin);
    Serial.println(F("  (여기 꽂혀 있으면 지금 스윕함)"));
    digitalWrite(LED_PIN, HIGH);
    panel.attach(pin);
    sweepOnce();
    sweepOnce();
    panel.detach();
    digitalWrite(LED_PIN, LOW);
    delay(500);
  }
  Serial.println(F("--- 한 바퀴 끝, 다시 D9 부터 반복 ---"));
}
