# Changelog

## 0.1.0

- Video della camera HomeKit (Aqara G3) tramite go2rtc, riusando l'abbinamento HomeKit fatto in Home Assistant
- Diretta nel pannello, foto, registrazione di 30 secondi a mano
- Registrazione delle clip al movimento: prosegue finché il movimento continua, fino alla durata massima
- Notifiche sul telefono con la foto dell'evento, con intervallo minimo fra due avvisi
- Privacy: registra e notifica sempre, solo a casa vuota o mai; fasce silenziose; pausa di 1, 4 o 12 ore; diretta solo a casa vuota; il movimento mentre l'aspirapolvere pulisce non conta
- Eventi con anteprime e video, conservazione per giorni e spazio massimo
- Entità in Home Assistant via MQTT: interruttore registrazione, modalità registra e notifica, ultima foto, ultimo movimento, pulsanti foto e registra
- Flusso RTSP locale sulla porta 8554 per Generic Camera
