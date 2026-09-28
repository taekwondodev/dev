# Comandi da terminale

Da eseguire nella shell, non nella conversazione Pi. Per l'uso quotidiano entra nella repository su cui vuoi lavorare e usa `dev`; la cartella di installazione serve solo per setup e manutenzione.
Per i comandi da scrivere nella TUI già aperta, vedi [Comandi durante la sessione](COMMANDS-SESSION.md).

## Setup iniziale: dalla cartella di installazione

```bash
cd ~/Developer/dev
npm ci
npm run setup
npm link --ignore-scripts
```

Installa le dipendenze di dev, prepara la data home e collega il comando `dev` al checkout tramite npm. Pi globale e la libreria condivisa devono già essere disponibili. Il collegamento non pubblica il pacchetto e non aggiunge dipendenze alle repository su cui lavori.

```bash
npm config get prefix
command -v dev
```

Verifica il prefisso npm e la disponibilità del comando. Su macOS/Linux la directory `bin` del prefisso deve essere nel `PATH`. Se sposti il checkout o cambia il percorso dell'eseguibile nel pacchetto, esegui nuovamente `npm link --ignore-scripts` dal checkout.

## Uso quotidiano: dalla repository di lavoro

```bash
dev
```

Avvia la TUI nativa di Pi mantenendo la directory corrente. Pi carica le istruzioni del progetto e degli antenati applicabili, non quelle del checkout di dev solo perché il programma è installato lì.
Puoi aprire un'altra TUI su un repository indipendente con la stessa data home. Una conversazione già aperta da un'altra sessione dev viene rifiutata; le sessioni indipendenti restano utilizzabili.

```bash
dev --cwd /percorso/del/progetto
```

Seleziona esplicitamente la directory di lavoro senza doverci entrare prima. Sessioni, preferenze e dati operativi restano nella data home dell'installazione di dev; l'autenticazione Pi resta condivisa nel file globale `~/.pi/agent/auth.json`.

```bash
dev --profile general
```

Avvia una sessione temporanea con il profilo generale.

```bash
dev --profile apple
```

Avvia una sessione temporanea con il profilo Apple.

```bash
dev --save-profile general
```

Salva `general` come profilo predefinito per il repository corrente.

```bash
dev --save-profile apple
```

Salva `apple` come profilo predefinito per il repository corrente.

```bash
dev --diagnostics
```

Mostra la directory di lavoro, l’installazione globale di Pi, la data home, il percorso del dispatch e le risorse selezionate senza avviare la TUI. Non stampa né duplica credenziali: `dev` usa l'`auth.json` globale di Pi.

```bash
dev --probe-runtime
```

Verifica la creazione del runtime e della sessione Pi senza aprire la TUI.

```bash
dev --continue
```

Richiede al launcher di riprendere la sessione Pi più recente per la directory di avvio.
La scelta usa la data di modifica del file e la directory registrata nell'intestazione Pi, non la data dell'ultimo messaggio. Se la conversazione scelta è già aperta, il comando fallisce: non passa automaticamente alla successiva.

```bash
dev --resume /percorso/sessione.jsonl
```

Riprende una sessione Pi specifica. Se la conversazione ha uno switch di workspace mai arrivato all'host, lo ritira e riparte dall'ultimo workspace confermato. Se la conversazione è ancora aperta in un'altra sessione di `dev`, anche di un'altra installazione, il comando si ferma senza toccarla e ti chiede di chiuderla prima. Se il workspace legato alla conversazione, o la sua cartella di lavoro, è stato rimosso, il comando lo segnala senza ricrearlo, indica il file della conversazione (la cronologia resta intatta) e suggerisce di ripartire da un checkout esistente con `dev --cwd PATH`.

Quando più sessioni scrivono sullo stesso checkout, la prima resta nel checkout; un'altra attività viene spostata in un worktree dedicato creato dal commit corrente, senza copiare file modificati, non tracciati o ignorati. Un comando shell occupa solo il proprio checkout fino a quando i processi che ha avviato risultano terminati; gli altri worktree dello stesso repository continuano a lavorare.

```bash
dev workspace
```

Elenca task e workspace registrati per il repository Git della directory corrente o di `--cwd`, inclusi quelli in pausa o bloccati. Equivale a `dev workspace list`. È in sola lettura: non crea l'autorità, non apre sessioni Pi e non richiede credenziali.

```bash
dev workspace inspect <task>
```

Mostra tutti i workspace noti di quel task esatto, anche in altri repository: percorso, origine, usi attivi o incerti, operazioni in sospeso e prossima azione sicura. Un uso `unknown` blocca il suo workspace per nuovi writer finché non esisterà un recupero esplicito, che la prima versione non offre. Dopo un crash, un workspace con usi lasciati aperti da una sessione dev ormai terminata appare come `blocked`, non come `active`, e il motivo elenca quegli usi: anche mentre un'altra sessione lavora nello stesso checkout e anche dopo che hai ripreso la stessa conversazione.

```bash
dev workspace resume <task> --workspace <workspace>
```

Apre una nuova conversazione sul workspace conservato di quel task. `--workspace` è obbligatorio solo se il task ha più workspace. Non sposta file modificati, non riavvia lavori e non sostituisce un workspace occupato, mancante o sostituito.

```bash
dev workspace check <task>
```

Mostra, in sola lettura, se ogni workspace di quel task esatto potrebbe essere rilasciato adesso: usi attivi, identità, stato Git, prova di integrazione nel target concordato, file non tracciati coperti da una pubblicazione verificata o da una regola approvata, e i blocchi rimasti. Un checkout pre-esistente può risultare `releasable` (si libera solo la prenotazione); un worktree creato da dev risulta `removable` solo a questo controllo. Non prenota, non recupera ref, non pubblica nulla e non memorizza alcun permesso: il rilascio ricontrolla tutto.

