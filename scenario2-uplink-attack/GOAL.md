
## Scenario 2: `Uplink Attack`

> We don't need to develop "real communication".
> 

### Equipments

- Laptop
: Participants will use our laptop to try our scenarios.
- Toy Satellite + HackRF
[**(가장 적합)**아두이노 인공위성 체험 키트](https://app.notion.com/p/32d4f0cbfedf8078aca4df1940cd956b?pvs=21)
- Toy Antenna + HackRF
[3D 프린팅 + 아두이노](https://app.notion.com/p/3D-3324f0cbfedf80299485dd2fdac2ab2f?pvs=21)
- mini PC + monitor (If we are planning to visuallize with GS Web UI)

### Scenario

![image.png](attachment:0e5b28d6-68eb-49a8-a56e-a4733b4e89da:image.png)

![image.png](attachment:4d835920-8bf5-4508-88ce-54fb2cf25d1a:image.png)

> Simmilar with last year, but visualize physically

1. Generate a forged command based on the satellite's command structure.
2. Configure the antenna to point at the satellite using virtual TLE data.
3. Once the antenna and satellite are aligned, the satellite executes the stored command.
4. The solar panel that was tracking the sun rotates uncontrollably at the precise timing.

**Flow**
**Generate a forged command** based on the satellite's command system 
→ **configure the antenna** to point at the satellite using virtual TLE data 
→ once the antenna and satellite are aligned, the satellite executes the stored command 
→ the solar panel that was tracking the sun (light bulb) **rotates uncontrollably**.

### Core Message

- Even a legitimate command can become an attack when it is abused.
- Command transmission requires several elements (antenna position, correct angle, and RF parameter configuration).
- Understand the satellite's command delivery structure.


1. 사용자 랩탑에 파이썬 스크립트 or 패킷 생성기
-> 가이드라인에 따라 명령 패킷을 생성(cf32 형태로 출력)
-> 이걸 Virtual Antenna에 전송
입력 -> cf32(IQ파일)

2. 사용자 랩탑에 Virtual Antenna
-> 사용자가 직접 조작하여 파라미터, TLE 정보를 설정(위성 정보, 채널만 맞춰주면 됨)
-> uplink로

3. 윈도우 PC에 GS
-> 웹 UI 구성 -> 업링크로 데이터 쏘면 웹UI에서 어노말리 출력(누가봐도 위험해 보이도록)


- Virtual Antenna 소스코드 참고
https://github.com/whal-e3/OpenVSA

- 솔라패널 동작 아두이노 코드
https://drive.google.com/drive/folders/17W4ustcmgi_ySql0hwnciw6HS74k5FlB

- Brain Stroming for new Scenarios
https://www.notion.so/DEF-CON-BoothMeeting-Summary-853567ff98af82c09d7301b2991f73a0?source=copy_link

- Explaination for final Scenarios
https://www.notion.so/seoppak/Final-Scenarios-3784f0cbfedf8031ab1ce1f6df0bf14f?source=copy_link

- Our Plan for Develop Scenarios
https://www.notion.so/seoppak/Implementation-Plan-3874f0cbfedf807bb0ccc0eeeb59d8d2?source=copy_link