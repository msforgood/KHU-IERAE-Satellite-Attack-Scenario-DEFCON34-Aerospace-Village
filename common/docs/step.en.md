### Demo Steps

```
① Command Assembly         ② IQ Generation           ③ Satellite Aiming             ④ Transmit                    ⑤ Damage
Command Builder     ─▶     attack.cf32          ─▶    Aim/align virtual         ─▶   Virtual Antenna transmits IQ  ─▶   victim ground station
web screen                 (IQ signal file)           satellite via                  (uplink launch)                dashboard alert
                                                      gpredict + Virtual Antenna                                    (web screen)

                                                      └▶ 📡 antenna motor             └▶ 🛰️ solar panel motor
                                                      left↔right aim sweep            infinite rotation
```

| Step                   | Where                                      | Physical Motor                                |
| ---------------------- | ------------------------------------------ | --------------------------------------------- |
| **① Command Assembly** | Command Builder web (`:8000`)              | —                                             |
| **② IQ Generation**    | Command Builder `GENERATE` → `attack.cf32` | —                                             |
| **③ Satellite Aiming** | gpredict + OpenVSA(Virtual Antenna)        | 🛰️ **antenna stepper motor** left↔right sweep |
| **④ Transmit**         | OpenVSA `TRANSMIT`                         | ☀️ **solar panel servo** infinite rotation    |
| **⑤ Damage**           | victim ground station dashboard (`:4540`)  | (① ③ ④ motor states persist)                  |
