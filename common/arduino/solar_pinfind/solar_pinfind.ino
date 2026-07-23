// solar_pinfind.ino — 서보 신호핀 찾기 (느리고 명확한 버전)
// ─────────────────────────────────────────────────────────────────────────────
// 후보 핀을 하나씩 5초간 서보로 잡아 크게 왕복시킨다. 구동 중에는 핀 번호를 매초
// 반복 출력하므로 시리얼-실제 움직임 desync 없이 "지금 움직이는 핀"을 확정할 수 있다.
//   · 특정 핀 구간에서만 서보가 움직이면 → 그 핀이 신호선.
//   · 어느 핀에서도 안 움직이면 → 전원/배선(외부 5V·GND 공통) 문제.
//   · 여러 핀에서 움직이거나 애매하면 → 알려주세요(배선 재확인).
//
// 업로드: arduino-cli compile --upload -p /dev/cu.xxx --fqbn arduino:avr:uno \
//           common/arduino/solar_pinfind
// 모니터: arduino-cli monitor -p /dev/cu.xxx -c baudrate=9600

#include <Servo.h>

const uint8_t LED_PIN = 13;
const uint8_t CANDIDATE_PINS[] = {9, 10, 11, 6, 5, 3, 2, 4, 7, 8};
const uint8_t N = sizeof(CANDIDATE_PINS) / sizeof(CANDIDATE_PINS[0]);

Servo panel;

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  Serial.println(F("SOLAR PIN FINDER (slow) — 각 핀 5초간 크게 왕복. 움직이는 핀 번호를 읽으세요."));
}

void loop() {
  for (uint8_t i = 0; i < N; i++) {
    uint8_t pin = CANDIDATE_PINS[i];
    Serial.println();
    Serial.print(F("############ TESTING  D")); Serial.print(pin);
    Serial.println(F("  (5초) ############"));
    panel.attach(pin);

    unsigned long t0 = millis();
    unsigned long lastPrint = 0;
    int a = 0, dir = 1;
    while (millis() - t0 < 5000) {          // 5초 동안 왕복
      a += dir * 5;
      if (a >= 180) { a = 180; dir = -1; }
      if (a <= 0)   { a = 0;   dir = +1; }
      panel.write(a);
      digitalWrite(LED_PIN, (millis() / 200) % 2);
      if (millis() - lastPrint >= 1000) {   // 매초 현재 핀 재출력(확정용)
        lastPrint = millis();
        Serial.print(F("   >>> 지금 움직이면 신호핀 = D")); Serial.println(pin);
      }
      delay(15);
    }
    panel.detach();
    digitalWrite(LED_PIN, LOW);
    Serial.print(F("---- D")); Serial.print(pin); Serial.println(F(" 끝 ----"));
    delay(1200);                            // 핀 사이 정지(구분 쉽게)
  }
  Serial.println(F("\n===== 한 바퀴 완료, 다시 D9 부터 =====\n"));
}
