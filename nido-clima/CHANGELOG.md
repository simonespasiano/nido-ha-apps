# Changelog

## 0.7.2

- **Chi cambia la temperatura**: ogni cambio di obiettivo o di modalità nel Diario indica chi l'ha fatto: una persona da Home Assistant (app, dashboard, assistente vocale) con il suo nome, una persona dal pannello di NIDO, un'automazione o uno script di HA, NIDO stesso, oppure **sulla valvola** (manopola, app Aqara, Zigbee2MQTT)
- In cima al Diario un riquadro riassume gli ultimi 7, 14 o 30 giorni: quanti cambi per origine, chi li fa, in quali stanze e a che ora
- Le modifiche fatte direttamente sulla valvola non portano un nome: Home Assistant non sa chi ha girato la manopola

## 0.7.1

- Presenza: le persone senza un dispositivo che ne indica la posizione, o con posizione sconosciuta, non vengono più contate come "fuori". Prima bastava una persona così per far credere che la casa fosse vuota
- La scheda Automazioni mostra lo stato di ogni persona (🏠 in casa, 🚶 fuori, ❔ sconosciuta) e chi viene ignorato

## 0.7.0

- **Sensore esterno gestito da NIDO**: le valvole passano su `external` e NIDO invia loro la temperatura del sensore della stanza a ogni variazione di 0,1 °C (al massimo ogni 30 secondi) e almeno ogni 5 minuti, con verifica che la valvola la riceva. Sostituisce le automazioni di Home Assistant, che vanno lasciate spente. Si può disattivare per tutte o per singola stanza dalla scheda **Valvole**
- **Stato del riscaldamento con il sensore esterno**: la valvola misura la stanza, quindi l'app non indovina più "acceso/spento" dal termosifone. Mostra se la stanza **chiede calore**, se è **in temperatura** o se il termosifone è **probabilmente caldo** (chiede calore e la stanza si scalda). Con una sonda sul termosifone (`sensore_termosifone`) resta il rilevamento di prima
- Nuova scheda **Automazioni**, un solo punto per tutto il riscaldamento:
  - programmi orari per stanza (comfort, eco, notte) per Lun–Ven, sabato e domenica, con temperature proprie e copia fra stanze
  - modalità della casa Automatica, Casa, Fuori, Notte, Vacanza (con data di fine): in Automatica la casa va su Fuori quando tutte le persone escono e torna al programma al primo rientro
  - finestra aperta riconosciuta dal calo rapido della temperatura: valvola al minimo e ripristino quando la stanza smette di raffreddarsi
  - umidità intelligente: mezzo grado in più quando le pareti rischiano la condensa, notifica per arieggiare dopo un picco o con umidità alta, solo se fuori l'aria è più secca
  - interventi a mano: +1 °C per un'ora, obiettivo fino al prossimo cambio, ritorno al programma; un cambio fatto sulla ghiera della valvola viene rispettato fino al prossimo cambio
- Nuova scheda **Umidità**: vapore in casa e fuori, punto di rugiada, umidità stimata sulle pareti e limite del giorno, tempo per fascia, giornata tipo feriali e festivi, **picchi che si ripetono** (doccia, cucina) con tempo di rientro, ore di rischio condensa, ore migliori per arieggiare e consigli
- Nuova scheda **Valvole**: tutte le impostazioni di ogni valvola in una tabella, modificabili, con **Applica a tutte**
- Diario: nuovi tipi Automazioni e Umidità

## 0.6.0

- Nuova scheda **Casa** (si apre per prima): media della temperatura e dell'umidità di tutta la casa, andamento delle ultime 3 ore, confronto con ieri alla stessa ora, escursione fra le stanze, punto di rugiada e umidità assoluta
- **Confronto fra modelli meteo** per la posizione della casa (DWD ICON, ECMWF IFS, NOAA GFS, Météo-France, UK Met Office, ItaliaMeteo ICON-2I via Open-Meteo): consenso, dispersione, scarto di ogni modello e **errore medio sugli ultimi 7 giorni** con classifica
- **Modello termico della casa** stimato dai dati: costante di tempo, dispersione verso l'esterno, effetto dei termosifoni, previsione della temperatura interna a 24 ore con banda di incertezza e verifica contro metodi semplici
- **Consigli**: umidità alta o bassa, quando arieggiare abbassa davvero l'umidità, forti differenze fra stanze, freddo in arrivo
- Nuove opzioni `modelli_meteo`, `sensore_esterno`, `sensore_esterno_umidita`

## 0.5.3

- Rimossa ovunque la temperatura interna del chip della valvola (`device_temperature`): non compare più su schede, pannello Gestisci, grafico, tabella e CSV, e non viene usata per il rilevamento
- Rimossa l'opzione `fonte_termosifone`
- Con la valvola sul sensore esterno la scheda avvisa che il rilevamento non è possibile, invece di mostrare una stima

