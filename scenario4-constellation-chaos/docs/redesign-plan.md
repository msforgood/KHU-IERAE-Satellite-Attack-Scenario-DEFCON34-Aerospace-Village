# 시나리오 4 재설계 계획서

> 이 문서는 orbital mechanics + cFS/CCSDS 웹 리서치와 대립 검증(11개 에이전트)을 근거로 작성한 설계안입니다. 구현 전 검토용 초안입니다.

## 0. 확정된 설계 결정 (사용자 승인, v2)

아래 3개 결정이 이 문서의 이후 내용보다 우선한다.

1. STAGE 1 기하는 현실적 버전으로 간다 (고도 = 게이트, 궤도면 = 충돌 기하). M0 물리로 실측한 결과, 원궤도끼리는 반지름만 같으면 궤도면이 아무리 달라도 항상 교차하고(고도 매칭이 교차의 유일한 게이트), 궤도면을 교차의 필수 조건으로 만들려면 두 면이 크게 달라야 하는데 그 면 변경 delta-v가 비현실적으로 크다(15도 약 2 km/s, 185도 약 15 km/s). 그래서 "궤도면 정렬 필수 + 현실적 delta-v"는 동시 성립 불가다. 최종: 상하(고도) 기동이 교차를 성립시키는 주 게이트, 좌우(작은 교차방향) 기동은 피해자 이심궤도 위에서 충돌 지점(근지점측 고속 vs 원지점측 저속)과 상대속도를 정하는 의미 있는 조작. 진짜 난이도는 STAGE 2 타이밍. delta-v는 현실적(수백 m/s ~ 2 km/s).
2. STAGE 2 제어는 delta-v 직접 입력으로 시작한다. 체험자가 위상 기동 delta-v(및 바퀴 수 k, 앞당김/늦춤)를 직접 입력한다. 너무 어려우면 이후 "앞당김/늦춤 + k만 고르면 delta-v 자동 산출"로 낮춘다.
3. 위상 기동 재생은 근사를 허용한다. delta-v와 충돌 시각 T 숫자는 공식으로 실제 계산해 표시하되, 위상궤도 이심 구간의 정확한 propagation은 스크립트 애니메이션으로 근사한다.

이 결정에 따라 2장 피해자를 이심궤도로 두고(궤도면 조작이 충돌 지점 선택으로 의미를 갖게), 궤도면 차이는 작게(수 도) 둔다. 물리 근거는 M0 공유 코어(collision-core.js)와 그 단위 테스트로 검증했다.

---

# 시나리오 4 재설계 계획: 2단계 궤도 충돌 공격

## 1. 새 컨셉과 전제

### 컨셉 한 줄 요약
공격자는 이미 위성을 완전히 장악한 상태다. 남은 문제는 "정상적인 기동 명령 하나로 이 위성을 다른 위성과 실제로 충돌시키는 것"이다. 충돌은 두 개의 독립 조건을 모두 만족해야만 일어난다. 첫째, 두 궤도가 공간에서 만나야 하고(공간 조건, STAGE 1), 둘째, 두 위성이 그 만나는 지점에 같은 순간 T에 도착해야 한다(시간 조건, STAGE 2). 체험자는 이 두 조건을 순서대로 풀어낸다.

### 전제
- **위성 100% 장악 전제.** 공격자가 이미 위성의 명령 체계를 완전히 통제한다고 가정한다. 따라서 RF 수신, OOK 변조, 주파수/도플러/보드레이트 같은 무선 계층 파라미터는 이 시나리오에서 전부 제거한다. 이것들은 "명령이 위성까지 어떻게 전달되는가"의 문제인데, 이미 장악했으므로 다룰 필요가 없다. (시나리오 2에서 이 무선 계층을 다루므로, 시나리오 4는 그 뒤 단계인 "장악된 위성을 어떻게 무기화하는가"에 집중한다는 위치 설정을 UI 상단에 한 줄로 명시한다.)
- **두 궤도 모두 고정.** 공격자 위성(ENIGMA-1)과 피해 위성(AURORA-2)의 궤도는 시작부터 고정된 값으로 주어진다. 체험자는 "궤도를 자유롭게 바꾸는" 것이 아니라, 고정된 두 궤도 사이에서 충돌을 성립시키는 기동값을 계산한다.
- **건강 GIF/심전도 텔레메트리 제거.** 현재 모니터 2의 네 채널 ECG 파형(BEACON/ATTITUDE/POWER/DOWNLINK)은 물리적 의미가 없는 장식이므로 삭제한다. 대신 실제 관제사가 쓰는 근접 경고(CDM, Conjunction Data Message) 형식의 패널로 대체한다.
- **핵심 메시지 유지 + 실제 사례 인용.** "위성 하나의 충돌이 군집 전체로 번진다"는 메시지는 유지하되, 실제 사례로 못을 박는다. 2009년 2월 10일 **Iridium 33 (운용 중, 560 kg) 과 Cosmos 2251 (폐기, 950 kg, 1995년부터 제어 불능) 이 약 789 km 고도, 상대속도 약 11.7 km/s 로 충돌**했다. 이 충돌은 관측 가능한 파편만 2,000개 이상을 만들었고, 15년이 지난 2024년에도 1,100개 이상이 여전히 궤도에 남아 있다. 이 사례가 시나리오의 앵커다. 죽어서 아무도 조종하지 않는 위성조차 운용 중인 위성을 파괴하고, 그 파편 구름이 수십 년간 이웃 위성들을 위협한다. 모니터 2에서 파편이 퍼지며 인접 군집 위성 2~3기를 추가로 때리는 연쇄(Kessler syndrome)를 시각화한다. 2013년 러시아 BLITS 위성이 2007년 Fengyun-1C 파괴 시험의 파편에 맞은 것으로 추정되는 사례가 이 "하나가 여럿을 위협한다"는 논리의 실제 증거다.

