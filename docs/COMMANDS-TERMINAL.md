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

```bash
dev --cwd /percorso/del/progetto
```

Seleziona esplicitamente la directory di lavoro senza doverci entrare prima. Sessioni, preferenze e dati operativi restano nella data home dell'installazione di dev; l'autenticazione Pi resta condivisa nel file globale `~/.pi/agent/auth.json`.

```bash
dev --specialization general
```

Avvia una sessione temporanea con la specializzazione generale.

```bash
dev --specialization apple
```

Avvia una sessione temporanea con la specializzazione Apple.

```bash
dev --save-specialization general
```

Salva `general` come specializzazione predefinita per il repository corrente.

```bash
dev --save-specialization apple
```

Salva `apple` come specializzazione predefinita per il repository corrente.

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

```bash
dev --resume /percorso/sessione.jsonl
```

Riprende una sessione Pi specifica.

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

```bash
npm unlink --global dev-pi-environment --ignore-scripts
```

Rimuove il collegamento globale e il comando `dev`, senza eliminare il checkout o la sua data home privata. Non usare `npm link dev-pi-environment` nelle repository di lavoro: quello creerebbe un collegamento tra dipendenze, non il comando globale.