```bash
dev workspace release <task>
```

Mostra la valutazione e le conseguenze, chiede conferma nel terminale e fa un solo tentativo di rilascio per ciascun workspace confermato, valutato indipendentemente. Per un checkout pre-esistente, anche il principale, libera soltanto la prenotazione del task: file e commit restano intatti e le modifiche residue vengono riportate. Un worktree creato da dev viene rimosso solo se il commit corrente è integrato nel target concordato, ogni file non tracciato è coperto da una pubblicazione verificata o da una regola approvata nella sua versione esatta e nessuna sessione lo usa; contenuti sconosciuti o sensibili lo bloccano. Serve un terminale interattivo: senza conferma non rilascia nulla e non esiste una modalità `--yes`. Se la shell da cui lanci il comando si trova dentro un worktree rimovibile, quel worktree resta e va rilasciato da fuori. Un rilascio interrotto prima di registrare il suo esito compare come `review-required` e blocca la ripresa del workspace: il rilascio esplicito successivo osserva ciò che ha fatto, lo chiude e rivaluta lo stato corrente, senza ripetere nulla. Finché il workspace esiste, `check`, `inspect` e ogni rilascio successivo elencano i file che un tentativo precedente ha registrato come cancellati; se il tentativo si è interrotto a metà delle cancellazioni, avvisano che altri file potrebbero mancare finché il rilascio successivo non li osserva e li elenca come assenti. Se Git si ferma dopo aver cancellato la directory del worktree e svuotato la sua directory di amministrazione, il rilascio successivo rimuove soltanto quella directory vuota; se non è vuota, non è leggibile o indica ancora un worktree spostato, resta a te, con il percorso e il motivo. Ripetere il comando è una richiesta nuova con controlli nuovi.

I comandi `workspace` escono con 0 quando restituiscono l'osservazione richiesta o quando ogni rilascio confermato termina con `released`, `removed` o `already-absent`; con 1 se l'osservazione non è ottenibile o il rilascio è bloccato, parziale o incerto; con 2 per argomenti non validi o ambigui e quando manca l'interazione richiesta; con 130 se annulli la conferma o interrompi il rilascio con Ctrl-C: il tentativo già avviato arriva al suo esito, il riepilogo lo riporta e i workspace non ancora tentati restano com'erano. Un `check` esce con 0 anche quando elenca blocchi: il testo li riporta e l'uscita 0 non è un permesso di rimozione.

```bash
dev --help
```

Mostra le opzioni disponibili del launcher.

## Alternative senza collegamento globale

```bash
node "$HOME/dev/src/launcher.ts"
```

Avvia il launcher direttamente dalla repository di lavoro, mantenendo la directory corrente.

```bash
npm --prefix "$HOME/Developer/dev" start -- --cwd "$PWD"
npm --prefix "$HOME/Developer/dev" run dev:apple -- --cwd "$PWD"
```

Usa gli alias npm esistenti indicando il progetto esplicitamente. npm esegue gli script nella cartella del pacchetto anche con `--prefix`: omettere `--cwd` seleziona il checkout di dev. `npm start` e `npm run dev` lanciati dentro `~/Developer/dev` servono quindi a lavorare su dev stesso. `npm --silent start` nasconde anche il banner di npm.

## Manutenzione: dalla cartella di installazione

I comandi seguenti si eseguono dentro `~/Developer/dev`. Per modificare il codice dell'ambiente, vedi [Development](DEVELOPMENT.md).

```bash
npm run setup
```

Crea la data home di `dev` (per default `.dev/` nel checkout, ignorata da Git) e registra le versioni osservate di Node, Pi globale e workflow condiviso. L'autenticazione resta nel file globale `~/.pi/agent/auth.json`; il dispatch resta nel file versionato `config/crew-dispatch.json`.

```bash
npm run setup -- --data-home /tmp/dev-data
```

Esegue il setup usando una data home esplicita per i dati privati, senza spostare o duplicare il dispatch versionato.

```bash
npm run update -- --remote origin --branch main
```

Aggiorna il checkout di `dev` con un fast-forward, rifiutando modifiche locali o sessioni attive. Se `.dev/` esiste, rifiuta anche una revisione che ne rimuova la protezione Git o ne tracci il contenuto.

```bash
npm run rollback -- --ref <revisione>
```

Riporta il checkout di `dev` a una revisione specifica, rifiutando modifiche locali o sessioni attive. Se `.dev/` esiste, non accetta una revisione che smetta di ignorarla o ne tracci il contenuto: per tornare al vecchio layout occorre prima ricollocare esplicitamente i dati privati.

Setup, update e rollback richiedono l'esclusiva sull'installazione anche se le TUI usano `--data-home` diversi. Chiudi tutte le TUI dev prima della manutenzione. I file di coordinamento sotto `.dev/coordination/` restano sul disco dopo l'uscita; non rimuoverli durante l'uso. I vecchi `runtime.lock` non vengono più letti né cancellati: le revisioni precedenti di dev non partecipano al nuovo protocollo. Pi globale e programmi esterni a dev non partecipano a questa protezione. Dettagli e limiti: [ADR 0005](adr/0005-scoped-runtime-coordination.md).

```bash
npm unlink --global dev-pi-environment --ignore-scripts
```

Rimuove il collegamento globale e il comando `dev`, senza eliminare il checkout o la sua data home privata. Non usare `npm link dev-pi-environment` nelle repository di lavoro: quello creerebbe un collegamento tra dipendenze, non il comando globale.