---

## 2. 고정 궤도 정의

### 프레임 선언
아래 요소는 모두 **TEME(True Equator, Mean Equinox) 관성 직교 좌표계**를 데모의 ECI로 채택한 것을 전제로 한다(3장 참조). 지구 중심 관성계이며, 길이 단위는 계산 내부에서 미터(m)를 쓴다. mu = 3.986004418 x 10^14 m^3/s^2, 지구 적도 반지름 Re = 6378.137 km.

### 궤도 요소 (Keplerian) - M1에서 확정, collision-core로 검증
피해자를 **이심궤도**로 두고 궤도면을 크게 벌린다(0장 결정 1의 현실적 버전). 두 위성 모두 근극 궤도지만 RAAN이 약 125 deg 벌어져 궤도면이 가파른 각도로 교차한다. 그래서 충돌 상대속도가 약 13 km/s(2009 Iridium-Cosmos 급)로 극적이다. 고도가 교차의 게이트이므로, 이 큰 면차에도 공격자는 여전히 싸게 푼다(궤도면 정렬 비용을 낼 필요가 없다).

| 요소 | 기호 | ENIGMA-1 (공격자) | AURORA-2 (피해자) |
|---|---|---|---|
| 반장축 | a | 6978.137 km (고도 600 km, 원궤도) | 7578.137 km (평균고도 1200 km) |
| 이심률 | e | 0.0 | 0.08 (근지점 594 km, 원지점 1806 km) |
| 궤도경사각 | i | 97.8 deg | 98.6 deg |
| 승교점 적경 | Omega (RAAN) | 25.0 deg | 150.0 deg |
| 근지점 편각 | omega | 0 deg | 0 deg |
| 초기 진근점이각 | nu0 | 0 deg | 90 deg |

설계 의도(검증 완료): 시작 MOID는 약 241 km라 교차하지 않는다. STAGE 1은 상하(고도) 기동이 게이트다. 공격자가 원형 고도를 피해자 반지름 범위(594~1806 km)로 올리면 두 대원이 교차해 MOID가 0으로 떨어진다(원형 목표 고도는 600~1600 km 넓은 구간에서 풀리고, Hohmann delta-v는 약 수백 m/s로 현실적). 좌우(작은 교차방향) 기동은 피해자 이심궤도 위에서 충돌 지점을 근지점측(고속)~원지점측(저속)으로 옮겨 상대속도를 정하는 의미 있는 조작이다. 초기 nu0가 90 deg 벌어져 있어 기하만 맞춰서는 시간이 어긋난다(둘이 동시에 그 점에 없음). 이 시간차를 STAGE 2의 위상 기동으로 메운다. 이 모든 수치는 satellite-sim/collision-core.js와 test-scenario.js로 검증했다.

### TLE 스타일 라인 (Intel 단계에서 체험자에게 제시)
아래는 위 요소를 TLE 형식으로 표현한 것이다(체크섬은 데모용 임의값, 실제 propagation은 위 Keplerian 요소로 수행하고 TLE는 "받아서 파싱하는 입력물"로만 사용).

```
ENIGMA-1
1 90001U 24001A 26201.50000000 .00000000 00000-0 00000-0 0 9991
2 90001 97.8000 25.0000 0000100 0.0000 0.0000 14.90000000000010

AURORA-2
1 90002U 24002A 26201.50000000 .00000000 00000-0 00000-0 0 9992
2 90002 98.6000 150.0000 0800000 0.0000 90.0000 13.40000000000025
```

(라인 2의 필드 순서: 경사각, RAAN, 이심률(소수점 생략 0000100=0.0000100), 근지점편각, 평균근점이각, 평균운동[rev/day]. 평균운동 14.9와 14.2는 각각 고도 600 km, 820 km에 해당하는 값을 반올림한 것으로, 체험자가 "평균운동이 다르다 = 주기가 다르다 = 고도가 다르다"를 직접 읽어낼 단서다.)

---

## 3. 좌표계 선택

### 표준 프레임: TEME 직교 (데모의 ECI)
데모 전체를 **하나의 지구 중심 관성 직교 좌표계 (x, y, z)** 로 통일한다. 구체적으로는 TLE/SGP4 계열이 원래 내보내는 프레임인 **TEME**를 그대로 데모의 ECI로 삼는다.

이유: 충돌은 "같은 순간에 두 위치 벡터가 일치하는 것"이므로, 직선 거리(straight-line distance)가 물리적 의미를 갖는 단일 관성 직교계에서 표현해야 한다. TLE 입력을 파싱해 propagation하는 순간 이미 TEME에 들어와 있으므로, 두 위성을 같은 TEME에서 전파하면 프레임 간 회전 없이 상대 벡터와 최소거리가 정확하게 나온다.

