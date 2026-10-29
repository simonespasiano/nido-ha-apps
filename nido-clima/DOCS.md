# NIDO Clima

Un pannello nella barra laterale di Home Assistant che mostra, stanza per stanza, temperatura, umidità, obiettivo
e **se il termosifone sta scaldando**, con un diario leggibile di tutto ciò che succede.

## Come riconosce le stanze

Da sola, usando le **aree** di Home Assistant. Una stanza viene creata quando nella stessa area ci sono:

- una **valvola termostatica** (entità `climate` del dispositivo reale, es. Aqara E1 via Zigbee2MQTT);
- un **sensore di temperatura** (quello indicato nell'area come *Sensore di temperatura*, oppure il primo trovato).

Se nell'area c'è anche un termostato virtuale (**Versatile Thermostat** o Better Thermostat), l'obiettivo viene letto da quello.
Le stanze vengono ricontrollate ogni 10 minuti.

Se preferisci, puoi elencarle a mano nella scheda **Configurazione**:

```yaml
stanze:
  - nome: Camera
    valvola: climate.valvola_camera
    sensore_temperatura: sensor.temperatura_camera_temperature
    sensore_umidita: sensor.temperatura_camera_humidity
    termostato: climate.clima_camera
```

## Come capisce che il termosifone scalda

La valvola misura la temperatura **attaccata al termosifone**, il sensore quella della **stanza**. L'app combina tre segnali:

1. **Differenza valvola − stanza**: sopra `soglia_accensione` (predefinito 2,5 °C) il termosifone è caldo,
   sotto `soglia_spegnimento` (1,2 °C) torna freddo. Le due soglie diverse evitano che lo stato cambi in continuazione.
2. **Velocità della valvola**: se sale di oltre 4 °C/ora l'accensione viene riconosciuta prima; se scende di oltre 3 °C/ora
   lo spegnimento viene riconosciuto prima.
3. **Velocità della stanza**: un calo rapido (oltre 2 °C/ora, 1,5 con termosifone acceso) fa segnalare una **possibile finestra aperta**.

Con il riscaldamento **centralizzato** l'app deduce anche lo stato dell'impianto:

- almeno un termosifone caldo → **impianto acceso**;
- una stanza chiede calore da oltre 30 minuti ma nessun termosifone si scalda → **impianto probabilmente spento**;
- nessuna richiesta → **a riposo**, cioè non determinabile.

## Sensori creati in Home Assistant

Con `pubblica_sensori: true` l'app crea, e aggiorna a ogni ciclo:

- `binary_sensor.nido_clima_<stanza>_calorifero` — acceso/spento, con attributi `differenza`, `pendenza_valvola`,
  `affidabilita`, `motivo`, `finestra_sospetta`, `dal`;
- `sensor.nido_clima_impianto` — `acceso`, `spento` o `a_riposo`.

Puoi usarli nelle automazioni normali. Questi sensori spariscono se l'app è ferma e ricompaiono al riavvio.

## Opzioni

| Opzione | Predefinito | Significato |
|---|---|---|
| `soglia_accensione` | 2,5 | °C di differenza oltre cui il termosifone è caldo |
| `soglia_spegnimento` | 1,2 | °C sotto cui torna freddo |
| `intervallo_secondi` | 60 | ogni quanto leggere i valori |
| `conserva_giorni` | 120 | per quanti giorni tenere lo storico |
| `pubblica_sensori` | true | crea i sensori in Home Assistant |

Dopo 1–2 settimane di dati conviene guardare i grafici e, se serve, ritoccare le soglie.

## Dati

Lo storico è in un database SQLite dentro la cartella dati dell'app, incluso nei backup di Home Assistant.
