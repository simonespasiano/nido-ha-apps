# Changelog

## 0.1.1

- **Temperatura esterna sbagliata**: la ricerca automatica poteva prendere un sensore senza area qualsiasi, ad esempio la temperatura della CPU o dell'SSD del Raspberry. Ora come temperatura esterna sceglie da sola solo sensori in un'area o con un nome come "Esterno", "Giardino", "Balcone", "Terrazzo", e mai temperature di computer, dischi, schede o batterie. Se non ne trova, usa la temperatura delle previsioni meteo
- I sensori di NIDO Sistema non compaiono più fra quelli utili alle tapparelle

## 0.1.0

Prima versione.

- **Tapparelle**: tutte le `cover.*` di Home Assistant trovate da sole, con posizione, cursore, apri/ferma/chiudi, posizione preferita ★, comandi per tutte, per stanza e per gruppo
- **Chi le muove**: ogni movimento è attribuito a NIDO (con il motivo), a una persona (app o pannello, con il nome), a un'automazione di Home Assistant oppure al **pulsante a muro**
- **Pausa dopo un comando a mano**: se una tapparella viene mossa a mano, le automazioni la lasciano stare fino al prossimo movimento programmato (o per un tempo a scelta). Si riprende con un tocco
- **Scenari**: insiemi di posizioni ("Film", "Pranzo"…) da avviare dall'app, da un'automazione o da Home Assistant
- **Automazioni**: a un orario, all'alba o al tramonto (con anticipo o ritardo), all'altezza del sole, quando escono tutti o rientra il primo, quando un sensore supera una soglia o cambia stato, al cambio di modalità. Condizioni su giorni, fascia oraria, modalità, stagione, presenza e stato di un'entità; "muovi solo se deve aprirsi/chiudersi"
- **Modalità della casa**: Automatica (dalla presenza), In casa, Fuori casa, Vacanza con data di fine e **simulazione di presenza** (orari che cambiano ogni giorno), In pausa
- **Protezione dal sole** calcolata in locale (posizione del sole, orientamento di ogni finestra), con soglie di temperatura esterna, luce e temperatura della stanza, attesa anti-nuvole e ritorno alla posizione di prima; un'apertura programmata si ferma alla posizione d'ombra se il sole batte
- **Sole d'inverno**: apre le tapparelle scelte quando il sole scalda la facciata
- **Porte e finestre**: il contatto nella stessa stanza viene collegato da solo; con la porta aperta le automazioni non chiudono (o non scendono sotto una posizione) e completano il comando appena viene chiusa
- **Vento e pioggia**: apri o chiudi tutte, automazioni ferme finché non passa
- **Sensori**: temperatura, luce, vento, pioggia, meteo, contatti e presenza riconosciuti dalla classe e dall'area; i nuovi dispositivi compaiono da soli e finiscono nel Diario
- **Diario**, **Statistiche** (movimenti al giorno, chi li fa, a che ora, ore chiusa al giorno, posizione media) e **notifiche** (porta aperta, vento e pioggia, tapparella che non arriva dove deve)
- **In Home Assistant** via MQTT: selettore della modalità, interruttore della protezione dal sole, pulsanti Apri/Chiudi tutte e per ogni scenario, sensore del prossimo movimento, interruttore "automatica" e sensore "in pausa manuale" per ogni tapparella
