# Changelog

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
