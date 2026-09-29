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
/workspace check <task>
```

Mostra in sola lettura, come `dev workspace check`, il ruolo, il target e il verdetto con cui lo sweep tratterebbe ogni workspace di quel task esatto, con blocchi e prove. Gli usi di questa stessa conversazione contano come usi che finiscono quando esci. Non ferma nulla e non concede nulla.

```text
/workspace release <task>
```

Serve solo per i casi che lo sweep lascia `review-required`. Per il task di questa stessa conversazione risponde che è `/quit` a chiuderne gli usi e a fare lo sweep, senza valutare né chiedere nulla. Per un altro task mostra la valutazione; se nessun workspace è `review-required` spiega che non c'è nulla da rilasciare esplicitamente, altrimenti chiede conferma (Esc annulla senza effetti) e fa un tentativo per ogni workspace, mostrando il risultato nella conversazione. Se la conversazione si trova dentro un worktree temporaneo di quel task o vi è legata, dev rifiuta prima della conferma.

La conversazione riprende un workspace conservato solo tramite il tool `workspace` del lead (`resume`), non con un comando: il cambio avviene alla fine del turno, senza trasferire file, e viene rifiutato finché un lavoro o un comando shell di questa conversazione è ancora attivo.

Prima del rilascio, il workflow consegna e integra codice e asset da conservare, riconcilia i contributi degli agenti e pubblica i report utili nella issue o PR prima del merge, verificandone il contenuto. Una pubblicazione fallita o un contributo incompleto ferma la consegna: va mantenuto nel checkpoint del task, non trattato come materiale scartabile. Una copia locale non è una pubblicazione.

Il tool `workspace` del lead riprende un workspace conservato con `resume`, registra un target diverso da quello derivato dal remote `origin` con `set-target` e una pubblicazione già effettuata con `record-publication`, rileggendo il corpo o l'allegato GitHub con gli stessi byte. Non carica nulla, non recupera ref e non conosce le selezioni non registrate. Non servono regole o conferme per ogni cache. Il rilascio automatico o confermato può eliminare tutto ciò che resta nei worktree temporanei di dev finiti, comprese modifiche non committate e file dimenticati non consegnati né selezionati da conservare. I checkout pre-esistenti restano intatti e gli usi attivi o incerti continuano a bloccare la rimozione. La policy completa è in [ADR 0005](adr/0005-scoped-runtime-coordination.md#release).

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

Chiude Pi ed esegue lo shutdown del runtime, richiedendo l'arresto dei lavori posseduti e terminando i processi delle shell, anche in background. Poi, dopo aver chiuso la sessione e liberato le claim dell'installazione, dev fa lo sweep del repository: rimuove i worktree temporanei finiti, libera la prenotazione di un checkout pre-esistente pulito e conserva tutto il resto con il motivo. Stampa la ricevuta nella shell ed esce con 0 se ogni workspace tentato è arrivato a un esito terminale, altrimenti con 1. Un worktree che contiene il file della conversazione resta, come uno a cui è legata un'altra conversazione dev aperta. Un Ctrl-C durante lo sweep non lo ferma: ogni tentativo arriva al suo esito registrato (un passo Git raggiunto anche lui dall'interruzione finisce `partial`, da rilasciare esplicitamente) e dev esce con 130 dopo la ricevuta; se lo sweep non risponde, l'esito è sconosciuto: dev lo dice, rimanda a `dev workspace inspect` ed esce con 1. I segnali prima dello sweep, i crash e i riavvii non fanno sweep. SIGHUP dopo `/quit`, per esempio alla chiusura del terminale, termina dev senza ricevuta; lo sweep successivo osserva gli eventuali tentativi interrotti. Lo stesso sweep avviene prima che dev allochi un nuovo worktree, senza toccare i checkout pre-esistenti né i workspace della conversazione che alloca; la ricevuta compare nella conversazione quando ha qualcosa da riportare. Ogni sweep ha un budget, 40 secondi all'uscita e 20 prima di un'allocazione: esaurito quello, non inizia altri task né altri tentativi nel task corrente e riporta i task ancora da completare come rimandati allo sweep successivo; un tentativo già iniziato arriva al proprio esito.
