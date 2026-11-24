# NIDO Tapparelle

Tutte le tapparelle di casa in un solo posto: comandi, scenari, automazioni, protezione dal sole, porte aperte, vento e pioggia,
e un diario che dice **chi** ha mosso cosa (NIDO, una persona, un'automazione o il pulsante a muro).

Funziona con qualsiasi tapparella che in Home Assistant è un'entità `cover.*`: moduli Zigbee (SONOFF MINI-ZBRBS, Shelly, Tuya…) via
Zigbee2MQTT o ZHA, Shelly in Wi-Fi, Somfy, ecc. Tutto il calcolo, posizione del sole compresa, avviene in locale.

## Prima di iniziare

1. Abbina le tapparelle a Home Assistant e **calibrale** (una corsa completa su e giù), così la posizione in percentuale è affidabile.
2. Assegna ogni tapparella a un'**area** (stanza). Nella stessa area metti, se li hai, il contatto della porta o finestra e un sensore di temperatura.
3. Controlla che in **Impostazioni → Sistema → Generale** sia impostata la posizione della casa: serve per alba, tramonto e sole sulle facciate.
4. Per avere modalità, scenari e interruttori anche in Home Assistant serve il broker MQTT (**Mosquitto**). Senza MQTT l'app funziona lo stesso.

L'app trova da sola le tapparelle (esclude porte del garage e cancelli). Con le opzioni `tapparelle` ed `escludi` puoi scegliere tu.

**Al primo avvio nessuna automazione è attiva**: ci sono tre modelli (apri al mattino nei feriali e nel weekend, chiudi al tramonto) da accendere quando vuoi.

## Tapparelle

Ogni scheda mostra la posizione (0% chiusa, 100% aperta), il cursore, ▲ ■ ▼ e ★ (posizione preferita) e l'ultimo movimento con chi l'ha fatto.
In alto i comandi per **tutte**, per **stanza** (dove ce n'è più d'una), per **gruppo** e gli **scenari**.

I cartellini dicono cosa sta succedendo:

- ✋ **a mano fino alle…** — è stata mossa a mano: le automazioni la lasciano stare (tocca *riprendi* per ridargliela)
- ☀️ **ombra** — abbassata per il sole, con la posizione a cui tornerà
- 🚪 **porta aperta** e **in attesa** — un comando automatico aspetta che si chiuda la porta

Con ⚙︎ si impostano nome, gruppo, posizione preferita, orientamento della finestra, posizione d'ombra, contatto della porta e cosa fare quando è aperta.

## Chi l'ha mossa

Ogni movimento finisce nel Diario con l'origine:

| Origine | Come la riconosce |
|---|---|
| NIDO | comando dell'app, con il motivo (automazione, sole, scenario…) |
| Persona | comando da Home Assistant o dal pannello, con il nome dell'utente |
| Automazione di HA | comando da un'automazione o uno script di Home Assistant |
| Pulsante a muro | la tapparella si è mossa senza nessun comando |

Dopo un movimento non fatto da NIDO le automazioni si mettono **in pausa** per quella tapparella, fino al **prossimo movimento programmato**
(o per un numero di minuti, o mai: scheda **Impostazioni**). Così se la abbassi a mano per vedere la TV, il sole non la rialza.

## Scenari

Un insieme di posizioni, ad esempio "Film": soggiorno chiusa, cucina al 30%. "Usa le posizioni attuali" li crea in un attimo.
Si avviano dalla scheda Tapparelle, da un'automazione o da Home Assistant (un pulsante per scenario).

## Automazioni

**Quando**: a un orario · all'alba o al tramonto con anticipo o ritardo · quando il sole sale o scende oltre un'altezza · quando escono tutti o rientra il primo ·
quando un sensore supera o scende sotto un valore per N minuti · quando un'entità cambia stato · quando cambia la modalità.

**Cosa**: porta tapparelle (tutte, stanze, gruppi o singole) a una posizione, alla loro posizione preferita, oppure avvia uno scenario.
"Muovi solo se deve aprirsi/chiudersi" evita, ad esempio, che l'apertura del mattino rialzi una tapparella che hai lasciato già più chiusa.

**Solo se**: giorni, fascia oraria, modalità, stagione, presenza, stato di un'entità (es. `binary_sensor.finestra` = `off`).

Le automazioni rispettano sempre la pausa dopo un comando a mano (salvo "Anche se mossa a mano") e le porte aperte.
Se il sole batte su una finestra, un'apertura si ferma alla posizione d'ombra.

## Modalità

Si cambia toccando il cartellino in alto a destra.

- **Automatica**: "in casa" o "fuori" in base alle persone (`person.*`). Chi non ha un dispositivo che ne indica la posizione non viene contato.
- **In casa / Fuori casa**: forzate.
- **Vacanza**, con data di fine: le automazioni a orario e col sole cambiano orario ogni giorno (±20 minuti, regolabile) per **simulare la presenza**.
- **In pausa**: NIDO non muove nulla.

## Sole e meteo

La bussola mostra il percorso del sole di oggi (e del 21 giugno e 21 dicembre) e lo spicchio di cielo in cui il sole colpisce ogni facciata.

**Protezione dal sole** (spenta all'inizio): quando il sole batte su una finestra per almeno N minuti e
la temperatura esterna supera la soglia (senza sensore: solo d'estate), la luce supera la soglia (senza sensore: se il meteo dice sereno o poco nuvoloso)
ed eventualmente la stanza è calda, la tapparella scende alla posizione d'ombra. Quando il sole se ne va torna com'era, se nel frattempo nessuno l'ha toccata.
A casa vuota può scendere di più.

**Sole d'inverno**: d'inverno apre del tutto le tapparelle scelte, se sono già socchiuse, quando il sole batte sulla facciata (una volta al giorno).

**Vento e pioggia**: oltre una soglia di vento o quando piove, apre o chiude tutte e ferma le automazioni finché non passa.

## Sensori

L'app riconosce da sola i sensori dalla loro classe: contatti di porte e finestre, luce, temperatura, vento, pioggia, meteo, presenza.

- I sensori **esterni** sono quelli senza area o in un'area come "Esterno", "Giardino", "Balcone", "Terrazzo"; si possono scegliere a mano.
- Il **contatto** di una porta o finestra viene collegato alla tapparella della stessa area. Con più tapparelle nella stanza, a quella col nome più simile.
- Quando aggiungi un sensore o una tapparella in Home Assistant, compare da solo nell'app e nel Diario.

## Diario, statistiche e notifiche

Il **Diario** raccoglie movimenti, automazioni, scenari, sole, porte, pause, vento e pioggia, cambi di modalità e nuovi dispositivi.
Le **Statistiche** mostrano movimenti al giorno, chi li fa, a che ora, e per ogni tapparella quante ore al giorno resta chiusa e la posizione media.

Le **notifiche** (servizio `notify.*` a scelta) avvisano quando una tapparella non viene chiusa per una porta aperta, con vento o pioggia,
quando una tapparella non arriva dove doveva e, se vuoi, a ogni automazione.

## In Home Assistant

Con MQTT compare il dispositivo **NIDO Tapparelle** con:

- `select` **Modalità**
- `switch` **Protezione dal sole**
- `button` **Apri tutte**, **Chiudi tutte** e uno per ogni **scenario**
- `sensor` **Prossimo movimento** (con regola e azione negli attributi)
- per ogni tapparella: `switch` **… automatica** e `binary_sensor` **… in pausa manuale**

Senza MQTT viene pubblicato solo `sensor.nido_tapparelle_modalita`.

## Provarla sul computer

```bash
cd nido-tapparelle/app
npm install
npm run demo        # casa simulata con 7 tapparelle, apri http://localhost:8099
```

Nella demo puoi far uscire e rientrare le persone, aprire la porta-finestra, simulare il vento e premere il "pulsante a muro".
