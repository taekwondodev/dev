# Comandi durante la sessione

Da scrivere nella conversazione della TUI di Pi già aperta, non nella shell.
Per avviare o aggiornare `dev`, vedi [Comandi da terminale](COMMANDS-TERMINAL.md).
Sostituisci `<id>` con l'identificativo del tentativo mostrato da `/work`.

## Lavori in background: comandi di dev

```text
/work
```

Mostra i tentativi della sessione e il loro stato. Per i writer con worktree registrato mostra anche il percorso e un promemoria: `blocked` finché l'uso del workspace non è risolto, altrimenti `review-required`, perché prenotazione e file restano conservati indipendentemente dal tentativo. Non significa “puoi cancellarlo”. Equivale a `/work list`.

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

## Workspace: comandi di dev

```text
/workspace
```

Elenca task e workspace del repository corrente, segnando il binding attuale e la directory effettiva. Equivale a `/workspace list`.

```text
/workspace inspect <task>
```

Mostra i workspace noti di quel task esatto con usi, operazioni in sospeso e prossima azione sicura. Un workspace con usi lasciati aperti da una sessione dev terminata appare come `blocked` e ne elenca gli usi. Non modifica nulla.

```text
/workspace resume <task> --workspace <workspace>
```

Sposta la conversazione corrente sul workspace conservato di quel task, senza importare altre conversazioni e senza trasferire file. Se il task ha più workspace e ometti `--workspace`, apre un selettore; Esc annulla senza effetti. Se in questa conversazione ci sono lavori o comandi shell ancora attivi, chiede conferma perché verranno fermati prima del cambio.

I comandi `!` e `!!` e il tool bash del lead girano nel workspace della conversazione tramite la shell di dev: il checkout resta occupato finché i processi avviati non risultano terminati. Un processo che si stacca in una nuova sessione sfugge a questa osservazione. Finché un processo della conversazione è vivo, il cambio di workspace e lo spostamento in un worktree separato vengono rifiutati con la guida per attenderlo o fermarlo con `/work stop`. Una lettura accanto a un writer mostra un avviso. I tool che dev non ha classificato per effetto vengono rifiutati con un motivo visibile. Le estensioni e i pacchetti in `.pi/` di una cartella fidata vengono caricati secondo il trust di Pi.

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

Avvia una nuova sessione. Il lavoro in background legato alla precedente viene interrotto, non trasferito alla nuova; anche i processi lanciati dalle shell della sessione precedente (bash del lead e comandi `!`), compresi quelli in background, vengono terminati. Se l'autorità dei workspace rifiuta la nuova conversazione, la sessione precedente è già chiusa quando arriva il rifiuto: è un limite noto, raro perché richiede un guasto dell'autorità.

```text
/resume
```

Apre la selezione di un'altra sessione da riprendere. Il cambio interrompe il lavoro in background e termina i processi delle shell della sessione che stai lasciando. Se la conversazione ripresa ha uno switch di workspace mai arrivato all'host, lo ritira e riparte dall'ultimo workspace confermato. Se la conversazione è ancora aperta in un'altra sessione di `dev`, anche di un'altra installazione, `/resume` viene rifiutato. Se il workspace legato alla conversazione, o la sua cartella di lavoro, è stato rimosso, `/resume` viene rifiutato senza ricrearlo. In entrambi i casi resti nella sessione corrente e l'avviso indica il file della conversazione, la cui cronologia resta intatta, e suggerisce di ripartire da un checkout esistente con `dev --cwd PATH`.

```text
/tree
```

Apre l'albero della conversazione per navigare tra i suoi rami. La navigazione invalida gli incarichi in background legati al contesto precedente.

```text
/fork
```

Crea una nuova sessione a partire da un messaggio precedente. Non crea un Git worktree: qui “fork” riguarda la conversazione, che parte nel workspace attuale della conversazione di partenza, anche se nel frattempo è stata spostata in un altro worktree. Il fork è però una conversazione nuova e non eredita il task: se quel workspace appartiene al task della conversazione di partenza, la prima scrittura del fork lo sposta in un worktree nuovo creato dal commit corrente, senza i file non committati, che restano alla conversazione di partenza. Committa prima di `/fork` se vuoi portarli con te. Come `/new`, termina i processi delle shell della sessione che lasci, e un rifiuto dell'autorità arriva quando la sessione è già chiusa. Mentre è in corso un cambio di workspace, `/new`, `/fork`, `/resume` e `/import` vengono rifiutati con un avviso.

```text
/import <file.jsonl>
```

Sostituisce la sessione corrente con una conversazione salvata. Se il file è già tra le sessioni di `dev`, vale come `/resume`: se la conversazione è aperta in un'altra sessione, l'import viene rifiutato. Se è una copia la cui cartella di lavoro non sta in un checkout Git, viene rifiutato prima di chiudere la sessione corrente e il file resta intatto. Se invece la cartella è in un checkout che l'autorità rifiuta, per esempio perché è stato sostituito, la sessione corrente è già chiusa quando arriva il rifiuto: è un limite noto.

```text
/compact
```

Compatta il contesto della conversazione corrente tramite Pi.

```text
/reload
```

Ricarica scorciatoie, estensioni, skill, prompt, temi e file di contesto. Non aggiorna il codice del checkout: per quello esiste `npm run update` nel terminale. I processi delle shell restano vivi e osservati; i lavori di `/work` invece vengono chiusi.

```text
/hotkeys
```

Mostra le scorciatoie da tastiera disponibili.

```text
/quit
```

Chiude Pi ed esegue lo shutdown del runtime, richiedendo l'arresto dei lavori posseduti e terminando i processi delle shell, anche in background. Non elimina le cartelle dei worktree né annulla le modifiche.