**검증 반영(중요):** TEME는 J2000/GCRF와 다르다. TEME는 진적도(true equator)와 평균 분점(mean equinox)을 쓰고 장동(nutation)을 적경 기준에 반영하지 않아, J2000과는 연간 수 밀리초각(mas) 어긋난다. 데모 스케일에서는 이 차이가 보이지 않으므로 TEME를 J2000으로 변환하지 않고 그대로 쓴다. 다만 코드/문서에서 이 프레임을 "J2000"이라고 잘못 라벨링하지 않는다. 또한 SGP4의 native 출력 단위는 **km/(km/s)** 이지 미터가 아니므로, 내부 계산을 미터로 할 경우 스케일링을 명시적으로 처리한다. ECEF/ITRF(지구 고정 회전계)에서는 절대 충돌을 계산하지 않는다. 고정된 관성 조우가 회전계에서는 움직이는 것처럼 보이기 때문이다. 궤도요소 공간(element space)의 차이도 물리 거리가 아니므로 쓰지 않는다.

**충돌점 표현에 대한 정직한 단서(검증 반영):** 관성 직교계는 데모의 월드/충돌 좌표 container로는 타당한 단순화지만, 실무자가 충돌점 자체를 표현하는 프레임은 아니다. 실제 근접 평가는 최근접시각(TCA)에서의 상대 프레임(RTN/RIC/LVLH) 또는 b-plane(상대속도에 수직인 평면)에서 표현한다. 따라서 UI 문구는 "충돌점을 표현하는 올바른 프레임"이 아니라 "데모용으로 합리적인 단순화"라고 쓴다. 그 위에 **RTN/RIC 읽기 패널**을 파생 뷰로 얹어, 두 위성의 최소거리를 반경(Radial)/진행방향(In-track)/교차방향(Cross-track) 성분으로 분해해 "얼마나 가까웠나"를 직관화한다. 지상국 관측각은 지형 중심 SEZ(방위각/고도각)로 별도 표시한다.

### 고려한 좌표계 분류 (한 문단)
**지구 중심 관성계(ECI/TEME/J2000)** 는 별에 대해 고정된 축을 가진 계로, 관성 운동과 충돌을 표현하는 기본 무대다(우리가 채택). **지구 고정계(ECEF/ITRF)** 는 지구와 함께 회전하는 계로 지상 위치에는 맞지만 관성 조우 계산에는 부적합하다. **근초점계(PQW/perifocal)** 는 궤도면 안에서 근지점을 향하는 축을 가진 계로, 궤도요소를 상태벡터로 변환하는 중간 단계다. **상대 프레임(RTN=RIC=LVLH)** 은 기준 위성 중심의 회전계로 근접 기하 분해에 최적이다. **지형 중심계(SEZ)** 는 지상국 지평선 기준으로 방위/고도각을 준다. **일심계(heliocentric)** 는 태양 중심으로 행성간 궤적에만 필요하며 지구 저궤도 데모에는 불필요하다. **궤도 유형** 은 이 데모가 다루는 LEO(고도 2000 km 이하), 특히 태양동기궤도(SSO, 고도 약 600~800 km, 경사각 약 98 deg, 각 위도를 같은 지방시에 통과)를 전면에 둔다. 대비용으로 GEO(정지궤도, 고도 35786 km) 하나를 시각적 참조로만 곁들여, 왜 LEO 혼잡이 충돌 연쇄의 무대인지 보여준다. Molniya/HEO/MEO/GTO는 언급만 하고 다루지 않는다.

---

## 4. 물리 모델

### 좌표 변환: 궤도요소 -> ECI
근초점계에서 상태를 만들고 3-1-3 회전으로 ECI로 옮긴다.

```
p = a(1 - e^2) # 반통경(semi-latus rectum)
r = p / (1 + e cos nu) # 반지름
r_pqw = [ r cos nu, r sin nu, 0 ]
v_pqw = sqrt(mu/p) * [ -sin nu, e + cos nu, 0 ]

Q = R3(-Omega) R1(-i) R3(-omega) # 3-1-3 회전 (순서: omega -> i -> Omega)
r_ECI = Q r_pqw, v_ECI = Q v_pqw
```

합성 회전행렬(c=cos, s=sin, O=RAAN, w=argp, i=inc):
```
row1 = [ cO cw - sO sw ci, -cO sw - sO cw ci, sO si ]
row2 = [ sO cw + cO sw ci, -sO sw + cO cw ci, -cO si ]
row3 = [ sw si, cw si, ci ]
```

### 엔진: 케플러 3법칙 + vis-viva (실시간 계산)
주기는 오직 반장축 a에만 의존한다. 이것이 시간 제어의 핵심이다.
```
T = 2 pi sqrt(a^3 / mu) # 케플러 3법칙, T ∝ a^(3/2)
a = ( mu T^2 / (4 pi^2) )^(1/3) # 원하는 주기를 낼 a
v = sqrt( mu (2/r - 1/a) ) # vis-viva: 반지름 r에서의 속력
```

### STAGE 1 실시간 계산: 수치 MOID (조밀 샘플링 최소거리)
두 궤도를 진근점이각 nu에 대해 각각 수백 점(예: 720점, 0.5 deg 간격)으로 3D 샘플링하고 최근접 점쌍을 찾는다. 그 최소거리가 실시간 MOID, 그 중점이 후보 충돌점이다.
```
각 궤도에 대해 nu = 0..2pi 를 N등분, r = a(1-e^2)/(1+e cos nu), 위 3-1-3 회전으로 3D 점 생성
MOID = min over (i,j) | P1_i - P2_j |
교차 판정: MOID < epsilon (예: 7000 km 궤도에서 epsilon 몇 km)
```
**검증 반영:** 필요조건은 MOID가 정확히 0(엄밀한 면 교차)이 아니라 **MOID < 충돌 반경**(두 물체 하드바디 반지름의 합, 실무에선 위치 불확실성까지 더함)이다. 그래서 epsilon을 0이 아니라 유한한 몇 km로 잡는 것이 물리적으로도 옳다. 또한 진짜 최근접은 대개 두 물체가 정확히 교점선상 노드에 있을 때가 아니라는 점을 UI 각주로 명시한다. 샘플 수가 적으면 스치는 교차를 놓치니, 최적 점쌍 근처를 한 번 더 세분(refine)한다.

