# Changelog

## 0.1.1

- Riconoscimento del robot più robusto: per ogni modello noto manda la stessa raffica di risveglio dell'app Narwal, così risponde anche un robot addormentato sulla base (prima mandava solo la richiesta di identificazione)
- Il registro mostra cosa risponde il robot durante il riconoscimento
- Nuove opzioni facoltative `device_id` e `product_key` per indicare il robot a mano

## 0.1.0

- Collegamento diretto al robot Narwal sul WebSocket locale (porta 9002), senza cloud, con riconoscimento automatico di modello e identificativo
- Stato, batteria, comandi (pausa, termina, base, trova, aspirazione, acqua, lavaggio e asciugatura mop, svuotamento)
- Mappa con stanze, base, posizione del robot e percorso; pulizia delle stanze scelte toccandole sulla mappa
- Programmi a orario o "quando la casa resta vuota", con stanze, modalità, salto delle stanze occupate o pulite da poco, batteria minima, azione al rientro
- Storico di tutte le pulizie con percorso, diario, statistiche
- Entità in Home Assistant via MQTT: aspirapolvere, sensori, pulsanti per stanza, interruttori dei programmi
- Modalità demo con robot simulato