## 0.5.2

- Scheda **Soglie** → **Dati raccolti**: mostra quante letture ed eventi ci sono e permette di **cancellare storico e diario** per ripartire da zero, mantenendo (o, a scelta, azzerando) le soglie salvate

## 0.5.1

- Lo stato introdotto nella 0.5.0 diventa "Valvola chiusa · stanza in temperatura" e non fa più considerare acceso l'impianto: la verifica sul posto ha mostrato che la valvola può risultare più calda della stanza anche con tubo e termosifone freddi

## 0.5.0

- Nuovo stato **"Acqua calda · valvola chiusa"**: la valvola sta sul tubo di mandata e si scalda anche chiusa quando l'impianto è acceso. Se la stanza ha già raggiunto l'obiettivo, il caldo misurato non viene più contato come termosifone acceso
- Lo stato dell'impianto centralizzato considera acceso anche questo caso
- Nuova soglia *Valvola chiusa se la stanza è entro … dall'obiettivo* (predefinito 0,2 °C)

## 0.4.3

- Quando la valvola usa il sensore della stanza come sensore esterno, la scheda lo indica ("Sensore stanza · usato dalla valvola") e non mostra più la temperatura della valvola, che sarebbe solo una copia ritardata dello stesso valore

## 0.4.2

- Le schede delle stanze mostrano tutte e tre le temperature: **sensore della stanza**, **valvola** e **interna della valvola**; quella usata per capire se il termosifone scalda è evidenziata con ◉
- Lo storico registra separatamente temperatura della valvola e temperatura interna: nel grafico ingrandito sono due serie attivabili, e compaiono come colonne nella tabella e nel CSV

## 0.4.1

- Se la valvola usa il **sensore esterno**, la temperatura del termosifone viene presa dalla temperatura interna del dispositivo (`device_temperature`) invece che dalla temperatura della valvola, che in quel caso ripete la stanza
- Nuova opzione `fonte_termosifone` (auto / valvola / interna) e, per le stanze configurate a mano, `sensore_termosifone` per una sonda dedicata
- Nomi in italiano per temperatura usata dalla valvola, temperatura interna e modalità installazione

## 0.4.0

- Nuova scheda **Soglie**: tutte le soglie di rilevamento modificabili dall'interfaccia (differenza di accensione e spegnimento, salita e discesa della valvola, finestra aperta, minuti di calcolo)
- Valori diversi per singola stanza; le modifiche valgono subito e vengono registrate nel diario
- **Prova queste soglie**: le riapplica allo storico e mostra accensioni, tempo caldo e distribuzione della differenza valvola − stanza

## 0.3.0

- Grafico ingrandito: tocca il grafico di una stanza per aprirlo a tutta pagina
- Intervalli rapidi (6 h, 24 h, 3, 7, 30 giorni), zoom trascinando o con la rotellina, spostamento avanti/indietro, doppio clic per tornare all'intervallo iniziale
- Valori al passaggio del mouse; clic su un punto per evidenziarlo nella tabella dei dati puntuali (e viceversa)
- Eventi del diario mostrati sul grafico e intercalati nella tabella
- Serie attivabili (stanza, termosifone, obiettivo, umidità) ed esportazione CSV del periodo visibile

## 0.2.0

- Pannello **Gestisci** per ogni stanza: temperatura desiderata, modalità (riscaldamento/spento), preset di Versatile Thermostat
- Funzioni del dispositivo valvola lette da Zigbee2MQTT con nomi in italiano: blocco bambini, rilevamento finestra, sensore interno/esterno, calibrazione, batteria, segnale
- Controlli di sicurezza: si possono comandare solo le entità della valvola della stanza, con valori nei limiti ammessi
- Ogni comando finisce nel diario con il nome di chi l'ha dato

## 0.1.1

- Diagnosi delle aree quando nessuna stanza viene riconosciuta: cosa c'è e cosa manca in ogni area, dispositivi senza area
- Riconoscimento sensori anche dall'unità di misura (°C, %)
- Ricerca delle stanze ogni minuto finché non ne trova

## 0.1.0

- Riconoscimento automatico delle stanze dalle aree (valvola + sensore + termostato virtuale)
- Rilevamento termosifone caldo/freddo con isteresi e affidabilità
- Stato dell'impianto centralizzato dedotto dalle stanze
- Segnalazione di possibili finestre aperte
- Diario degli eventi, grafici 24 ore, statistiche (ore di accensione, velocità di riscaldamento e raffreddamento)
- Elenco dei dispositivi climatici per stanza
- Sensori pubblicati in Home Assistant
- Modalità demo con dati simulati
