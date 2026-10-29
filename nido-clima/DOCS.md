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

## Da dove arriva la temperatura del termosifone

- Con la valvola sul **sensore interno**, si usa la temperatura che la valvola misura (`current_temperature`).
- Con la valvola sul **sensore esterno** (ad esempio un'automazione che le invia la temperatura della stanza), quella temperatura
  coincide con la stanza e non dice nulla del termosifone. In questo caso l'app usa la **temperatura interna del dispositivo**
  (`sensor.<valvola>_device_temperature`), misurata nel corpo della valvola. È meno precisa (di solito a gradi interi) e si aggiorna più di rado,
  ma segue il calore del termosifone.
- Con `fonte_termosifone` scegli: `auto` (come sopra), `valvola` (sempre la temperatura della valvola) o `interna` (sempre quella interna).
- Per una stanza configurata a mano puoi indicare `sensore_termosifone`, ad esempio una sonda appoggiata al termosifone: ha la precedenza su tutto.

Sulla scheda della stanza, accanto a *Termosifone*, compare *(interna)* o *(sonda)* quando il valore non è quello della valvola.

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

## Gestire valvole e termostati

Il pulsante **Gestisci** su ogni stanza apre un pannello con:

- **temperatura desiderata**, regolabile con − e +: se c'è un termostato virtuale (Versatile Thermostat) il comando va a lui, altrimenti direttamente alla valvola;
- **modalità** e **preset**, quando il termostato li offre;
- tutte le **funzioni del dispositivo valvola** esposte da Zigbee2MQTT (blocco bambini, rilevamento finestra, sensore usato, calibrazione…), divise in funzioni, configurazione e diagnostica, con batteria e qualità del segnale.

L'app può comandare **solo** le entità che appartengono alla valvola della stanza, e controlla che i valori siano nei limiti ammessi.
Ogni comando viene registrato nel **Diario** con il nome dell'utente di Home Assistant che l'ha dato.

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

Le due soglie della configurazione sono solo i **valori di partenza**. Tutte le soglie si modificano dalla scheda **Soglie** dell'app,
anche con valori diversi per singola stanza, e valgono subito senza riavviare. Una volta salvate da lì, hanno la precedenza sulla configurazione;
il pulsante *Valori della configurazione* torna a quelli dell'opzione.

Prima di salvare, **Prova queste soglie** le riapplica allo storico e mostra per ogni stanza quante accensioni avrebbe visto,
il tempo caldo e la distribuzione della differenza valvola − stanza: se la differenza massima resta sotto la soglia di accensione,
quel termosifone non verrà mai riconosciuto.

## Dati

Lo storico è in un database SQLite dentro la cartella dati dell'app, incluso nei backup di Home Assistant.
