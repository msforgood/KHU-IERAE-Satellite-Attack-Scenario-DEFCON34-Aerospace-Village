### 시연 단계

```
① 명령 조립          ② IQ 생성        ③ 위성 조준              ④ 송신                ⑤ 피해
Command Builder ─▶ attack.cf32 ─▶ gpredict+Virtual Antenna로  ─▶ Virtual Antenna가 IQ 송신 ─▶ victim 지상국
웹 화면             (IQ 신호파일)     가상 위성 조준·정렬        (uplink 발사)          대시보드 경보
(4스텝 퍼즐)                         └▶ 🛰️ 안테나 모터           └▶ ☀️ 솔라패널 모터    (웹 화면)
                                        좌↔우 조준 스윕            무한 회전
```

| 단계            | 어디서                                     | 물리 모터                         |
| --------------- | ------------------------------------------ | --------------------------------- |
| **① 명령 조립** | Command Builder 웹 (`:8000`)               | —                                 |
| **② IQ 생성**   | Command Builder `GENERATE` → `attack.cf32` | —                                 |
| **③ 위성 조준** | gpredict + OpenVSA(Virtual Antenna)        | 🛰️ **안테나 스텝모터** 좌↔우 스윕 |
| **④ 송신**      | OpenVSA `TRANSMIT`                         | ☀️ **솔라패널 서보** 무한 회전    |
| **⑤ 피해**      | victim 지상국 대시보드 (`:4540`)           | (①③④ 모터 상태 지속)              |
