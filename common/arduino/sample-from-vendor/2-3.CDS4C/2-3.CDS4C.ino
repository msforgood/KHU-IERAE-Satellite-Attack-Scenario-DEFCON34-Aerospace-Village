void setup() {
  Serial.begin(9600); // 시리얼 통신 시작
}

void loop() {
  int J1 = analogRead(A0); // J1 조도 값
  int J2 = analogRead(A1); // J2 조도 값
  int J3 = analogRead(A2); // J3 조도 값
  int J4 = analogRead(A3); // J4 조도 값
  
  //시리얼 모니터 J1~J4 조도 값 출력
  Serial.print("J1:");
  Serial.print(J1);
  Serial.print(" ,J2:");
  Serial.print(J2);
  Serial.print(" ,J3:");
  Serial.print(J3);
  Serial.print(" ,J4:");
  Serial.println(J4);
  delay(1000);
}
