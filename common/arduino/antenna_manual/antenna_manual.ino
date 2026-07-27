// antenna_manual.ino — 안테나 스텝모터 2개 수동 조작 (MKR WiFi 1010)
//
// 동작: 명령 1회 = 90° 1회전(그 방향으로 한 번만). 방향은 RIGHT/LEFT로 그때그때 지정.
//       이동이 끝나면 코일 OFF(무음, 기어비 1:64라 위치는 유지).
//
//   배선(회로도):
//     모터1 (ULN2003 IN1~IN4) → SCK, MISO, SDA, SCL  (= MKR D9,D10,D11,D12)
//     모터2 (ULN2003 IN1~IN4) → A2, A3, A4, A5
//     ULN2003 (+)=5V(권장), (-)=배터리 GND ↔ MKR GND 공통(필수)
//
//   명령 (대소문자 무관, 개행 종료):
//     RIGHT           두 모터 90° 오른쪽으로 1회전
//     LEFT            두 모터 90° 왼쪽으로 1회전
//     RIGHT1 / LEFT1  모터1만 90° 회전
//     RIGHT2 / LEFT2  모터2만 90°
//     MOVE <n>        두 모터 n스텝 이동(부호=방향, 각도 보정용)
//     STOP            진행 중 이동 중단 + 코일 OFF
//     SPEED <ms>      스텝 간격(기본 4ms, 작을수록 빠름)
//     PING            상태 출력
//     WHOAMI          "ID=ANTENNA"

const int M1[4] = {SCK, MISO, SDA, SCL};   // 모터1 IN1~IN4
const int M2[4] = {A2, A3, A4, A5};        // 모터2 IN1~IN4

// 28BYJ-48 풀스텝 4스텝. bit3=IN1 … bit0=IN4
const uint8_t seq[4] = { 0b1100, 0b0110, 0b0011, 0b1001 };

// 1회전 ≈ 2048 풀스텝 → 90° = 512스텝. 실제 각도가 안 맞으면 이 값만 조정.
const long STEPS_90 = 512;

long rem1 = 0, rem2 = 0;      // 남은 스텝 수(>0이면 이동 중)
int  dir1 = 1, dir2 = 1;      // 현재 이동 방향(+오른쪽 / -왼쪽)
int  idx1 = 0, idx2 = 0;
int  stepMs = 4;
unsigned long last = 0;
char buf[24];
uint8_t len = 0;

void applyMotor(const int *M, int idx) {
  for (int i = 0; i < 4; i++) digitalWrite(M[i], (seq[idx] >> (3 - i)) & 1);
}
void offMotor(const int *M) { for (int i = 0; i < 4; i++) digitalWrite(M[i], LOW); }

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) { pinMode(M1[i], OUTPUT); pinMode(M2[i], OUTPUT); }
  offMotor(M1); offMotor(M2);
  Serial.println("ANTENNA MANUAL id=ANTENNA (RIGHT/LEFT/RIGHT1/LEFT1/RIGHT2/LEFT2/MOVE/STOP/SPEED/PING)");
}

void handle(char *s) {
  for (char *p = s; *p && *p != ' '; p++) *p = toupper(*p);
  char *sp = strchr(s, ' ');
  int arg = sp ? atoi(sp + 1) : 0;
  if (sp) *sp = '\0';

  if      (!strcmp(s, "RIGHT"))  { rem1 = rem2 = STEPS_90; dir1 = dir2 = +1; }
  else if (!strcmp(s, "LEFT"))   { rem1 = rem2 = STEPS_90; dir1 = dir2 = -1; }
  else if (!strcmp(s, "RIGHT1")) { rem1 = STEPS_90; dir1 = +1; }
  else if (!strcmp(s, "LEFT1"))  { rem1 = STEPS_90; dir1 = -1; }
  else if (!strcmp(s, "RIGHT2")) { rem2 = STEPS_90; dir2 = +1; }
  else if (!strcmp(s, "LEFT2"))  { rem2 = STEPS_90; dir2 = -1; }
  else if (!strcmp(s, "MOVE"))   { long n = arg; dir1 = dir2 = (n < 0) ? -1 : +1;
                                   rem1 = rem2 = (n < 0) ? -n : n; }
  else if (!strcmp(s, "STOP"))   { rem1 = rem2 = 0; offMotor(M1); offMotor(M2); }
  else if (!strcmp(s, "SPEED"))  { stepMs = constrain(arg, 1, 50); }
  else if (!strcmp(s, "WHOAMI")) { Serial.println("ID=ANTENNA"); }
  else if (!strcmp(s, "PING"))   {
    Serial.print("ANTENNA m1="); Serial.print(rem1 ? "MOVING" : "IDLE");
    Serial.print(" m2=");        Serial.print(rem2 ? "MOVING" : "IDLE");
    Serial.print(" step90=");    Serial.print(STEPS_90);
    Serial.print(" speed=");     Serial.print(stepMs); Serial.println("ms");
  }
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { if (len) { buf[len] = 0; handle(buf); len = 0; } }
    else if (len < sizeof(buf) - 1) buf[len++] = c;
  }

  unsigned long now = millis();
  if ((rem1 > 0 || rem2 > 0) && now - last >= (unsigned long)stepMs) {
    last = now;
    if (rem1 > 0) { idx1 = (idx1 + dir1 + 4) % 4; applyMotor(M1, idx1); if (--rem1 == 0) offMotor(M1); }
    if (rem2 > 0) { idx2 = (idx2 + dir2 + 4) % 4; applyMotor(M2, idx2); if (--rem2 == 0) offMotor(M2); }
  }
}
