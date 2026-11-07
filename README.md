# NIDO – App per Home Assistant

Repository di app (ex componenti aggiuntivi) per Home Assistant.

| App | Cosa fa |
|---|---|
| [NIDO Clima](nido-clima) | Stanze, valvole e sensori in chiaro; rileva quando il termosifone scalda; diario di ciò che accade; statistiche di riscaldamento |
| [NIDO Sistema](nido-sistema) | Raspberry Pi in chiaro: temperature di CPU, RP1 e SSD, ventola con curve e modalità, alimentazione, storico e avvisi |
| [NIDO Camera](nido-camera) | Camera HomeKit (Aqara G3) via go2rtc: diretta, registrazione al movimento, notifiche con foto, privacy |
| [NIDO Pulizie](nido-pulizie) | Robot Narwal in locale senza cloud: mappa, pulizia per stanza, programmi "quando esco", storico e statistiche, entità in Home Assistant |

## Installazione

1. In Home Assistant: **Impostazioni → App → Store → ⋮ → Repository**
2. Aggiungi l'indirizzo di questo repository, ad esempio `https://github.com/simonespasiano/nido-ha-apps`
3. **⋮ → Verifica aggiornamenti**, poi cerca **NIDO Clima**, **NIDO Pulizie**, **NIDO Camera** o **NIDO Sistema** → Installa → Avvia
4. Attiva **Mostra nella barra laterale**

Il primo avvio richiede qualche minuto: Home Assistant costruisce l'app direttamente sul Raspberry.

## Provarla sul computer

```bash
cd nido-clima/app      # oppure nido-pulizie/app (con un robot Narwal simulato)
npm install
npm run demo        # dati simulati, apri http://localhost:8099
```

Per collegarla a un Home Assistant vero da fuori dell'app:

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<token di lunga durata> DATA_DIR=./.data npm start
```
