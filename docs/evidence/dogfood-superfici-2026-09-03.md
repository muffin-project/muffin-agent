# Dogfood delle superfici — memo di decisione, 2026-09-03

**Evidence datata, non authority.** Registra i failure che l'owner ha osservato
usando Muffin il 02–03/09, la ricostruzione sul codice, cosa fanno i peer (fonti
lette il 03/09, non a memoria) e le decisioni prese. Lo stato dei requisiti resta
in `docs/work/day1/requirements-status.md`; l'ordine in
`docs/work/day1/critical-path.md`; la decisione sull'input mentre un turno è
vivo in ADR-0054.

## 1. Problema osservato

Parole dell'owner, 03/09:

- Telegram: «lo streaming text e tools si può migliorare, essendo un vero
  streaming anche i numeri e tutto dovrebbero essere in tempo reale»; «non
  voglio perdere gli step che ha fatto»; preferisce «una cosa alternata» fra
  testo e tool «senza mandare 1000 messaggi»; «non voglio mai testo tagliato,
  anche quando chiede cosa fare con un comando»; vorrebbe «un riassunto
  testuale che dice cosa fa quel comando».
- CLI: «dovrebbe effettivamente tenere la box di testo sotto, le notifiche in
  alto, il testo scrollabile senza muovere ste due sezioni».
- Metodo: «non mi fa impazzire che facciamo test fake… vorrei test end to end
  VERI, non finti».
- Input mentre lavora: «il messaggio mentre un turno è vivo va in queue, a meno
  che non facciamo `/steer`»; «assicuriamoci di avere anche `/stop` `/resume`
  `/pause`».

Il punto di metodo che questa memo registra prima di tutto: **B11 e B13 erano
READY** nell'inventario, provati sul binario vero con il finto provider e il
finto Bot API — e l'esperienza dell'owner li contraddice. Non perché lo
scenario menta: perché misura un'altra cosa. Il finto provider risponde in un
colpo solo e il finto Bot API non ha né rate limit né `getFile`; «si vede bene»
non era mai stato nel perimetro. È esattamente la regola di stop del handoff:
il lavoro nasce da un failure osservato usando Muffin.

## 2. Ricostruzione sul codice (HEAD `dev` 1b860ac)

### Telegram

| fatto | dove |
|---|---|
| Il loop emette già tutto: ogni `text_delta` appena arriva, un `boundary` che chiude il preambolo di una tool call, un `onProgress` per ogni tool | `agent/loop.ts` §`TurnInput.onDelta`, `TurnEvent` |
| Al `boundary` la superficie **azzera** il draft: il preambolo («leggo il file…») sparisce | `connectors/telegram/connector.ts` §`onDelta` |
| L'avanzamento è **un** messaggio editato e **cancellato** a fine turno: gli step sono persi per disegno («mai una cronologia», B13) | `connectors/telegram/progress.ts` §`stop` |
| Draft aggiornato al più ogni 1 s; avanzamento ogni 3 s e **solo su evento** — il contatore dei secondi salta, non scorre | `presence.ts` `MIN_LIVE_UPDATE_MS`, `progress.ts` `MIN_EDIT_MS` |
| Oltre un messaggio (4096 resi) il draft **si congela**; la risposta intera arriva a fine turno, spezzata bene | `presence.ts` §`sendLive` |
| L'ASK tronca gli argomenti a **220 caratteri**: un comando lungo arriva monco proprio dove l'owner decide | `agent/loop.ts` §`summarizeCallArgs` |
| `shell_run` non ha un campo in cui il modello dica *cosa fa* il comando | `agent/tools/shell.ts` §`shellSpec.inputSchema` |
| Mentre un turno gira il poller **non chiama `getUpdates`**: `drain()` attende `runFresh`. Un messaggio inviato nel frattempo resta sui server di Telegram e viene letto dopo. Coda FIFO di fatto, senza ack, e nessun comando può raggiungere un turno vivo | `connector.ts` §`run`, §`drain` |

### CLI

| fatto | dove |
|---|---|
| Niente schermo alternato, cornice su stderr, risposta nuda su stdout — la scelta è già quella dei peer | `cli/STYLES.md` §«Quello che non facciamo» |
| Il riquadro si ridisegna cancellando le proprie righe; una consegna fuori banda «toglie, scrive, rimette» | `cli/repl.ts` §`consegnaTerminale` |
| **Nessuna scroll region**: mentre la risposta scorre in streaming, il riquadro non è ancorato | `cli/textzone.ts` |
| La larghezza visibile conta `.length`: sbagliata con CJK e combining | `cli/textzone.ts` §`larghezzaVisibile` |

### Comandi