### STAGE 2 실시간 계산: 위상 기동 (phasing maneuver)
궤도가 고정되면 속력도 결정된다. 하지만 추진계를 건드릴 수 있으면, 잠깐 다른 주기의 궤도로 빠졌다가 정수 바퀴 돈 뒤 원궤도로 복귀시키면 **같은 궤도 위에서 도착 시각만 앞/뒤로 이동**시킬 수 있다. 이것이 위상 기동이며, 이 시간 이동으로 충돌 시각 T를 맞춘다.

```
n0 = sqrt(mu / a0^3) # 원궤도 평균운동
phi = 맞춰야 할 위상각 차이(rad) # STAGE 1 충돌점 도착시각 차에서 유도
dt = phi / n0 # 좁혀야 할 along-track 시간(초)

# k바퀴 동안 dt를 벌어들이는 위상궤도 주기:
T_phase = T0 - dt/k (앞당김) 또는 T0 + dt/k (늦춤)
a_phase = ( mu T_phase^2 / (4 pi^2) )^(1/3)

# 두 번의 등가 반대 임펄스, 버스트 지점(=위상궤도의 apo/perigee)에서:
delta_v_total = 2 * | sqrt(mu(2/r - 1/a_phase)) - sqrt(mu(2/r - 1/a0)) |

# 1차 근사 관계(작은 기동에서만 유효):
dT/T = 1.5 * da/a
lead_per_orbit = 3 pi * da / a0
```
**검증 반영(정직성):** (1) along-track 시간 이동은 **버스트 지점에서** 실현되며, 그 지점이 위상궤도의 원지점/근지점이 된다. 위상궤도로 빠져 있는 동안 위성은 "같은 궤도"가 아니라 **이심 궤도** 위에 있다. 균일한 시간 편차는 원궤도 복귀 이후에만 모든 점에 적용된다. UI는 "같은 궤도에서 빨라진다/느려진다"를 복귀 전후에만 참인 멘탈 모델로 제시한다. (2) 시간 이동은 연속 throttle이 아니라 **delta-v 크기(=da 크기)를 정수 바퀴에 걸쳐** 정하는 이산 제어다. (3) "정확히 복귀하면 깔끔한 시간 편차"는 이체문제 이상화다. 실제 LEO에서는 J2와 항력이 a와 위상을 계속 바꿔 station-keeping으로 싸워야 한다.

### 부수 효과 (flavor로만 표시, 실시간 미계산 또는 1차 근사)
600~800 km LEO에서 섭동 순위와 표시 방식:
```
1) 중심 중력 g = mu / r^2 (지표 9.8, 700 km 약 7.96 m/s^2) - 이미 케플러/vis-viva 안에 포함, 데모엔 한 줄 캡션만
2) J2 편평도 dRAAN/dt = -1.5 n J2 (Re/(a(1-e^2)))^2 cos i, J2 = 1.08263e-3
              (800 km, 56 deg에서 약 -3.68 deg/day) - 궤도면이 서서히 도는 것을 flavor로 표시
3) 대기 항력 da/dt = -B rho v a, B = Cd A/m - 600 km에서 강하고 800 km에서 약함, 태양활동에 따라 요동. 문구로만
4) 태양/달 3체, 태양복사압(SRP) - 아주 작은 nudge. 언급만
```
표시 원칙: **케플러 3법칙과 vis-viva만 실시간으로 궤도/시간을 구동**한다. J2 세차, 항력 감쇠, 3체/SRP, 고도에 따른 중력 변화는 "실제로는 이런 힘들이 더 있다"를 보여주는 캡션/보조 게이지로만 등장시켜, 물리적 깊이는 확보하되 계산 복잡도는 폭발시키지 않는다. 검증 주의: 표에 인용된 가속도 크기는 Montenbruck & Gill Table 3.1 순위에 근거한 자릿수(order-of-magnitude) 값이므로 "약"으로 표기한다.

---

## 5. 단계별 체험 재설계

### Intel: 두 TLE 수신 + 파싱
- **보이는 것:** 화면에 두 위성의 TLE 원문 2블록(2장)이 도착한다. "위성을 이미 장악했다. 목표는 이 ENIGMA-1을 AURORA-2와 충돌시키는 것" 브리핑.
- **하는 것:** [TLE 파싱] 버튼을 누르면 각 위성의 궤도요소(a, e, i, Omega, omega, nu0)와 고도/주기가 표로 전개된다. 체험자는 "RAAN이 같고 고도/경사각이 다르다"를 읽는다.
- **계산:** TLE -> 궤도요소 -> 초기 ECI 상태벡터. 두 궤도를 3D 시뮬레이션에 그린다(교차 안 함, 시간도 어긋남).

