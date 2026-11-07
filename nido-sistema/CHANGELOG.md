# Changelog

## 0.2.1

- L'app usa la rete dell'host. Un `/sys` montato dentro un container appartiene alla rete del container e resta in sola lettura come quello che Home Assistant gli dà; con la rete dell'host il montaggio è quello del sistema
- La diagnosi mostra come è stato montato il `/sys` scrivibile

## 0.2.0

- Comando della ventola sistemato. Home Assistant monta `/sys` in sola lettura in tutte le app, anche con l'accesso completo, che dà solo l'accesso ai dispositivi. Ora l'app chiede il solo permesso `SYS_ADMIN` e monta un secondo `/sys`, in scrittura, nella propria cartella privata
- Non serve più disattivare la Modalità protezione: si può riattivare

## 0.1.3

- La scheda Ventola mostra se per Home Assistant la Modalità protezione è attiva e se l'app ha davvero i permessi, per capire subito dove sta il blocco

## 0.1.2

- Se `/sys` è montato in sola lettura, l'app prova a rimontarlo in scrittura (possibile solo con l'accesso completo)
- La diagnosi dice se l'app sta girando davvero con l'accesso completo (Modalità protezione disattivata)

## 0.1.1

- Disattivato il profilo AppArmor dell'app: anche con l'accesso completo impediva di scrivere in `/sys`, quindi di comandare la ventola
- Se il controllo non riesce, il messaggio riporta il file e l'errore esatti

## 0.1.0

- Temperature di CPU, chip RP1 e SSD NVMe; velocità reale della ventola; frequenza, uso e carico della CPU; memoria, disco, tempo di accensione
- Alimentazione: sottotensione e rallentamenti segnalati dal firmware
- Ventola: modalità automatica (firmware), silenziosa, bilanciata, fresca, massima o curva personalizzata, con isteresi; sopra 80 °C sempre al massimo; "Raffredda ora" per 15 minuti o un'ora
- All'arresto dell'app la ventola torna al firmware
- Storico fino a 30 giorni con grafici di temperature, ventola e carico
- Avvisi sul telefono: CPU calda, sottotensione, ventola ferma
- Entità in Home Assistant via MQTT: sensori, modalità della ventola, pulsante "al massimo 15 minuti"
- Modalità demo con un Raspberry Pi simulato
