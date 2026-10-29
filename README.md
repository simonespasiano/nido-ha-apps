# NIDO – App per Home Assistant

Repository di app (ex componenti aggiuntivi) per Home Assistant.

| App | Cosa fa |
|---|---|
| [NIDO Clima](nido-clima) | Stanze, valvole e sensori in chiaro; rileva quando il termosifone scalda; diario di ciò che accade; statistiche di riscaldamento |

## Installazione

1. In Home Assistant: **Impostazioni → App → Store → ⋮ → Repository**
2. Aggiungi l'indirizzo di questo repository, ad esempio `https://github.com/TUO_UTENTE/nido-ha-apps`
3. **⋮ → Verifica aggiornamenti**, poi cerca **NIDO Clima** → Installa → Avvia
4. Attiva **Mostra nella barra laterale**

Il primo avvio richiede qualche minuto: Home Assistant costruisce l'app direttamente sul Raspberry.

## Provarla sul computer

```bash
cd nido-clima/app
npm install
npm run demo        # dati simulati, apri http://localhost:8099
```

Per collegarla a un Home Assistant vero da fuori dell'app:

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<token di lunga durata> DATA_DIR=./.data npm start
```
