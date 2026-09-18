# Comandi

```bash
npm run dev
```
Avvia `dev` con la TUI nativa di Pi nel progetto corrente.

```bash
npm run dev:general
```
Avvia una sessione temporanea con la specializzazione generale.

```bash
npm run dev:apple
```
Avvia una sessione temporanea con la specializzazione Apple.

```bash
npm run dev:save:general
```
Salva `general` come specializzazione predefinita per il repository corrente.

```bash
npm run dev:save:apple
```
Salva `apple` come specializzazione predefinita per il repository corrente.

```bash
npm run dev:diagnostics
```
Mostra l’installazione globale di Pi, la data home e le risorse selezionate senza avviare la TUI.

```bash
npm run dev:probe
```
Verifica la creazione del runtime e della sessione Pi senza aprire la TUI.

```bash
npm run dev:continue
```
Riprende la sessione Pi più recente del progetto corrente.

```bash
npm run dev:resume -- /percorso/sessione.jsonl
```
Riprende una sessione Pi specifica.

```bash
npm run setup
```
Crea la data home di `dev` e registra le versioni osservate di Node, Pi globale e workflow condiviso.

```bash
npm run setup -- --data-home /tmp/dev-data
```
Esegue il setup usando una data home esplicita.

```bash
npm run update -- --remote origin --branch main
```
Aggiorna il checkout di `dev` con un fast-forward, rifiutando modifiche locali o sessioni attive.

```bash
npm run rollback -- --ref <revisione>
```
Riporta il checkout di `dev` a una revisione specifica, rifiutando modifiche locali o sessioni attive.

```bash
npm run smoke
```
Esegue il controllo minimo di risoluzione dell’installazione globale di Pi e della specializzazione predefinita.

```bash
npm run dev:help
```
Mostra le opzioni disponibili del launcher.
