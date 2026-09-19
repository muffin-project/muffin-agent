# ADR-0086 — La lease finisce, il lavoro continua: turno continuabile

**Stato:** accettato · 2026-09-19 · evidenza: `muffin.db`/`traces` 18/09/2026 (turni `ecba5616`, `68f3244c`, `5981a64e`), incident Telegram video/Manim.

## Contesto

Il 18/09 tre turni del video Manim sono finiti `done/error` con «Il modello
non ha prodotto una risposta utilizzabile» dopo minuti di lavoro utile
(letture file, ffprobe, scoperta del venv `~/dev/manim-video/.venv`,
render Manim approvato ed eseguito). Le tracce mostrano la causa: risposte
completate con `stop=error`, zero token, nessuna attività, ~30.0s l'una —
stalli upstream dentro una forma di successo — che consumavano tutti e
cinque i rung della cascade semantica mentre i budget di trasporto (10/10),
di muro (~40% speso) e attivi restavano intonsi.

Il "riprendi" dell'owner apriva poi un turno **nuovo** che rileggeva gli
stessi file e riscopriva lo stesso venv: il record durevole del turno
fallito (`Message[]`, WAL, contatori, taint, model pin) esisteva ma niente
lo leggeva mai. Due fatti confusi in uno: **la lease di esecuzione era
finita, il lavoro no** — e `resumeTurn` rifiuta strutturalmente ogni riga
`done`, quindi non esisteva strada dal secondo al primo.

## Decisione

1. **Stato non-terminale `continuable`** (`TurnStatus`, con rebuild
   transazionale della CHECK sui DB installati). Lo scrive solo
   `releaseContinuable`, solo da `running`, solo per fallimenti di lease
   recuperabili (tassonomia chiusa `ContinuableClass`: provider_empty,
   truncated, provider_transport, watchdog/deadline/budget di lease,
   recovery_exhausted). Mai da `waiting` (barriera pendente), mai da `done`.
2. **La lease è un permesso temporaneo, il Turn è il lavoro.** Rinnovo in
   un'unica operazione esplicita (`grantContinuation`): claim recintato,
   contatori lease-local rifatti dal profilo, lifetime piegata dalle righe
   `turn_leases` (fonte di verità) — mai fornita dal chiamante. La lane non
   preleva mai `continuable` da sola: solo una continuazione esplicita
   dell'owner crea la lease successiva.
3. **Classificazione prima del recupero** (P0-A, già atterrato): `stop=error`
   + zero output + zero attività non entra mai nella cascade semantica —
   re-drive limitato sul budget di trasporto, poi diagnostica veritiera
   (classe, tentativi, completato, id turno, "riprendi").
4. **Controllo lease-local vs evidenza durevole** (`Message.origin`):
   recovery, nudge, wake report sono `harness` — archiviati in `turn_leases`,
   mai rieseguiti nella lease dopo. Parole dell'owner, tool_use/tool_result,
   steer: evidenza, sopravvivono. Nessun messaggio compensativo in prosa.
5. **`riprendi` deterministico e conservativo**: un solo candidato
   continuabile recente in owner/sessione → auto-continue senza conferma;
   zero → conversazione ordinaria; più di uno → domanda (mai guess); nuovo
   oggetto diretto ("riprendi quel testo") → ordinario. Niente LLM, niente
   memoria, niente comando globale. `muffin resume <id>` riusa la stessa
   primitiva per recovery/debug.
6. **Protezioni**: reidratazione deterministica degli echo sensibili
   dall'evidenza durevole (un solo classificatore con la raccolta live);
   taint monotono dal record; model pin rifiutato rumorosamente; approvazioni
   consumate una volta; `/stop`, risposte e rifiuti terminali (spesa, policy,
   filtri, chiavi morte) mai resuscitati; `resumes` resta il bound
   anti-crash-loop (le continuazioni si contano in `lifetime.leases`);
   doppia claim recintata.

Questo rovescia parzialmente due note: `TurnRun.requireToolOnce` "effimero"
(ADR-0082 resta vero *dentro* una lease; fra lease la metà-messaggio viene
archiviata insieme al flag, quindi la perdita resta consistente) e il testo
generico di `round.ts` per la cascade esaurita (ora è una lease che cede,
non un errore terminale).

## Alternative considerate

- **Work/Goal sopra i turn** (alla Hermes: goal persistente, contratti,
  gate): respinto per P0 — la riga turno basta come vettore del lavoro
  incompiuto; il disegno resta compatibile (lease già reificate in
  `turn_leases`) senza implementare il livello ora.
- **Retry budget più grande / deadline infinita**: respinto — maschera un
  fallimento provider a forma di successo con i budget intonsi a provarlo.
- **`riprendi` inferito dal modello / memoria semantica**: respinto —
  non deterministico; la risoluzione è una query su stato durevole.
- **Riuso di `waiting` o `done/error` per il continuabile**: respinto —
  `waiting` significa una condizione di risveglio nota; `done` è rifiutato
  strutturalmente da `resumeTurn`.
- **Diagnostica in cronologia sessione come messaggio assistant**: respinto
  (decisione owner) — verità di esecuzione, non conversazionale: persiste
  strutturata sulla riga e si consegna, non entra in memoria come detto da
  Muffin.

## Cosa può smentire la scelta

- Upstream che falliscono in modi non coperti dalla tassonomia (nuove
  `finish_reason` con contenuto parziale): la classe va estesa, mai
  collassata su `empty`.
- `continuable` che si accumulano senza che nessuno li continui: serve un
  TTL di sweep o una superficie che li proponga (oggi: resolver TTL 24h +
  `doctor`).
- Modelli che con lease fresche rispondono dove la prima falliva
  sistematicamente: rivalutare `recovery_exhausted` come terminale.
- Heuristica `isContinuationAsk` con falsi positivi/negativi misurati su
  traffico reale: restringere/allargare la allowlist, mai un classificatore.

## Complementi (non in questa slice)

Sweep/TTL attivo delle righe continuable; proposta proattiva; `muffin
resume` via gateway (oggi solo locale); comando `/resume` Telegram (mai uno
slash command globale per keyword); livello Work/Goal esplicito.
