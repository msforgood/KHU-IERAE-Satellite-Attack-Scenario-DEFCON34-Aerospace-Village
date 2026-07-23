// solar_selftest.ino — 태양광 서보(MG90S) 배선 점검용 (시리얼 명령·브리지 불필요)
// ─────────────────────────────────────────────────────────────────────────────
// 목적: "서보가 움직이냐" 자체를 상위 파이프라인과 분리해서 확인한다.
//   전원만 넣으면 0°↔180° 를 계속 왕복한다. 여기서 움직이면 서보·핀·전원 정상 →
//   문제는 상위(브리지가 ANG 를 안 보냄 / transmit 트리거 없음)에 있다.
//   여기서도 안 움직이면 배선·전원(외부 5V 권장) 문제다.
//
// 핀 배치(실측): 신호선은 D11. (solar_panel_uno.ino 문서값 D9 와 다름 — 실제 배선 기준)
//   [서보 신호] → D11     (주황/노랑 선)
//   [서보 V+]  → 외부 5V  (권장. Uno 5V 핀은 MG90S 기동전류에 브라운아웃 될 수 있음)
//   [서보 GND] → 공통 GND (Uno GND 와 외부전원 GND 를 함께 묶는다)
//   [LED]      → D13 (온보드)
//
// ※ MG90S 는 표준 위치제어 서보(0-180°)다. 연속회전(무한 스핀)은 안 된다 —
//   연속회전이 필요하면 FS90R 같은 continuous-rotation 서보로 바꿔야 한다.
//
// 업로드: arduino-cli compile --upload -p /dev/cu.xxx --fqbn arduino:avr:uno \
//           common/arduino/solar_selftest

#include <Servo.h>

const uint8_t SERVO_PIN = 11;   // 실측 신호핀(D9 아님)
const uint8_t LED_PIN   = 13;
const int     STEP_DEG  = 3;    // 왕복 시 각 스텝(작을수록 부드럽게)
const int     STEP_MS   = 20;   // 스텝 간 대기(서보 이동 시간)

Servo panel;

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  panel.attach(SERVO_PIN);
  panel.write(0);
  Serial.println(F("SOLAR SELFTEST — MG90S 0..180 계속 왕복(명령 불필요)"));
}

void loop() {
  Serial.println(F("→ 180"));
  for (int a = 0; a <= 180; a += STEP_DEG) {
    panel.write(a);
    digitalWrite(LED_PIN, (a / 15) % 2);   // 이동 중 LED 깜빡임
    delay(STEP_MS);
  }
  delay(300);

  Serial.println(F("→ 0"));
  for (int a = 180; a >= 0; a -= STEP_DEG) {
    panel.write(a);
    digitalWrite(LED_PIN, (a / 15) % 2);
    delay(STEP_MS);
  }
  delay(300);
}
