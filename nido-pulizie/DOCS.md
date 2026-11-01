# NIDO Pulizie

Gestisce un robot **Narwal** (provato sul protocollo del Flow 2) direttamente sulla rete di casa, **senza cloud**.
Il robot ha un WebSocket locale sulla porta 9002: l'app ci parla come fa l'app Narwal sul telefono.

## Prima di iniziare

1. Dai al robot un **IP fisso** (prenotazione DHCP sul router).
2. Scrivilo in **Configurazione → Indirizzo IP del robot** e avvia l'app.
3. Il robot accetta **una sola connessione locale**:
   - se hai installato l'integrazione Narwal della community, disattivala o rimuovila;
   - se l'app Narwal sul telefono è aperta, il collegamento può fallire finché non la chiudi. Si ricollega da sola.
4. Per comandare il robot da Home Assistant serve il broker MQTT (**Mosquitto**, app ufficiale) con l'integrazione MQTT attiva. Senza MQTT l'app funziona lo stesso, ma in Home Assistant crea solo sensori di lettura.

Al primo collegamento l'app riconosce da sola modello e identificativo del robot e scarica la mappa con le stanze.

## Robot

- **Stato** (in carica, sta pulendo, in pausa, torna alla base…), batteria, aspirazione e acqua. Durante la pulizia mostra anche stanza, superficie, tempo e avanzamento.
- Comandi: pausa/riprendi, termina, torna alla base, trova (il robot parla), aspirazione e acqua al volo. Sulla base: lavaggio e asciugatura dei mop, svuotamento.
- **Mappa**: tocca le stanze per sceglierle, imposta modalità (aspira, lava, aspira poi lava, aspira e lava), aspirazione, acqua, intensità, passaggi e percorso, poi **Pulisci**. Durante la pulizia la mappa mostra il percorso e la posizione del robot.
- Le stanze dove i sensori di presenza sono attivi appaiono sbiadite.

La pulizia per stanze parte solo con il robot **sulla base**: è un limite del robot.

## Programmi

Ogni programma ha:

- **quando parte**:
  - a un orario, in certi giorni;
  - oppure **quando la casa resta vuota**, cioè tutte le persone (`person.*`) sono fuori da N minuti, in una fascia oraria, al massimo una volta al giorno;
- **quali stanze** (o tutta la casa) e **come pulire**;
- **condizioni**:
  - salta le stanze dove c'è qualcuno;
  - solo a casa vuota;
  - salta le stanze pulite da meno di N ore;
  - batteria minima;
- **se qualcuno rientra** durante la pulizia: continua, pausa o torna alla base.

Prima di salvare vedi in anteprima cosa farebbe se partisse adesso, e perché eventualmente salterebbe una stanza. **Esegui ora** lo avvia subito, applicando le stesse condizioni.

Per saltare le stanze occupate, in **Impostazioni** collega ogni stanza del robot a un'area di Home Assistant. Il collegamento è automatico quando i nomi coincidono. Contano i `binary_sensor` di tipo presenza, occupazione o movimento di quell'area.

## Storico e statistiche

Ogni pulizia viene registrata, anche quelle avviate dall'app Narwal o dal pulsante del robot. Per ciascuna l'app salva:

- chi l'ha avviata;
- le stanze richieste e quelle effettivamente pulite;
- superficie, durata e consumo di batteria;
- l'esito;
- il percorso sulla mappa.

Il **Diario** raccoglie comandi, programmi, uscite e rientri.

Le **Statistiche** mostrano:

- pulizie, m², tempo e velocità, con il confronto con il periodo precedente;
- m² al giorno;
- quante volte e quando è stata pulita ogni stanza (in arancione quelle ferme da più di una settimana);
- a che ora pulisce;
- chi avvia le pulizie;
- la batteria delle ultime 48 ore.

## In Home Assistant (con MQTT)

Un dispositivo **Narwal** con:

- `vacuum`: avvia (tutta la casa), pausa, stop, torna alla base, trova, aspirazione;
- sensori: batteria, attività, stanza attuale, superficie, avanzamento, ultima pulizia, superficie degli ultimi 7 giorni, problema, sulla base;
- `select` acqua;
- pulsanti: **Pulisci <stanza>** per ogni stanza, lava/asciuga mop, svuota, aggiorna mappa;
- per ogni programma un interruttore (attivo/disattivo) e un pulsante **Esegui**.

Pulizia di più stanze da un'automazione:

```yaml
action: vacuum.send_command
target:
  entity_id: vacuum.narwal
data:
  command: pulisci_stanze
  params:
    stanze: ["Cucina", "Soggiorno"]
    modo: 4         # 1 aspira, 2 lava, 3 aspira poi lava, 4 aspira e lava
    aspirazione: 2  # 1 silenzioso … 5 super
    acqua: 2        # 1 poca, 2 normale, 3 molta
```

## Opzioni

| Opzione | Predefinito | Significato |
|---|---|---|
| `indirizzo_ip` | — | IP fisso del robot |
| `porta` | 9002 | porta del WebSocket locale |
| `persone` | tutte | entità `person.*` da considerare per "casa vuota" |
| `pubblica_in_home_assistant` | true | crea le entità (MQTT) o i sensori (REST) |
| `conserva_giorni` | 365 | giorni di storico |
| `debug` | false | scrive nel registro tutti i messaggi del robot |

## Limiti noti

- Il protocollo locale di Narwal non è documentato. Questa app si basa sul lavoro di ricostruzione del progetto
  [NarwalIntegration](https://github.com/sjmotew/NarwalIntegration) (licenza MIT). Con un aggiornamento del firmware qualcosa potrebbe cambiare.
- I **codici di errore** del robot sono mostrati come numeri: il loro significato non è ancora noto.
- La vita residua dei consumabili non è disponibile in locale (solo nel cloud).
- La superficie di una stanza è stimata dalla mappa.

## Diagnosi

**Impostazioni → Diagnosi** mostra gli ultimi messaggi ricevuti per argomento e il registro. Con `debug: true` il registro dell'app contiene tutti i messaggi del robot: utile se qualcosa non torna.
