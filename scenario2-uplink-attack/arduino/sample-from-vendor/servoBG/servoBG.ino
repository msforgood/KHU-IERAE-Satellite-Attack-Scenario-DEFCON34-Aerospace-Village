// 조립 전 서보 각도를 맟춰주는 코드 입니다.
// 서보를 연결하고 초기 값을 잡은 뒤 조립합니다.

#include <Servo.h>

#define ServoH 12
#define ServoB 11

// 조립 전 서보 초기 값 설정
void setup() {
  myservo1.attach(ServoB); 
  myservo2.attach(ServoH); 
  myservo1.write(90);
  myservo2.write(90);
}

void loop() {

}
