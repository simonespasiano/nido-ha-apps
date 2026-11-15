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

## Sensore esterno e stato del riscaldamento

Dalla 0.7.0 **NIDO invia alle valvole la temperatura del sensore della stanza**:

- imposta la valvola su `external` (entità *Sensore usato dalla valvola* di Zigbee2MQTT);
- scrive la temperatura in *external_temperature_input* a ogni variazione di 0,1 °C (al massimo ogni 30 secondi) e comunque ogni 5 minuti;
- controlla che la valvola la riceva (scheda **Valvole**, colonna *Stato*).

Così la valvola regola sulla temperatura vera della stanza e non su quella vicino al termosifone. **Le automazioni di Home Assistant che facevano lo stesso vanno lasciate spente**, altrimenti i due invii si sovrappongono.

Con il sensore esterno la valvola non misura più il termosifone, quindi la scheda della stanza mostra:

- **Chiede calore**: la stanza è sotto l'obiettivo;
- **Probabilmente caldo**: chiede calore e la stanza si sta scaldando (almeno 0,3 °C/ora);
- **In temperatura**: la valvola resta chiusa.

Per sapere davvero se il termosifone è caldo serve una sonda appoggiata al termosifone (`sensore_termosifone` nelle stanze configurate a mano): in quel caso torna il rilevamento con le soglie.

L'invio si disattiva dalla scheda **Valvole**, per tutte le valvole o per una sola: quelle escluse tornano sul sensore interno.

## Automazioni

La scheda **Automazioni** sostituisce le automazioni sparse in Home Assistant: NIDO decide l'obiettivo di ogni valvola e lo scrive solo quando cambia. Si attiva con l'interruttore in alto; spenta, le valvole restano come sono.

**L'obiettivo di una stanza** si calcola così, in ordine:

1. il **programma orario** della stanza dà il livello (Comfort, Eco o Notte); ci sono programmi diversi per Lun–Ven, sabato e domenica;
2. la **modalità della casa** può sostituirlo:
   - *Fuori* usa la temperatura "fuori casa";
   - *Vacanza* usa quella "vacanza", fino alla data scelta;
   - *Notte* usa quella "notte";
   - in *Automatica* la casa passa a Fuori quando tutte le persone (`person.*`) sono fuori da N minuti, e torna al programma al primo rientro;
3. **umidità**: se le pareti più fredde superano l'80 % di umidità, mezzo grado in più (regolabile);
4. **finestra aperta**: se la stanza scende di almeno 0,6 °C in 6 minuti, la valvola va a 7 °C e torna all'obiettivo quando la stanza smette di raffreddarsi;
5. **interventi a mano**: *+1° per un'ora*, *Imposta…* fino al prossimo cambio di programma, *Torna al programma*. Anche un cambio fatto sulla ghiera della valvola o da un'altra app viene rispettato fino al prossimo cambio.

Una valvola messa su **Spento** non viene riaccesa. Ogni decisione finisce nel **Diario** con il motivo.

**Notifiche per arieggiare**: scegli i servizi notify nel riquadro Umidità intelligente. L'avviso arriva dopo un picco improvviso (es. +10 punti in pochi minuti dopo la doccia) o con umidità sopra la soglia da 30 minuti. Arriva solo se fuori l'aria contiene meno vapore che dentro e al massimo ogni 3 ore per stanza.

## Chi cambia la temperatura

NIDO ascolta i comandi `climate` che passano da Home Assistant e li confronta con i cambi di obiettivo che vede sulle valvole e sui termostati. Ogni cambio nel **Diario** riporta l'origine:

- 👤 **persona**: dall'app o dalla dashboard di Home Assistant (con il nome della persona collegata all'utente) o dal pannello di NIDO
- ⚙️ **automazione di HA**: un'automazione, uno script o una scena
- 🏠 **NIDO**: programmi e regole della scheda Automazioni
- 🔧 **sulla valvola**: manopola, app Aqara o Zigbee2MQTT. Qui il nome non c'è: alla valvola non arriva chi l'ha girata. Se usi il programma interno delle valvole, anche i suoi cambi finiscono qui

In cima al Diario un riquadro riassume i cambi per origine, persona, stanza e ora del giorno.

## Umidità

La scheda **Umidità** mostra, per la casa e per ogni stanza:

- **vapore** (umidità assoluta) in casa e fuori: arieggiare serve solo se fuori ce n'è meno;
- **punto di rugiada**, **umidità stimata sulle pareti** più fredde e **limite di oggi**, cioè l'umidità oltre cui, con il freddo di adesso, le pareti superano l'80 % (soglia della muffa). La parete è stimata con il fattore di temperatura 0,7 tipico di muri non isolati e angoli;
- quanto tempo l'umidità è stata sotto il 40 %, fra 40 e 60, fra 60 e 70 e oltre il 70 %;
- la **giornata tipo** (media per ora) dei giorni feriali e del fine settimana;
- i **picchi** (almeno +7 punti in 20 minuti), con il tempo per tornare al valore di prima, e **cosa si ripete**: picchi alla stessa ora in almeno 3 giorni e in almeno il 30 % dei giorni (la doccia del mattino, la cucina la sera);
- **consigli**: rischio condensa, picchi che rientrano lentamente, aria troppo secca, ore migliori per arieggiare nelle prossime 24 ore secondo le previsioni.

## Valvole

La scheda **Valvole** mette in una tabella tutte le funzioni di ogni valvola esposte da Zigbee2MQTT: blocco bambini, rilevamento finestra, controllo anomalie, temperatura in assenza, calibrazione, batteria, segnale. Si modificano direttamente; **Applica a tutte** copia un valore su tutte le valvole.

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

## Dashboard Casa

- **Media casa**: media dei sensori di tutte le stanze; il grafico mostra anche la fascia fra la stanza più fredda e la più calda.
- **Meteo**: previsioni orarie da [Open-Meteo](https://open-meteo.com) (gratuito, nessuna chiave) per la posizione impostata in Home Assistant,
  aggiornate ogni ora. I modelli si scelgono con `modelli_meteo` (identificativi Open-Meteo; vuoto = tutti quelli predefiniti).
- **Errore dei modelli**: ogni previsione viene salvata e, passata l'ora, confrontata con il valore osservato. Senza sensore esterno
  l'osservato è l'analisi oraria di Open-Meteo; indicando `sensore_esterno` (ed eventualmente `sensore_esterno_umidita`) il confronto è con la realtà di casa tua.
- **Modello della casa**: dopo 24 ore di dati l'app stima come la temperatura media cambia in funzione dell'esterno e dei termosifoni accesi,
  e la usa per prevedere le prossime 24 ore con la previsione di consenso.

## Dati

Lo storico è in un database SQLite dentro la cartella dati dell'app, incluso nei backup di Home Assistant.
