int PV = 0; // A4 아날로그 값 변수 (0~1023)
float PV0 = 0; // 패널 전압 값 변수 (0~5V)

void setup() {
  Serial.begin(9600);
}

void loop() {
  delay(1000); // 딜레이 1초
  PV = analogRead(A4); // A4 아날로그 값 지정
  PV0 = PV * (5.0 / 1023.0); // 전압 값 계산

  Serial.print("Panal: ");
  Serial.print(PV0);
  Serial.println("V"); // 전압 값 출력
}
