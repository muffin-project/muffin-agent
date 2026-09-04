# ADR-0067 — `muffin undo` marca la cronologia e la memoria, non le riscrive

**Stato:** accettato · 2026-09-04

## Contesto

D11 (`docs/work/day1/requirements-status.md`) chiede un undo che rimetta «il
filesystem **e** il turno». Solo la prima metà esisteva: `cmdUndo` chiama
`UndoJournal.restore`, che tocca solo il disco. Il record del turno
(`turn_tool_calls.content`) e la memoria (`episodes` con `role: 'agent'`)
restavano intatti, quindi un giro successivo che rileggeva la propria storia
trovava ancora «Fatto: ho scritto nota.md» come se fosse vero adesso.

Il lavoro esisteva già, su `slice/undo-riallinea-il-turno` /
`park/undo-semantico`, da fine agosto. PR #186 (che lo portava) è stata
**chiusa senza merge il 30/08/2026 come SALVAGE**, non come rifiuto nel
merito: 141 commit indietro rispetto a `dev`, cinque conflitti — due dei quali
proprio nei file che ADR-0044 e le slice di agosto avevano riscritto. La
misura che ha reso quel lavoro irraggiungibile era specifica: sul `muffin.db`
dell'owner, `fs.write` non era mai stata eseguita (0 chiamate su 165 turni),
perché 110 turni su 165 erano a taint 2 e `fs.write` aveva un soffitto di
classe 1 — la capability con il journal era negata, e la shell senza journal
no. **ADR-0053** ha reso la matrice normativa eseguibile e sbloccato quel
percorso (a taint 2 la riga dice `ASK`, non più `DENY` secco), quindi la
dipendenza che teneva D11 fuori scope è caduta e la metà mancante si
reimplementa su HEAD invece di essere rebasata.

Il codice originale (`88f9bae`, `c8a4e3d`, `d7d1502`, `983dac0`, `81c8673`) è
stato letto per intero come miniera — non riapplicato — perché nel frattempo
sono entrate ~50 PR: `episodes.turn_id` è già su `dev` da #253 (la metà
lineage di D11), la redazione dei segreti, il recinto di provenienza, ADR-0053
(le righe di effetto), e la casa non è più uno spazio di lavoro (ADR-0059).

## Decisione

**Marcare, non riscrivere e non escludere.** `turn_tool_calls` guadagna una
colonna additiva `undone_at` (stesso pattern di `episodes.superseded_at` e
`facts.expired_at`); `episodes` guadagna `undone_at` accanto a `turn_id`,
distinta da `superseded_at` perché porta un significato diverso — superseded
dice "non è più l'ultima parola", undone dice "l'effetto che descrive non è
più sul disco". `content` non cambia mai: la riga resta ciò che l'agente ha
detto davvero, solo la lettura "questo è ancora vero adesso" si spegne.

La marcatura succede **alla lettura**, non alla scrittura: `agent/loop.ts`
risolve — una query per l'intera finestra reiniettata, stessa forma di
`taintForIds`/`historyTaint` — quali `traceId` della sessione hanno un
`undone_at`, e annota il testo del messaggio `assistant` corrispondente
quando lo riassembla in `buildContext`. Il file di sessione (JSONL,
append-only) non viene mai toccato: la riga scritta resta la riga scritta,
per sempre, e la storia — "cosa ha detto il modello quel giorno" — resta
ricostruibile byte per byte.

Per la memoria, `MemoryStore.markEpisodesUndone(tenantId, turnId, at)` marca
ogni episodio `role: 'agent'` di quel turno non ancora marcato. Solo `agent`:
marcare la richiesta dell'owner come "disfatta" sarebbe una bugia nella
direzione opposta. `recall()` porta `undone` sull'item (accanto a `role`,
anch'esso aggiunto qui) attraverso lo stesso helper cache-per-episodio che già
risolveva `role` per la provenienza, e `renderForPrompt`/`temporalLabel`
stampano la marca sulla stessa riga di `expired`, mai in un buco silenzioso.

`cli/undo.ts` è la cucitura: marca **dopo** il restore, mai prima — segnare
per primo direbbe "annullato" di un effetto ancora sul disco — e **solo su un
restore completo** (`esito.problems.length === 0`). Una marcatura totale su
un disfacimento parziale sarebbe la stessa bugia che questa ADR ripara, solo
spostata di un livello. Un fallimento della marcatura stessa (database
assente, disco pieno) non fa fallire il comando — il filesystem è già tornato
com'era — ma è dichiarato su stderr, mai inghiottito.

## Cosa resta fuori, dichiarato invece di taciuto

- **Granularità per-`callId` (B3 del judge di #186).** Un turno che scrive
  due file e ne disfa uno solo (restore parziale) oggi non marca **niente**,
  invece di marcare solo il file tornato indietro. È la scelta più
  conservativa delle due bugie possibili — mai dichiarare disfatto ciò che non
  lo è — ma non è la granularità piena che il codice originale aveva. Riga
  aperta, non regressione: prima di questa ADR nessuna marcatura esisteva.
- **Redo (`muffin undo annulla-<turno> --yes`).** Non azzera l'`undone_at`
  del turno originale. Un redo riporta il file sul disco ma la cronologia
  continua a mostrare l'annotazione "disfatto" sul turno che lo aveva scritto
  la prima volta — asimmetrico, non una bugia nuova (il testo resta quello
  vero, solo l'annotazione diventa obsoleta), ma non la simmetria che
  `d7d1502` aveva costruito (`markRedone`/`dietroLaRete`). Riga aperta.
- **Riconciliazione di un turno sospeso a metà.** Un turno che riprende da
  `recordedOutcomes` non controlla se una sua chiamata precedente è stata nel
  frattempo disfatta da un `muffin undo` concorrente. La finestra è stretta —
  l'undo agisce tipicamente su turni già conclusi — e non è coperta qui.

Le tre righe sono nominate perché la regola del repo è che un declassamento è
una tesi, non un'omissione: chi riprende questo lavoro parte da qui invece di
riscoprirle a mano.

## Prova

`agent/runtime-wiring.test.ts` — due scenari end-to-end sul runtime vero (non
sui componenti isolati): `fs_write` reale tramite `draft`/journal, `muffin
undo` reale tramite `cmdUndo`, poi un secondo turno nella stessa sessione che
rilegge la propria storia (metà turno/sessione) e una query diretta di
`MemoryStore.searchEpisodes` (metà memoria). Entrambi verificati rosso-prima
per mutazione manuale (marcatura disattivata → asserzione fallisce),
ripristinati da una copia con nome distinto, verde dopo.
