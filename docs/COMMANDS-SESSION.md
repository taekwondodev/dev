# Comandi durante la sessione

Da scrivere nella conversazione della TUI di Pi già aperta, non nella shell.
Per avviare o aggiornare `dev`, vedi [Comandi da terminale](COMMANDS-TERMINAL.md).
Sostituisci `<id>` con l'identificativo del tentativo mostrato da `/work`.

## Lavori in background: comandi di dev

```text
/work
```

Mostra i tentativi della sessione e il loro stato. Per i writer con worktree registrato mostra anche il percorso e il promemoria di pulizia: `blocked` se terminazione o rilascio della prenotazione non sono confermati, `review-required` se occorre verificarne integrazione e uso attuale prima dell'eventuale rimozione. Non significa “puoi cancellarlo”. Equivale a `/work list`.

```text
/work dispatch
```

Mostra le regole disponibili per scegliere modello e livello di ragionamento dei figli. Legge `config/crew-dispatch.json` nel checkout di `dev`, anche quando lavori su un altro progetto o usi una data home diversa; non crea regole e non cambia il modello della sessione principale.

```text
/work inspect <id>
```

Mostra dettagli, esito e riepilogo dei log del tentativo, con eventuali cambiamenti del codice da rivalutare. Include il promemoria del worktree quando il percorso è stato registrato; non ricostruisce percorsi mancanti dai vecchi tentativi.

```text
/work inspect <id> stdout 0
```

Legge l'output del processo dall'inizio. Se è troncato, usa il valore `nextOffset` restituito al posto di `0` per leggere la pagina successiva.

```text
/work inspect <id> stderr 0
```

Legge dall'inizio il flusso degli errori del processo.

```text
/work inspect <id> result 0
```

Legge dall'inizio la risposta finale conservata di un figlio Pi, quando disponibile.

```text
/work stop <id>
```

Chiede di fermare un tentativo della sessione attiva. La terminazione deve essere osservata; il comando non annulla le modifiche e non elimina il worktree.

```text
/work stop
```

Interrompe tutti i tentativi della sessione attiva e invalida la consegna dei loro esiti tardivi. Funziona anche quando il lead non sta rispondendo.

Per **avviare** un comando in background o un figlio, chiedilo al lead in linguaggio naturale: l'agente usa il tool `work` con i parametri necessari. Non esiste un comando `/work start`.

## Sessione e modello: comandi nativi di Pi

Questi sono i principali comandi nativi, verificati nell'installazione Pi 0.86.1; non sono aggiunte di `dev`.

```text
/model
```

Apre il selettore del modello della sessione principale. Non modifica i figli già in esecuzione: modello e ragionamento di ciascun figlio vengono risolti al suo avvio.

```text
/thinking high
```

Imposta il livello di ragionamento della sessione principale su `high`, se supportato dal modello scelto. Non è una regola di assegnazione dei modelli per task.

```text
/settings
```

Apre il menu delle impostazioni di Pi.

```text
/login
```

Apre la configurazione dell'autenticazione ai provider. Segui il flusso dedicato: non scrivere credenziali nei messaggi della conversazione.

```text
/session
```

Mostra informazioni e statistiche della sessione Pi corrente. Per i lavori delegati usa anche `/work`.

```text
/new
```

Avvia una nuova sessione. Il lavoro in background legato alla precedente viene interrotto, non trasferito alla nuova.

```text
/resume
```

Apre la selezione di un'altra sessione da riprendere. Il cambio interrompe il lavoro in background della sessione che stai lasciando.

```text
/tree
```

Apre l'albero della conversazione per navigare tra i suoi rami. La navigazione invalida gli incarichi in background legati al contesto precedente.

```text
/fork
```

Crea una nuova sessione a partire da un messaggio precedente. Non crea un Git worktree: qui “fork” riguarda la conversazione.

```text
/compact
```

Compatta il contesto della conversazione corrente tramite Pi.

```text
/reload
```

Ricarica scorciatoie, estensioni, skill, prompt, temi e file di contesto. Non aggiorna il codice del checkout: per quello esiste `npm run update` nel terminale.

```text
/hotkeys
```

Mostra le scorciatoie da tastiera disponibili.

```text
/quit
```

Chiude Pi ed esegue lo shutdown del runtime, richiedendo l'arresto dei lavori posseduti. Non elimina le cartelle dei worktree né annulla le modifiche.