### STAGE 1 (공간/기하): 궤도를 교차시켜 충돌점 좌표 도출
- **보이는 것:** 3D 위성 시뮬레이션에 두 궤도 링. 하단에 **상/하(고도 = prograde/retrograde delta-v), 좌/우(궤도면 = 경사각/RAAN)** 추진값 입력창. 입력창은 직접 타이핑 + / - 버튼 둘 다 가능. 실시간으로 예상 궤도 링이 다시 그려지고, **MOID 값이 큰 숫자로 줄어드는 것**이 보인다.
- **하는 것:** 2단계 가이드. (1) 먼저 궤도면을 맞춘다(이 설계에선 RAAN이 이미 같으므로 경사각을 0.8 deg 좁히는 미세 조정). (2) 다음 교점선 근처 반지름을 맞춘다(고도를 600 km에서 820 km 쪽으로 올려 apogee/perigee를 피해자와 겹치게). MOID가 epsilon 아래로 떨어지면 "궤도 교차 성립 - 충돌점 좌표 확보" 표시.
- **계산:** 매 입력마다 수치 MOID(4장) 재계산. 충돌점 = 최근접 점쌍 중점, **TEME 직교 (x, y, z)** 로 표시(예: X=+3120 km, Y=-5870 km, Z=+2010 km). RTN 패널에 radial/in-track/cross-track 분해도 함께.
- **핵심 교훈:** 기하 교차는 충돌의 **필요조건일 뿐, 충분조건이 아니다.** 이 시점에 두 위성은 같은 점을 지나지만 서로 다른 시각에 지난다(아직 안 부딪힘). 그래서 STAGE 2가 필요하다.

### STAGE 2 (시간/위상): T에 도착시키는 위상 기동 계산
- **보이는 것:** "두 위성이 충돌점을 지나는 시각이 dt 초 어긋나 있다"는 표시와, 이를 메우는 위상 기동 컨트롤(몇 바퀴 k, 앞당김/늦춤). delta-v와 버스트 타이밍이 실시간으로 갱신되고, 예상 충돌 시각 T가 카운트다운으로 뜬다.
- **하는 것:** 위상궤도로 몇 바퀴 돌지, 앞당길지 늦출지 선택. 시뮬레이션이 위상궤도(살짝 이심)로 빠졌다가 복귀하며 along-track이 이동하는 것을 미리보기로 보여준다.
- **계산:** phi -> dt -> T_phase -> a_phase -> delta_v_total (4장의 위상 공식). 여기서 미분방정식적 요소(케플러 방정식 M = E - e sinE 을 뉴턴법으로 풀고, dM/dt = n 으로 시간을 적분)가 실제로 들어간다. dT/T = 1.5 da/a 로 민감도를 게이지에 표시.
- **핵심 교훈:** 궤도가 고정되면 속력도 고정되지만, 추진계를 잠깐 건드려 궤도를 바꿨다 되돌리면 같은 궤도 위 도착 시각을 조절할 수 있다. 이것이 정상 기동 명령을 무기로 바꾸는 지점이다.

### 패킷 제작: 계산된 기동 -> cFS/CCSDS 명령
- **보이는 것:** STAGE 2에서 나온 delta-v 벡터(RIC 3성분, m/s)와 실행 시각 T가 자동으로 채워진 CCSDS Space Packet 편집기. 시나리오 2와 유사한 바이트 덤프 뷰이되, 이번엔 각 바이트가 물리량으로 해석된다(6장).
- **하는 것:** 함수코드(START BURN)와 APID(추진 앱)를 선택/확인하고, delta-v와 실행시각이 페이로드의 어느 바이트에 들어가는지 하이라이트로 확인. 길이 필드가 자동 갱신되는 것도 본다.
- **계산:** 요소를 IEEE-754 float32(big-endian)로 인코딩, CCSDS 헤더 구성, 길이 = 총바이트 - 7, 함수코드 secondary header, XOR 체크섬.

### 업링크 + 관측: 전송 후 T에 충돌(또는 빗나감 + 재시도)
- **보이는 것(모니터 1):** [업링크 전송] (시나리오 2와 동일한 전송 UI 사용, 단 RF 파라미터 없이 "명령 주입"으로 추상화). 예상 충돌까지 카운트다운.
- **보이는 것(모니터 2):** 시뮬레이션이 위상 기동을 재생하고, 시각 T에 충돌하면 폭발 이펙트 -> 파편 구름 확산 -> 인접 군집 위성 2~3기 추가 피격(연쇄) 영상. 화면에 "789 km, 11.7 km/s, 파편 2000+개, 15년 뒤에도 1000+개 잔존" 라벨. 지상국 패널에 CDM 형식 경고(miss distance, TCA, Pc가 1e-4 임계 초과).
- **빗나감 시:** MOID 또는 T가 어긋나면 "충돌 실패" -> 모니터 1에 **[처음으로 - 각도 재계산]** 초기화 버튼. 누르면 모니터 2도 초기 상태로 리셋.

---

## 6. 패킷 페이로드 바이트맵

**검증 반영(정직성):** cFS 표준 command secondary header는 오직 함수코드 + 체크섬(2바이트)뿐이며, **실행시각과 delta-v는 표준 헤더가 아니라 앱이 정의하는 페이로드**에 들어간다. 체크섬은 CRC가 아니라 8비트 XOR(전체 바이트 XOR, 유효값 0)이다. 일회성 기동 명령은 시각 필드 없이 수신 즉시 실행할 수도 있으며, 시각 지정 실행은 원래 cFS의 Stored Command(SC/SCA) 앱이 ATS/RTS 시퀀스 데이터로 처리한다. 아래 실행시각 필드는 "이 데모 앱이 정의한 페이로드 관례"로 제시한다. APID 0x1F0, FC 0x03 등 구체 숫자는 공개 명령 사전에서 가져온 것이 아니라 cFS/CCSDS 관례에 부합하는 그럴듯한 예시임을 명시한다.

