# NIDO Sistema

Mostra come sta il Raspberry Pi su cui gira Home Assistant e permette di decidere come gira la ventola (Active Cooler del Pi 5).

## Installazione

1. Installa l'app, avviala e attiva *Mostra nella barra laterale*. La Modalità protezione può restare attiva.
2. Per comandare la ventola l'app chiede a Home Assistant il permesso `SYS_ADMIN`. Home Assistant monta `/sys` in sola lettura in tutte le app: con quel permesso l'app monta una seconda copia in scrittura, usata solo per la ventola.

## Cosa mostra

- **Temperature**:
  - CPU;
  - chip **RP1**, che gestisce USB, rete e GPIO;
  - **SSD** NVMe, se c'è.
- **Ventola**: giri al minuto reali e velocità in percentuale.
- **CPU**: uso, frequenza (2400 MHz è il massimo del Pi 5) e carico.
- **Memoria** e **disco** della partizione dati, tempo di accensione.
- **Alimentazione**: sottotensione e rallentamenti segnalati dal firmware. Per il Pi 5 con SSD serve l'alimentatore ufficiale da 27 W.

I grafici coprono le ultime 6 ore, 24 ore, 7 o 30 giorni. Lo storico registra un campione ogni 30 secondi.

## Ventola

| Modalità | Cosa fa |
|---|---|
| Automatica (firmware) | Come senza l'app: parte verso i 50 °C e accelera a gradini fino ai 75 °C. L'app legge soltanto |
| Silenziosa | Ferma fino a 55 °C, poi lenta |
| Bilanciata | Parte a 45 °C e sale in modo graduale |
| Fresca | Sempre un po' accesa |
| Massima | Sempre al massimo |
| Personalizzata | La tua curva, da 2 a 10 punti temperatura → velocità |

- La ventola **sale subito** quando la temperatura cresce. **Scende** solo dopo un calo di qualche grado (3 °C, regolabile) e a piccoli passi, così non cambia in continuazione.
- **Sopra 80 °C la ventola va sempre al massimo**, qualunque modalità sia scelta. Comunque il Raspberry rallenta da solo la CPU sopra gli 85 °C per proteggersi.
- **Raffredda ora** la porta al massimo per 15 minuti o per un'ora.
- In una modalità diversa da *Automatica*, l'app toglie la decisione al kernel (governatore `user_space`) e imposta direttamente la velocità.
  Quando l'app si ferma o la rimetti su *Automatica*, la ventola **torna al firmware**.

Se preferisci non dare all'app l'accesso completo, puoi cambiare la curva del firmware nel file `config.txt` della scheda di avvio:

```
dtparam=fan_temp0=45000,fan_temp0_hyst=5000,fan_temp0_speed=90
```

Le temperature si scrivono in millesimi di grado (45000 = 45 °C) e la velocità va da 0 a 255; ci sono quattro gradini, da `fan_temp0` a `fan_temp3`.

## Avvisi

Con l'opzione `notifiche` (es. `mobile_app_iphone_di_simone`) arriva un avviso quando:

- la CPU resta sopra `avviso_temperatura` (75 °C) per più di 2 minuti, al massimo un avviso all'ora;
- compare una sottotensione;
- la ventola dovrebbe girare ma risulta ferma.

## In Home Assistant

Con il broker MQTT compare il dispositivo **Raspberry Pi** con:

- le temperature, la ventola (giri e %), l'uso e la frequenza della CPU, la memoria, il disco e l'ultimo avvio;
- i sensori di problema *Sottotensione* e *Rallentato*;
- il selettore **Modalità ventola**, utilizzabile anche nelle automazioni (per esempio *Silenziosa* di notte);
- il pulsante **Ventola al massimo 15 minuti**.

Senza MQTT l'app crea solo `sensor.nido_sistema_cpu` e `sensor.nido_sistema_ventola`.
