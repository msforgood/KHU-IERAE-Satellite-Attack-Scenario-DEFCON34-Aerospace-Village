// antenna_coiltest.ino — 안테나 스텝모터 2개 연속 회전 테스트 (MKR WiFi 1010)
//
// 실제 배선(사용자 확인):
//   모터1 (ULN2003 IN1~IN4) → D9, D10, D11, D12
//   모터2 (ULN2003 IN1~IN4) → D2, D3, D4, D5
//   각 ULN2003: (+)(-) 외부 5V, GND는 MKR과 공통.
//
// 이전 펌웨어는 D8,9,10,11을 구동해서(=실제 핀과 불일치) 한 번도 안 돌았음.
// 이 스케치는 위 실제 핀으로 두 모터를 하프스텝으로 계속 돌린다.
// 한쪽만 돌거나 떨기만 하면 그 모터의 IN 순서(배선)만 바꿔주면 됨.

const int M1[4] = {9, 10, 11, 12};   // 모터1 IN1,IN2,IN3,IN4
const int M2[4] = {2, 3, 4, 5};      // 모터2 IN1,IN2,IN3,IN4

// 28BYJ-48 하프스텝 8스텝 (bit3=IN1 … bit0=IN4)
const uint8_t seq[8] = {
  0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001
};

void driveStep(const int *M, int s) {
  for (int i = 0; i < 4; i++) digitalWrite(M[i], (seq[s] >> (3 - i)) & 1);
}

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) { pinMode(M1[i], OUTPUT); pinMode(M2[i], OUTPUT); }
  delay(1000);
  Serial.println("DUAL STEPPER SPIN  M1=D9,10,11,12  M2=D2,3,4,5");
}

void loop() {
  static int s = 0;
  static unsigned long t = 0, n = 0;
  driveStep(M1, s);
  driveStep(M2, s);
  s = (s + 1) % 8;
  delay(2);                          // 2ms/스텝
  if (++n % 500 == 0) Serial.println("spinning...");   // 살아있음 표시(~1s마다)
}
