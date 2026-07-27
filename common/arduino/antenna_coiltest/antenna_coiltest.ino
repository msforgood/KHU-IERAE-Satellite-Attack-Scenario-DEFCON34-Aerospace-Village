// antenna_coiltest.ino — 안테나 스텝모터 1개 저속·풀스텝 회전 테스트 (MKR WiFi 1010)
//
// "하나라도 회전"을 확실히 보기 위해, 전류를 한 모터에 몰고 토크가 가장 큰
// 풀스텝(두 코일 동시 ON)을 저속으로 돌린다.
//   모터1 (ULN2003 IN1~IN4) → SCK, MISO, SDA, SCL  (= MKR D9,D10,D11,D12)
//
// ★ 하드웨어 전제(회로도에서 확인 필요):
//   · ULN2003 모터 전원(+/-)에 5V 공급 — 2×AA(3V)는 부족(보드 표기 "5-12V"). 4×AA(6V)나 5V 권장.
//   · 배터리(-) ↔ MKR GND 를 반드시 연결(공통 그라운드). 없으면 코일에 전류가 전혀 안 흐름.
//
// 이 스케치로도 안 돌면 코드가 아니라 위 전원/GND 문제다.

const int M1[4] = {SCK, MISO, SDA, SCL};   // 모터1 IN1,IN2,IN3,IN4 (실크린 라벨 그대로)

// 28BYJ-48 풀스텝 4스텝 (두 코일 동시 ON → 토크 최대). bit3=IN1 … bit0=IN4
const uint8_t seq[4] = { 0b1100, 0b0110, 0b0011, 0b1001 };

void driveStep(const int *M, int s) {
  for (int i = 0; i < 4; i++) digitalWrite(M[i], (seq[s] >> (3 - i)) & 1);
}

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) pinMode(M1[i], OUTPUT);
  delay(1000);
  Serial.println("SINGLE STEPPER (M1=SCK,MISO,SDA,SCL) full-step slow");
}

void loop() {
  static int s = 0;
  static unsigned long n = 0;
  driveStep(M1, s);
  s = (s + 1) % 4;
  delay(6);                          // 6ms/스텝 (저속·고토크)
  if (++n % 170 == 0) Serial.println("spinning...");   // ~1s마다 살아있음 표시
}