`agent/comandi.ts` ha `/exit /help /new /session /spend /debug /think /model`,
letti da entrambe le superfici. Non esistono `/stop`, `/steer`, `/pause`,
`/resume`. Il loop accetta già un `AbortSignal` e chiude il turno con
`aborted · «Interrotto.»`; lo scheduler ha `ForegroundGate` e `StandDown`.

## 3. Cosa fanno i peer (fonti lette il 03/09)

**Telegram.**
- OpenClaw (`docs.openclaw.ai/channels/telegram`): edit di un messaggio di
  anteprima, quattro modi `channels.telegram.streaming` — `progress` (default:
  un draft di stato per i tool, poi la risposta come messaggio a parte),
  `partial` (testo nel preview), `block`, `off`; `preview.commandText:
  status|raw`; `chunkMode: "newline"` spezza ai paragrafi prima che alla
  lunghezza; `textChunkLimit` 4000.
- Hermes (`hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram`):
  `sendMessageDraft` nelle DM (`gateway.streaming.transport: auto|draft|edit|off`),
  bolle intermedie per i tool con `disable_notification`, che **spariscono** a
  fine risposta; oltre il limite «falls back … your message is never lost».

Nessuno dei due fa l'alternanza persistente che l'owner chiede. Entrambi
confermano due cose che adottiamo: spezzare ai paragrafi, e non perdere mai il
testo.

**Terminale.**
- Codex (`codex-rs/tui/src/insert_history.rs`): «Codex uses the terminal
  scrollback itself for finalized chat history» — composer in un *inline
  viewport* in fondo, cronologia inserita **sopra** con una scroll region
  DECSTBM (`SetScrollRegion(1..area.top())`), modalità full-screen solo dove le
  scroll region parziali sono inaffidabili (Zellij).
- Claude Code / Ink (`readme.md`): «`<Static>` permanently renders its output
  above everything else»; la zona dinamica si ridisegna sotto.
- pi (`packages/tui/README.md`): rendering differenziale in main screen,
  «completed content scrolls into scrollback», synchronized output
  (`\x1b[?2026h`).

**Nessuno ha una zona fissa in alto.** Stato e notifiche stanno subito sopra la
casella. La ragione è tecnica: un margine superiore fisso fa perdere lo
scrollback nella maggior parte dei terminali; un margine inferiore no.

**Riassunto del comando.** Claude Code ottiene la riga sopra il comando da
approvare con un argomento `description` del tool `Bash` che il modello riempie.
È un campo di schema, non una seconda chiamata al modello.

## 4. Proprietà da preservare

1. La risposta finale è durevole e mai duplicata (`delivery.ts`, ADR-0046); le
   bolle intermedie sono cosmetiche e non passano dal WAL.
2. Nessuna superficie mostra testo che poi ritira (`onDelta` §«stream, then
   retract» resta scartato): un `boundary` chiude, non cancella.
3. Un vocabolario solo per i passi su terminale e Telegram
   (`agent/tool-phrase.ts`).
4. B11: i byte su stdout di un turno in streaming sono gli stessi di uno non in
   streaming; la cornice vive su stderr.
5. `update_id` è idempotenza dell'evento, non identità del Work (ADR-0052).
6. Niente framework TUI (`docs/evidence/tui-2026-08-27.md` regge).

## 5. Decisioni

### 5.1 Telegram: una bolla per segmento, non per evento

Regola: **si apre un messaggio nuovo solo quando il modello riparla dopo dei
tool.** Dentro un segmento: preambolo in streaming (draft in privato → edit) e
righe `✓ leggo un file: spesa.txt` appese **sotto, nello stesso messaggio**,
finalizzato in place e **non cancellato**. Giri di soli tool si accodano al
segmento precedente. Il numero di messaggi è il numero di volte che ha parlato,
non il numero di tool. La risposta finale resta un messaggio suo, durevole.

Conseguenze puntuali:
- oltre i 4096 resi il segmento si **chiude** e se ne apre un altro, invece di
  congelarsi: mai testo tagliato;
- il contatore dei secondi si aggiorna anche senza evento, dentro il rate
  limit già esistente;
- l'ASK **non tronca**: il comando va in `<pre>` spezzato con `splitHtml`, e la
  domanda intera arriva sempre;
- `shell_run` acquista `description` obbligatorio (una frase, cosa fa il comando)
  che l'ASK mostra sopra il comando — stesso meccanismo di Claude Code.

Profilo: STANDARD (superficie; lo schema del tool cambia, la policy no).

### 5.2 CLI: scroll region, casella e stato in fondo