### 전체 32바이트 Space Packet 구조

| 영역 | offset | size | type | 단위/포맷 | 의미 |
|---|---|---|---|---|---|
| **Primary Header** | 0 | 2 | uint16 (BE) | 비트필드 | StreamId: version(3b)=0, type(1b)=1 CMD, sechdr flag(1b)=1, APID(11b)=0x1F0 (추진 앱) |
| | 2 | 2 | uint16 (BE) | 비트필드 | Sequence: seq flags(2b)=3 unsegmented, seq count(14b) |
| | 4 | 2 | uint16 (BE) | 정수 | Packet Data Length = 총길이 - 7 = 32 - 7 = 25 = 0x0019 |
| **Cmd Secondary Header** | 6 | 1 | uint8 | 7b + 1b reserved | FunctionCode = 0x03 (START BURN); bit 0x80 예약 |
| | 7 | 1 | uint8 | XOR | cFS 명령 체크섬 (전체 바이트 XOR, 유효=0) |
| **Payload (앱 정의)** | 8 | 6 | CUC time | 4B 초 + 2B 부초 | **실행 시각 T** (STAGE 2의 충돌 순간; epoch 1958-01-01 TAI). 8~11의 4바이트가 데모가 가리키는 coarse 초 |
| | 14 | 1 | uint8 | enum | 기동 모드 (0 관성유지, 1 prograde, 2 RIC-벡터 버스트) |
| | 15 | 1 | uint8 | bitmask | 추진기 선택 비트마스크 |
| | 16 | 4 | float32 (BE) | m/s | **delta-v Radial** (RIC R) |
| | 20 | 4 | float32 (BE) | m/s | **delta-v In-track** (RIC I) - 위상 기동의 주 성분 |
| | 24 | 4 | float32 (BE) | m/s | **delta-v Cross-track** (RIC C) |
| | 28 | 2 | uint16 (BE) | centiseconds | 버스트 지속시간 |
| | 30 | 2 | uint16 (BE) | CRC-16 | 페이로드 무결성 (데모용 보조 필드, cFS 필수는 아님) |

**UI 하이라이트 콜아웃:**
- **바이트 6** = 정상 패킷을 "버스트 명령"으로 바꾸는 단 하나의 함수코드 바이트.
- **바이트 8~13** = 언제 점화하는가(실행 시각 T, STAGE 2 산출).
- **바이트 16~27** = 어느 방향으로 얼마나 미는가(12바이트 delta-v 벡터, RIC 3 x float32, STAGE 2 산출).
- 페이로드 크기를 바꾸면 길이 필드(offset 4)가 총길이 - 7로 실시간 갱신된다. 길이조차 공격자가 통제한다는 점을 보여준다.

**진정성 옵션:** 실제 cFS maneuver/ADCS 앱이 "테이블 로드"와 "실행 트리거"를 분리하듯, 함수코드를 둘로 쪼갤 수 있다(FC로 벡터+시각 로드, 다른 FC로 실행). 시나리오 메시지와 연결: 이 START BURN은 위성을 정상 위치에 유지할 때 쓰는 바로 그 명령이며, delta-v 벡터와 실행시각만 악의적으로 고르면 이웃 위성으로 조종하는 무기가 된다.

---

## 7. 제거/정리 목록

| 대상 | 현재 위치 | 조치 |
|---|---|---|
| RF/OOK/주파수/보드레이트/샘플레이트 | `ccsds_ook.py` (modulate_ook, 100 baud/24 kHz), `c2protocol.json`(RF 필드), attacker `app.js` Phase 3 RF 스텝(bodyRF), `app.py` dossier의 uplinkFreqMHz/modulation | **제거.** 업링크는 "명령 주입"으로 추상화. 파형 미리보기/변조 삭제 |
| 도플러/gpredict 트래킹, antenna/amp 선택 | attacker `app.js` doEngageTracking/doResetPass, setupGpredict, VSA iframe `?auto=uplink&freq=...` | **제거 또는 무해한 stub.** RF 계층 전체가 전제상 불필요 |
| 건강 GIF/ECG 텔레메트리 (4채널 심전도) | victim `frontend/app.js` HB_DEFS/hbSample/killHeartbeat/drawChannel, `index.html` hbEcg0..3 캔버스 | **제거.** CDM 형식 근접경고 패널로 대체 |
| 궤도 자유 튜닝 (자유롭게 반지름/경사각 조정) | attacker `app.js` applyThrust, `scenario.js` ranges | **고정 궤도로 전환.** 자유 튜닝 대신 "고정 두 궤도 사이의 기동값 계산"으로 목적 변경. delta-v 입력 범위만 노출 |
| 2D 평면 물리 (altitude+inc, RAAN 고정, RAAN gate) | `sim.js` _isReachable/_nearestTargetToOrbit, `kepler.js` applyManeuver2D 등 2D 헬퍼 | **3D 궤도요소 + 수치 MOID로 교체.** RAAN gate 하드코딩 삭제 |
| int16 고도/경사각/RAAN 페이로드 (물리적 해석 없는 6바이트) | `ccsds_ook.py` build_payload (>hhh), victim `server.js` decodeManeuver | **RIC delta-v float32 + CUC 시각 페이로드로 교체** |
| 미러 코드 리스크 (충돌 판정이 attacker/victim 양쪽에 중복) | `sim.js` vs victim `server.js` computeOutcome | **공유 모듈로 추출**해 양쪽이 동일 물리 사용 |

