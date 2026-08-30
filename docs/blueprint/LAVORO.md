# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Pilotando il REPL in **tmux**, o misurando su
tracce, log e il `muffin.db` vero — mai con `cp` dei suoi tre file, che dà una
vista vecchia senza errore: `sqlite3 <db> ".backup <dest>"`.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository, `npm
ci`, typecheck, build, suite, accettazione, e `gate-linux.sh` in Docker. Il
verde si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». La CI di GitHub
è rossa per **fatturazione** — i job muoiono in 2s senza eseguire niente.

## Due PR, verdi, che aspettano un merge tuo

Impilate: **#260 va mergiata per prima** (#261 usa `causaDiRete`, che esiste
solo lì). **Non cancellare `slice/causa-di-rete` al merge**, o #261 si chiude a
cascata.

- **#260** `LOCAL-GATE PASS @ a2d3572` — il log di Telegram dice la *causa*
  (`cause.code`, mai `.message`: l'URL porta il token), e `doctor` guarda la
  **superficie** invece del processo. Tre giri di judge, il terzo chiuso
  dall'orchestratore per la regola anti-cerimonia.
- **#261** `LOCAL-GATE PASS @ 1cbca48` — la stessa cosa per l'embedder:
  `embed.ts` buttava `cause.code` e consegnava la parola `fetch failed`.

`integrazione/tre-slice` (note vocali/whisper, 68 commit indietro) è spinta su
origin come checkpoint: non è una PR, non è morta.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Restano aperte: **`muffin rot harden`** (serve `sudo`; finché non è
fatto `sys.shell` chiede *sempre* conferma) e **C8, note vocali** (se la tua
voce esce di casa). Mancano **chiave Tavily** e **billing CI**.

Il binario installato è `3ae9595` del 28/08: dietro a tutto il 30/08.
`dev` è avanti a `main`; la promozione è una PR che mergi tu.

## Parcheggiato: come arriva una richiesta che non si fa adesso

`docs/blueprint/research/richieste-differite-2026-08-30.md` — misure, non una
forma. In breve: **`jobs` non ha un tool**, per nessuno e a nessun taint (solo
`muffin jobs add`), e il modello interrogato ha spiegato l'assenza come una
policy di taint che non esiste. `wait` è stato chiamato **1** volta, `todo` 2, i
7 todo sono fermi dal 27/08 e sono invisibili fuori dalla loro sessione. **44
fatti attivi su 83** sono `asked_to`/`asks_to`: «dimmi solo: tre» sta nello
stesso mucchio delle due richieste davvero pendenti. ANANAS non si recupera
perché nessuna somiglianza trova un'istruzione che il messaggio dopo non nomina.

Il tetto dei tool **non** è più il problema: `0d519cb` l'ha portato a 15 e
`doctor` non stampa più niente. Quel reperto è morto — non ripartire da lì.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel
rifiuta alla chiamata e il modello impara per rifiuto — incluso il tetto di
taint. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.

**Altro:** community è solo una forma di stringa; `pricing.ts` sottostima 5
famiglie su 8; socket v2; `recall.ts:624` avvolge anche la lettura della
provenienza.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
`STATE.md` è cronologia, non stato corrente.
