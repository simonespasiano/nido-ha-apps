# Changelog

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