---

## 8. 파일별 변경 계획

경로 접두어 생략: `scenario4-constellation-chaos/`

**궤도/물리 코어**
- `satellite-sim/kepler.js` - **대폭 개편.** 2D 헬퍼(elementsToState2D, stateToElements2D, applyManeuver2D)는 유지하되 3D로 승격. 신규: `numericMOID(kep1, kep2, N)` (조밀 샘플링 최소거리 + 중점 충돌점), `phasingManeuver(a0, r, phi, k, dir)` (T_phase/a_phase/delta_v_total 반환), `keplerianToState3D`/`stateToKeplerian3D`(RIC 프레임 변환 포함). period, timeToNu, solveKepler 재사용.
- **신규 `satellite-sim/collision-core.js`** - attacker 콘솔과 victim GS가 **함께 import**하는 단일 진실원본. numericMOID + 위상 기동 + 충돌 시각 T 판정을 여기 모아 미러 코드 제거. (검증 권고 반영)
- `satellite-sim/scenario.js` - **재작성.** 2장의 두 고정 궤도(ENIGMA-1, AURORA-2)로 교체. RAAN gate/answer 플래그 삭제, `ranges`를 delta-v 입력 범위로 변경. 군집 이웃(연쇄 피격용 2~3기)을 파편 시각화 대상으로 추가. collisionThreshold를 MOID epsilon으로 재해석.
- `satellite-sim/sim.js` - **개편.** _isReachable/RAAN gate 제거, setManeuver를 STAGE 1(MOID 실시간)과 STAGE 2(위상 미리보기)로 분리. applyManeuver를 3D 위상 기동으로 교체. 충돌점을 TEME (x,y,z) + RTN 분해로 표시.

**공격자 콘솔 (모니터 1)**
- `attacker/packet-generator/webapp/static/app.js` - **단계 재구성.** 기존 Phase 1(PLAN)을 STAGE 1(기하)+STAGE 2(시간) 두 스텝으로 분리. Intel 스텝(TLE 파싱) 신규. Phase 2(BUILD)는 유지하되 payload 매핑을 6장으로 교체. Phase 3(UPLINK)의 gpredict/RF 스텝 제거, 명령 주입으로 단순화. Phase 4(OBSERVE) 카운트다운은 예상 충돌 T 기반으로 유지. 초기화 버튼(각도 재계산) 유지.
- `attacker/packet-generator/webapp/app.py` - do_build()의 파형 미리보기/변조 breakdown 제거, 대신 바이트맵 해석(offset/type/의미) 반환. dossier의 RF 필드(freq/modulation/baud/sampleRate) 제거.
- `attacker/packet-generator/webapp/static/style.css` - RF 패널/도플러 위젯 스타일 제거, 바이트맵 하이라이트(시각 영역/delta-v 영역 음영) 스타일 추가.

**패킷 인코딩**
- `attacker/openvsa-plugin/demosat/ccsds_ook.py` - **개편.** modulate_ook/preamble/OOK 관련 전부 제거. build_payload를 6장(CUC 6B + mode 1B + mask 1B + RIC float32 x3 + duration 2B + CRC 2B)으로 재작성(struct '>6sBBfffHH' 계열). build_space_packet/build_tc_frame는 헤더 구조 유지하되 secondary header 함수코드 + XOR 체크섬만 남김.
- `attacker/openvsa-plugin/demosat/c2protocol.json` - orbit_maneuver 명령을 START BURN(opcode/FC 0x03, APID 0x1F0)으로 재정의, payload 스키마를 delta-v/시각 필드로 교체. RF 관련 필드 삭제.
- `attacker/openvsa-plugin/demosat/decoder.py` - 디코딩을 새 페이로드 포맷에 맞춰 갱신.
- `attacker/openvsa-plugin/demosat/{panel.json, hardware.json}`, `attacker/openvsa-plugin/hardware-effects.json` - RF 하드웨어(antenna/amp/도플러) 항목 정리.

**피해자 GS + 시뮬레이션 (모니터 2)**
- `victim/frontend/index.html` - hbEcg0..3 캔버스 4개 제거, CDM 경고 패널 + 실제 사례 라벨(789 km/11.7 km/s/파편수) 영역 추가. 상단 3D 시뮬레이션 + 하단 GS 인터페이스 레이아웃 유지.
- `victim/frontend/app.js` - HB_DEFS/hbSample/killHeartbeat/drawChannel/setHbStatus 제거. 충돌 시 파편 구름 확산 + 인접 위성 연쇄 피격 애니메이션 추가. CDM 필드(miss distance/TCA/Pc>1e-4) 렌더링. 초기화 신호 수신 처리 유지.
- `victim/backend/server.js` - computeOutcome을 신규 `collision-core.js` 호출로 교체(미러 코드 제거). decodeManeuver를 새 float32 delta-v 페이로드에 맞춰 갱신. videoPlayed 신호 경로 유지.
- `victim/backend/satellite-state.js` - 3-sat 하드코딩을 scenario.js 공유 정의로 정렬, 연쇄 피격 대상 군집 반영.

**삭제 후보:** OOK 파형/프리앰블 관련 코드 블록, gpredict 브리지 연동 스텁(전제상 불필요 시).

---

## 9. 실현 가능성과 우선순위

