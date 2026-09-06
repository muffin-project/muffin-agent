# ADR-0074 — Si chiede solo per l'irreversibile, ovunque

**Stato:** proposto · 2026-09-06 · decisione owner (*«si chiede solo
irreversibile, SEMPRE, anche in privato»*) sulla ricerca
`docs/evidence/harness-non-permessi-2026-09-06.md`

## Contesto

Oggi un `ask` nasce da quattro punti del kernel (`core/policy/decide.ts`):

1. una capability `risk: 'high'` chiede sempre, salvo `hardened` **e** owner
   **e** taint 0 (`sys.shell`, `sys.process.kill`);
2. un taint sopra `askAbove` della riga d'effetto trasforma in `ask` anche una
   scrittura con undo (`host` chiede da taint 2: dopo aver letto una pagina
   web, `fs.write` chiede);
3. parametri di egress composti dal modello, owner → `ask` (ADR-0071);
4. un principal `system`/`agent` su rischio alto → `ask` in coda.

Misurato dal vivo (SECURITY §13, handoff): **tutte** le 35 approvazioni mai
chieste erano `sys.shell` a taint 2, 32 sì e 3 no — un cancello concesso nove
volte su dieci è un riflesso, non una decisione. E nella character eval 5 dei
6 fail `agentic` del modello principale nascono da un turno fermo su un
`ask` che nessuno può dare (baseline 04/09, `tool-use-2026-09-06.md`).

Le fonti primarie (OpenAI *Governing Agentic AI Systems* §4.2 e §4.4,
Willison, CaMeL, Progent, i permission mode di Claude Code e Codex CLI)
dicono la stessa cosa: la conferma umana è per ciò che è **irreversibile**,
per ciò che **esce** da un confine controllato, per ciò che **allarga** un
privilegio. Dentro un confine reversibile il lavoro dell'harness è rendere il
danno disfabile, non interrogare. Il taint resta la misura di *chi* ha
influenzato il turno; non è una ragione per chiedere una cosa che si può
annullare.

## Decisione (proposta)

**1. `ask` ⇔ irreversibile. Il taint non chiede mai.** Il kernel chiede
conferma se e solo se la capability dichiara `reversible: 'no'` **e** la sua
riga d'effetto è una in cui l'irreversibilità conta: `host`, `external`,
`outward` (la riga acquista `asksForIrreversible: boolean`; `reply`,
`memory`, `context` sono `false`: la risposta è la conversazione stessa, un
episodio si cancella). `askAbove` sparisce dalle righe: il taint continua a
**negare** sopra `denyAbove` (ADR-0044, il soffitto non si muove) e a
timbrare gli episodi, ma non trasforma più `allow`/`draft` in `ask`. Una
scrittura `undoable` (`fs.write`, `vault.write`, `turn.todo`) resta `draft`
con giornale e undo a qualunque taint sotto il soffitto.

**2. Anche in privato, anche `hardened`.** La scorciatoia
`hardened && owner && taint === 0 → allow` per il rischio alto sparisce:
un'azione irreversibile chiede sempre, anche all'owner nella sua chat, anche
a taint 0. L'`ask` dice **cosa non si può annullare** («cancella 3 file fuori
dal giornale», «manda un messaggio a …», «termina il processo 4312»), non
«serve la tua approvazione per sys.shell». Il taint compare nel prompt come
contesto («questo turno ha letto una pagina web»), non come causa.

**3. Il cancello di egress resta, perché i byte che escono non tornano.**
ADR-0071 non cambia: parametri composti dal modello → `ask` per l'owner,
`deny` per chiunque altro; una ricerca non chiede mai (ADR-0072); l'allowlist
di egress resta. Un principal `system`/`agent` su un'azione irreversibile
resta `ask` in coda.

**4. La shell diventa reversibile per costruzione, e solo allora non chiede.**
`sys.shell` si divide in due capability con lo stesso tool: `sys.shell`
(sola lettura: sandbox con `writeScope` = solo lo scratch di sessione e
**rete spenta**; `reversible: 'yes'`, non chiede mai) e `sys.shell.write`
(scrive nel workspace o parla in rete; `reversible: 'no'`, chiede sempre).
Il modello dichiara quale delle due gli serve; l'harness la fa rispettare
(bwrap su Linux, seatbelt su macOS). Dove il sandbox non può garantire il
confine (`probeSandbox` fallisce), la shell in sola lettura **non esiste**:
non degrada in silenzio a `sys.shell.write`, il tool dice che quel comando
va fatto a mano o con un tool dedicato. Linux prima, macOS poi. `lsof`,
`sqlite3 -readonly`, `env`, `ls` (D13) passano di qui senza chiedere.

**5. MCP prende la reversibilità dalle annotazioni del protocollo.** Un tool
MCP con `readOnlyHint: true` è `reversible: 'yes'`; con `destructiveHint`
o senza annotazioni è `'no'` e chiede (riga `external`). Oggi tutto MCP è
`'no'` a mano.

## Conseguenze

- `core/policy/matrix.ts`: `RowPolicy` perde `askAbove`, acquista
  `asksForIrreversible`; `POLICY_FLOOR` e lo schema del file sigillato
  seguono (un `policy.json` che porta ancora `askAbove` viene rifiutato con
  il nome del campo, non ignorato). `decide.ts` perde la scorciatoia
  `hardened` e il ramo «chiede sempre finché il blocco non è reale».
- Ogni `ask` cita l'effetto irreversibile; `agent/loop/tool-call.ts` lo
  deriva dagli argomenti come già fa per D12.
- SECURITY §5 e §13 si riscrivono: il taint ambientale resta un'ipotesi da
  misurare, ma non è più la ragione di un `ask`.
- D13 si rimisura **dopo** il punto 4: l'eval headless non ha più bisogno di
  un approvatore finto per le probe in sola lettura.

## Cosa la falsifica

- **Punto 1:** un turno che chiede conferma per un'azione con undo, o che
  non la chiede per una `reversible: 'no'` su `host`/`external`/`outward` —
  prova: `core/policy/decide.test.ts` enumera ogni capability dichiarata e
  asserisce l'esito a ogni taint 0-3; una mutazione che rimette `askAbove`
  in una riga la fa cadere.
- **Punto 2:** su un'installazione `hardened`, l'owner a taint 0 esegue
  `sys.process.kill` senza un `ask` — allora la scorciatoia è tornata.
- **Punto 4:** un comando in `sys.shell` (sola lettura) scrive fuori dallo
  scratch o apre un socket — prova nel container di ci:local (`bwrap`):
  `touch $WORKSPACE/x` e `curl` devono fallire dentro `sys.shell` e riuscire
  solo in `sys.shell.write` dopo l'`ask`. Una mutazione che toglie
  `--unshare-net` la fa cadere.
- **Il registro degli ask dal vivo:** dopo il rilascio, ogni `ask` nel
  `muffin.db` dell'owner cita un effetto irreversibile; un solo `ask` per
  `ls`, `lsof` o una scrittura con undo riapre l'ADR. E l'eval `agentic`:
  zero probe ferme su un `ask` per un'azione di sola lettura.