DECSTBM `\x1b[1;{righe-k}r` aperta all'avvio del REPL su TTY, chiusa in
uscita e ricalcolata su `SIGWINCH`. stdout continua a scrivere byte nudi
dentro la regione (B11 intatto); il riquadro e una riga di stato/notifiche
vivono nelle `k` righe fisse sotto. **Le notifiche vanno sopra la casella, non
in cima allo schermo**: in cima costerebbero lo scrollback, e la regola di
`STYLES.md` vale più della cornice. Se l'owner le vuole davvero in alto, è una
rinuncia da scrivere lì. `cli/schermo.ts` impara `r` e resta il misuratore.
Zero librerie; `string-width` è l'unica piccola che chiude un difetto vero.

*Addendum, stesso giorno, dopo la prova in tmux:* la regione non si apre
all'avvio. Saltare in fondo su uno schermo fresco scorreva via
l'intestazione e lasciava un vuoto; ora la casella **segue** il contenuto
finché ci entra sotto (come Ink) e si aggancia quando arriva in fondo —
il terminale dice dove sta il cursore (`ESC[6n`) prima di ogni lettura,
finché non è agganciata. `cli/fondo.ts`, `cli/STYLES.md` §«Il fondo fisso».

Profilo: STANDARD.

### 5.3 Input mentre un turno è vivo

Decisione owner, registrata in **ADR-0054**: coda per default, `/steer` per
correggere il turno in corso al prossimo confine sicuro, `/stop` per
interromperlo, `/pause` e `/resume` per fermare e riprendere il runtime. Il
poller deve continuare a ricevere mentre un turno gira (B2).

### 5.4 Test end-to-end veri

Accanto all'accettazione finta nasce una corsia **reale**, eseguita in locale
dall'owner e mai in CI: modello vero con la chiave dell'owner (`LLM_API_KEY`,
mai stampata — il precedente è `evals/memory/acceptance.ts`) e Bot API vera
verso la chat dell'owner. Il finto resta per determinismo e mutazioni; il vero
è la prova che «si vede bene». Le righe user-facing dell'inventario dichiarano
quale delle due le prova.

*Costruita lo stesso giorno:* `evals/e2e/telegram.ts` (`npm run e2e:telegram`,
`evals/e2e/README.md`). Un proxy locale registra il filo fra il gateway e
`api.telegram.org`; tre passi guidati — trascrizione/ASK, coda, `/stop` —
con le asserzioni sul filo. Serve un bot di prova e un telefono: la esegue
l'owner, e il suo verde si scrive nelle righe B11/B13/B2/D12 con la data.

### 5.5 Librerie (giro del 03/09, `npm outdated`)

| pacchetto | ora | latest | nota |
|---|---|---|---|
| `typescript` | 5.9.3 | 7.0.2 | port nativo; `tsc` è il passo lento dei job |
| `vitest` | 2.1.9 | 4.1.11 | due major |
| `better-sqlite3` | 12.11.1 | 13.0.3 | da provare su Linux/Node 22 prima |
| `@grammyjs/types` | 4 | 5 | `sendMessageDraft` oggi è tipato a mano in `api.ts` |
| `openai` `zod` `js-yaml` `cron-parser` `tsx` `defuddle` | — | minor | sicuri |

Framework (Ink, ratatui via N-API, opentui) restano fuori. Piccole che valgono:
`string-width`. Le major si prendono una per PR, con l'accettazione Linux.

### 5.6 Fonti da distillare per il DAY-1

Da leggere quando il dominio entra nel lavoro, non prima: OpenClaw
`channels/telegram` (modi di streaming, `chunkMode`); Hermes
`gateway.streaming`; Codex `insert_history.rs` e `styles.md`; Ink `<Static>`;
pi-tui README (synchronized output); Anthropic *Writing tools for agents* (per
`description`); Telegram Bot API `sendMessageDraft`, `editMessageText`, limiti
di rate per chat/gruppo.

## 6. Cosa cambia nell'inventario

B11 e B13 tornano **BLOCKER** con causa dogfood (§1) finché 5.1 non è provata
sulla corsia reale; D12 resta READY ma la sua riga registra il troncamento a
220 come difetto aperto chiuso da 5.1. B2 resta BLOCKER con la forma decisa in
ADR-0054. L'ordine in `critical-path.md` mette le superfici prima delle «due
porte», perché sono ciò che rende il dogfood sopportabile.

## 7. Come falsificare

- 5.1 è sbagliata se, sulla corsia reale, un turno con N tool produce più di
  «numero di segmenti parlati + 1» messaggi, o se un testo qualunque arriva
  troncato.
- 5.2 è sbagliata se, con la scroll region attiva, una risposta più alta dello
  schermo perde righe dallo scrollback o il riquadro si duplica
  (`cli/schermo.ts`).
- 5.3 è sbagliata se un `/stop` inviato a metà turno viene letto solo a fine
  turno.