### 난이도 평가
- **쉬움(첫 컷에 반드시):** 고정 두 궤도 정의(scenario.js), 궤도요소->3D ECI 변환, 케플러 3법칙/vis-viva 실시간 계산, 페이로드 바이트맵 UI(6장), 건강 GIF 제거, RF 스텝 제거. 이것들은 기존 자산(시나리오 2 패킷 UI, satellite-tracker 궤도 코드) 재활용으로 빠르게 나온다.
- **중간:** 수치 MOID 실시간 계산 + 링 재드로우, RTN/RIC 분해 패널, CDM 경고 패널, 미러 코드를 collision-core.js로 추출.
- **어려움(나중 폴리시):** 위상 기동을 시뮬레이션에서 물리적으로 정확히 재생(위상궤도 이심 구간 -> 복귀 -> along-track 이동)하고 예상 T와 실제 충돌 T를 정확히 일치시키는 것, J2/항력 flavor 게이지.

### 좋은 첫 컷 vs 나중 폴리시
- **첫 컷:** Intel -> STAGE 1(MOID 좁히기) -> STAGE 2(위상값 선택) -> 패킷 -> 업링크 -> 충돌/빗나감의 전체 흐름을 **단순화된 물리로** 관통시킨다. STAGE 1은 MOID 실시간이면 충분. STAGE 2는 phasingManeuver 공식으로 delta-v/T만 산출.
- **나중:** 파편 연쇄 애니메이션 고도화, CDM 실물 필드, J2 세차/항력 캡션, 실제 충돌 영상 교체.

### 신뢰성을 잃지 않고 근사해도 되는 지점
- **위상궤도 재생:** 실제 이심 궤도를 정확히 propagation하지 않고, "몇 바퀴 돌며 along-track이 이동" 을 스크립트된 애니메이션으로 보여줘도 관객은 차이를 못 느낀다. 단, delta-v/T 숫자는 공식으로 진짜 계산해서 표시한다(숫자가 물리적으로 맞아야 신뢰가 산다).
- **부수 섭동:** J2/항력/3체/SRP는 계산에 넣지 않고 캡션/게이지로만 표시. 자릿수만 맞으면 된다.
- **충돌 판정 epsilon:** 몇 km로 잡아 "스치면 충돌"로 처리. 실제 하드바디 반경/Pc 적분은 데모에 불필요.
- **TEME->J2000 변환 생략:** 밀리초각 차이는 부스 스케일에서 안 보이므로 변환하지 않는다.
- **충돌 시각 정합:** 예상 T를 18초 후로 스케일링해 관객이 카운트다운을 볼 수 있게 하되, 내부 물리 시간과 표시 시간의 배속만 일관되게 유지.

---

## 10. 남은 설계 결정 / 오픈 질문 (체험자가 결정)

1. **STAGE 1 난이도.** RAAN을 이미 공유시켜(경사각만 미세 조정) 쉽게 갈지, 아니면 RAAN도 다르게 두어 "궤도면 회전(out-of-plane) delta-v"까지 체험시켜 어렵게 갈지. 부스 회전율과 교육 깊이의 트레이드오프.
2. **위상 기동 제어 노출 수준.** 체험자에게 (a) delta-v를 직접 입력받을지, (b) "앞당김/늦춤 + 바퀴 수 k"만 고르게 하고 delta-v는 자동 산출할지. (b)가 실패율은 낮고 이해도는 높다.
3. **원궤도 vs 이심궤도.** 두 위성을 원궤도(e=0)로 둘지, 피해자에 약간의 이심률을 주어 "고도가 오르내리는 타원"을 보여줄지. 이심률을 주면 STAGE 1 기하가 풍부해지지만 nu 계산이 복잡해진다.
4. **함수코드 분리 여부.** 단일 START BURN(FC 0x03) 하나로 갈지, 실제 cFS처럼 "벡터 로드 + 실행 트리거" 두 FC로 나눠 진정성을 높일지.
5. **실행시각 인코딩.** CUC(6바이트, cFS 기본) vs CDS(6/8바이트). 둘 다 표준이지만 데모 라벨 일관성을 위해 하나로 고정 필요.
6. **연쇄 피격 규모.** 파편이 인접 위성 몇 기를 때릴지(2기 vs 3기), Kessler 캡션을 얼마나 강조할지.
7. **CDM 패널 상세도.** miss distance/TCA/Pc 세 필드만 보여줄지, 공분산/상대속도까지 그럴듯하게 채울지.
8. **초기화 UX.** "빗나감 -> 재계산" 시 STAGE 1부터 다시 시작할지, STAGE 2(위상)만 다시 조정하게 할지.

---

**참고 파일 경로 (절대경로):**
- 궤도 물리: `C:\Users\andre\Desktop\Kyunghee\02. PWNLAB\projects\IERAE\combined\KHU-IERAE-Satellite-Attack-Scenario-DEFCON34-Aerospace-Village\scenario4-constellation-chaos\satellite-sim\kepler.js`, `...\satellite-sim\scenario.js`, `...\satellite-sim\sim.js`
- 공격자 콘솔: `...\scenario4-constellation-chaos\attacker\packet-generator\webapp\static\app.js`, `...\webapp\app.py`, `...\webapp\static\style.css`
- 패킷 인코딩: `...\attacker\openvsa-plugin\demosat\ccsds_ook.py`, `...\demosat\c2protocol.json`, `...\demosat\decoder.py`
- 피해자/GS: `...\victim\frontend\index.html`, `...\victim\frontend\app.js`, `...\victim\backend\server.js`, `...\victim\backend\satellite-state.js`
- 신규 생성 제안: `...\satellite-sim\collision-core.js` (attacker/victim 공유 충돌 물리 모듈)