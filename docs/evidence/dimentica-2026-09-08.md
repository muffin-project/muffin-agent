# «Dimentica X» — challenge pass prima del codice, 2026-09-08

> Evidence datata (`docs/RESEARCH.md` §2E). Non è authority: ADR-0051 possiede
> il principio, il codice la meccanica.

## Il fallimento misurato

Sull'installazione reale (build 4521f83), «dimentica del tutto X» detto
dall'owner non ritira nulla: non esiste né tool né comando. In headless il
modello ha consegnato una ricetta `rm` + `DELETE FROM chunks`; in REPL viva ha
letto database e codice del repository per improvvisare, interrotto dopo ~6
minuti (`cutover-2026-09-08.md`). La sessione successiva risponde ancora il
valore. Frase falsificabile: *dopo «dimentica X» in una sessione, una sessione
nuova non risponde più X a «qual è X?», e `--history` mostra X come ritirato.*

## Il meccanismo corrente e l'invariante

- ADR-0051: molti produttori, **un writer semantico** (`core/memory/ingest.ts`
  sotto `IngestLock`); il producer non possiede il commit canonico.
- «Correggi» esiste già: il giudice del consolidatore emette `supersede` e
  `store.supersede()` chiude il fatto vecchio (`expired_at`, `superseded_by`,
  `valid_to`). Misurato oggi in REPL viva: fatto 149 → 151, il recall segue.
- D11: `episodes.superseded_at` esclude l'episodio da FTS, vettori e vault
  (`store.ts` 826/888/1008, `vectors.ts` 65) senza cancellarlo: l'evidence resta,
  il recall normale non la usa. È esattamente la semantica «ritiro, non
  cancellazione» che #481 chiede per forget.
- La capability `memory.write` è già dichiarata (`core/policy/doors.ts`),
  effetto `memory`, scope `tenant`.

## Le alternative

| | candidato | evidence | contro / guasti noti |
|---|---|---|---|
| A | **tool `memory_forget`**: senza id restituisce i candidati (fatti attivi ed episodi non superati trovati dal recall esistente); con gli id ritira attraverso `ingest.retireBeliefs` sotto il lock del writer: `facts.expired_at` + `retired_reason` (turno della richiesta), `episodes.superseded_at` (D11). Conferma solo dal risultato durevole. | riusa supersede/D11/lock; LangMem `manage_memory` cancella solo per `id` esatto — la selezione per query è il modo noto di cancellare la cosa sbagliata; Mem0 `expiration_date` nasconde da `search` ma la memoria resta leggibile per id (ritiro, non cancellazione) e tiene una history | il modello sceglie gli id (probabilistico) — stesso grado di libertà del giudice `supersede`; il ritiro non tocca la nota del vault che il modello ha scritto con `vault_save` finché non è fra gli episodi scelti (le note del vault *sono* episodi con `vault_path`, quindi entrano nei candidati) |
| B | proposta durevole + consolidatore asincrono: il tool scrive una riga `MemoryProposal{retire}`, il consolidatore la applica al giro dopo | forma letterale di ADR-0051 | il debounce muore con la REPL headless (misurato: 9 episodi in arretrato); la sessione dopo risponde ancora X; per essere onesti servirebbe che il recall nasconda i fatti «in attesa di ritiro» = una seconda semantica; conferma all'owner non possibile nel turno |
| C | non costruire: dichiarare forget OUT per i 14 giorni | zero codice | contraddice VISION (07/09) e la direzione owner di oggi (#481 §9, «forget resta un blocker reale e va costruito») |
| D | cancellazione fisica (DELETE di fatti/episodi/chunk) | è ciò che il modello ha improvvisato | perde provenienza e `--history`; contro ADR-0051 e #481 («NON cancellazione dell'Evidence/history») |

**Scelta: A.** Il writer resta uno (la funzione vive in `ingest.ts` e prende
l'`IngestLock`); il tool è un producer che chiede il ritiro di id espliciti, non
una scorciatoia con regole proprie. B è più «pura» ma falsa la proprietà che
conta (la sessione dopo) proprio nel caso misurato.

## Conseguenze

- Sicurezza: scope per tenant come `memory.write`; nessun byte dell'esterno
  entra nei fatti (il tool scrive solo `expired_at`/`superseded_at`/una ragione
  costruita dal runtime). Un messaggio a taint alto che «chiede di dimenticare»
  passa dalla policy di `memory.write` come oggi il `supersede` del giudice.
- Durabilità: una transazione SQLite per chiamata; il ritiro è visibile dopo
  il commit e sopravvive al processo.
- Privacy: nulla lascia la macchina.
- Tetto tool: 20→21 sull'installazione dell'owner (+1 contato, come per D15).

## Cosa falsifica la scelta

Ripetere sull'installazione reale, in REPL viva, forget → nuova sessione →
recall: se la risposta è ancora X, o se il turno di forget supera un minuto o
chiede un ASK, la slice non chiude il fallimento. Test di unità: rimuovere la
scrittura in `retireBeliefs` deve far cadere il test che asserisce
`activeFacts`/`searchEpisodes` vuoti dopo il ritiro.
