#include <Servo.h>

// 핀 번호 지정
#define ServoH 12
#define ServoB 11

#define J1_PIN A0
#define J2_PIN A1
#define J3_PIN A2
#define J4_PIN A3

#define PV_PIN A4

// 서보 지정
Servo myservo1;
Servo myservo2;

// 각도 및 제어 변수 지정
int degree1 = 90;
int degree2 = 90;
int moves = 4;

float s_top = 0;
float s_bottom = 0;
float s_right = 0;
float s_left = 0;

int PV = 0;
float PV0 = 0;

void setup() {
  Serial.begin(9600); // 시리얼 통신 시작
  myservo2.attach(ServoH); // 서보 실행H(상)
  myservo1.attach(ServoB); // 서보 실행B(하)
  myservo1.write(90); // 서보 초기 값 90도 설정
  myservo2.write(90); // 서보 초기 값 90도 설정
  delay(2000); // 딜레이 2초
}

void loop() {
    delay(15);
    PV = analogRead(PV_PIN);
    PV0 = PV * (5.0 / 1023.0);
    
    // 조도 센서 채널 별로 변수에 값 저장
    int J1 = analogRead(J1_PIN);
    int J2 = analogRead(J2_PIN);
    int J3 = analogRead(J3_PIN);
    int J4 = analogRead(J4_PIN);

    // 상하좌우 조도 값 계산
    int top = J1 + J4;
    int bottom = J2 + J3; //아래 합
    int right = J2 + J1; //오른쪽합
    int left = J3 + J4; //왼쪽합

    // 상하좌우 조도 차 계산
    int difftb = top - bottom;
    int diffrl = right - left;
    
    //계산 값 if 문:  빛 양에 따라 가장 밝은 쪽으로 이동 
    if (diffrl > moves) {degree1--;}
    else if (diffrl < -moves) {degree1++;}
    degree1 = constrain(degree1,30,150);
    myservo1.write(degree1);

    if (difftb > moves) {degree2++;} 
    else if (difftb < -moves) {degree2--;;}
    degree2 = constrain(degree2,0,115);
    myservo2.write(degree2);

    // 태양광 패널에서 출력되는 전압 값 시리얼 모니터로 확인
    Serial.print("Panal: ");
    Serial.print(PV0);
    Serial.println("V");
}


