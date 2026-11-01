# NIDO Camera

Porta in Home Assistant una camera **HomeKit**, pensata per l'**Aqara Camera Hub G3**, che non offre RTSP.
Il video arriva tramite **go2rtc**, incluso nell'app. go2rtc riusa l'abbinamento HomeKit che fai in Home Assistant, quindi non serve nessun dispositivo Apple.

## Configurazione, una volta sola

1. **Togli la G3 da Apple Casa**, se ce l'hai messa. Un accessorio HomeKit può essere abbinato a un solo sistema. La G3 resta comunque nell'app Aqara, con tutte le sue funzioni.
2. Trova il **codice di configurazione HomeKit** (8 cifre): è sull'etichetta sotto la camera o nella confezione.
3. In Home Assistant apri **Impostazioni → Dispositivi e servizi**. Fra i dispositivi rilevati dovrebbe comparire **HomeKit Device · Camera Hub G3**: premi *Configura* e inserisci il codice.
   Se non compare, scegli *Aggiungi integrazione → HomeKit Device*.
   Home Assistant crea la camera, il sensore di movimento e, se la G3 fa da hub, anche i sensori Aqara collegati.
4. Avvia NIDO Camera e apri **Impostazioni** nell'app: ogni passo diventa verde quando è a posto.

La camera nel riquadro di Home Assistant può restare grigia: è normale, perché l'integrazione HomeKit non apre il video. Il video lo fornisce questa app.

## Diretta e foto

- **Avvia la diretta** apre il video nel pannello (MSE via WebSocket). Con HomeKit il primo fotogramma arriva dopo qualche secondo.
  La diretta si ferma quando cambi scheda o chiudi la pagina.
- **Scatta foto** salva un'immagine.
- **Registra 30 secondi** salva una clip a mano.

## Registrazione al movimento

Quando un sensore passa ad attivo, l'app:

1. decide se registrare e notificare secondo le regole di **Privacy**;
2. scatta una foto, che serve da anteprima e per la notifica;
3. registra una clip, che continua finché il sensore resta attivo più `clip_dopo_movimento_secondi`, fino a `clip_massima_secondi`. Se a quel punto il movimento continua, parte una nuova clip;
4. manda la notifica con la foto ai servizi in `notifiche`, al massimo una ogni N minuti.

I sensori usati sono quelli di movimento della camera. Con `sensori_movimento` puoi indicarne altri, per esempio una porta o la presenza in una stanza.

Ogni movimento viene annotato anche quando non registra, insieme al motivo: casa non vuota, pausa, aspirapolvere in funzione…

## Privacy

- **Quando registrare** e **quando notificare**: sempre, solo a casa vuota o mai. "Casa vuota" significa che tutte le persone (`person.*`, oppure quelle nell'opzione `persone`) sono fuori.
- **Fasce silenziose**: giorni e orari senza notifiche, ed eventualmente senza registrazione.
- **Pausa** di 1, 4 o 12 ore.
- **Ignora il movimento mentre l'aspirapolvere pulisce**: vale per qualsiasi entità `vacuum` in stato *cleaning* o *returning*, compreso il Narwal di NIDO Pulizie.
- **Diretta solo a casa vuota**, se vuoi.

## Notifiche

In `notifiche` scrivi il nome del servizio dell'app Home Assistant del telefono, per esempio `mobile_app_iphone_di_simone`. L'elenco dei servizi disponibili è in **Impostazioni** dell'app, insieme al pulsante **Manda una notifica di prova**.
La notifica mostra la foto e, quando la tocchi, apre il pannello dell'app.

## File e spazio

Foto e video sono in `/media/nido-camera`, visibili anche in Home Assistant da **Media → Media locali** e inclusi nei backup se includi la cartella media.
Si cancellano da soli dopo `conserva_giorni` giorni, o prima se superano `spazio_massimo_gb`.

## In Home Assistant

- **MQTT**: con il broker Mosquitto compare il dispositivo **NIDO Camera** con:
  - un interruttore *Registrazione e notifiche*, che mette in pausa o riprende;
  - due selettori, *Registra* e *Notifica*;
  - *Registrazione in corso*, *Ultimo movimento*, *Movimenti oggi* e *Spazio usato*;
  - l'immagine *Ultima foto*;
  - i pulsanti *Scatta foto* e *Registra 30 secondi*.
- **Dashboard con video**: aggiungi l'integrazione **Generic Camera** con URL dello stream
  `rtsp://<indirizzo di Home Assistant>:8554/camera?video&audio=aac`.

## Opzioni

| Opzione | Predefinito | Significato |
|---|---|---|
| `camera` | prima trovata | nome dell'abbinamento HomeKit in Home Assistant |
| `sensori_movimento` | quelli della camera | binary_sensor che fanno registrare |
| `notifiche` | — | servizi notify da avvisare |
| `persone` | tutte | person.* per "casa vuota" |
| `clip_dopo_movimento_secondi` | 20 | registrazione dopo la fine del movimento |
| `clip_massima_secondi` | 180 | durata massima di una clip |
| `conserva_giorni` | 14 | giorni di conservazione |
| `spazio_massimo_gb` | 20 | spazio massimo per foto e video |
| `pubblica_in_home_assistant` | true | entità via MQTT |
| `debug` | false | registro dettagliato, anche di go2rtc |

## Limiti

- HomeKit non permette di muovere la G3 (brandeggio), di usare i gesti, il riconoscimento dei volti o gli allarmi dell'hub: queste funzioni restano nell'app Aqara.
- La clip parte quando arriva il movimento: con HomeKit servono alcuni secondi per aprire il flusso, quindi l'inizio dell'evento può mancare.
- Il supporto HomeKit di go2rtc è stato provato dal suo autore proprio sulla G3 (versioni EU e CN).
