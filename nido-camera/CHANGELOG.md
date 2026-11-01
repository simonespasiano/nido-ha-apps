# Changelog

## 0.1.1

- L'app usa la rete dell'host: la camera HomeKit manda il video in UDP all'indirizzo di go2rtc e la si trova via mDNS, cose che dalla rete interna dei container non funzionano. Era la causa più probabile della diretta che non parte
- go2rtc su porte proprie (API 18984), per non scontrarsi con il go2rtc interno di Home Assistant; pannello sulla porta 18099
- Se il video MSE non arriva entro 20 secondi la diretta riprova in MJPEG e dice perché
- Si vede da dove arriva la foto: go2rtc oppure la foto HomeKit di Home Assistant (quando go2rtc non dà il video)

## 0.1.0

- Video della camera HomeKit (Aqara G3) tramite go2rtc, riusando l'abbinamento HomeKit fatto in Home Assistant
- Diretta nel pannello, foto, registrazione di 30 secondi a mano
- Registrazione delle clip al movimento: prosegue finché il movimento continua, fino alla durata massima
- Notifiche sul telefono con la foto dell'evento, con intervallo minimo fra due avvisi
- Privacy: registra e notifica sempre, solo a casa vuota o mai; fasce silenziose; pausa di 1, 4 o 12 ore; diretta solo a casa vuota; il movimento mentre l'aspirapolvere pulisce non conta
- Eventi con anteprime e video, conservazione per giorni e spazio massimo
- Entità in Home Assistant via MQTT: interruttore registrazione, modalità registra e notifica, ultima foto, ultimo movimento, pulsanti foto e registra
- Flusso RTSP locale sulla porta 8554 per Generic Camera
