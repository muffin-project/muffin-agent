# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. **Il gate sono i check di
GitHub**, sulla *condizione*, mai su una stampa; `gate:local` è il ripiego.

## Le decisioni dell'owner

**Instradamento: deciso** — `routing.only: ["alibaba"]`, `dataCollection:
"deny"`. Aperte da prima: **`muffin rot harden`** (serve `sudo`; finché non è
fatto `sys.shell` chiede *sempre* conferma) e la **chiave Tavily**. **C8 note
vocali: il meccanismo è su `dev` e la macchina è pronta** (whisper.cpp, ffmpeg e
`ggml-base.bin` installati il 02/09; `doctor` ha la riga `note vocali`, verde
sull'installazione; una frase sintetizzata con `say` è tornata testo corretto).

## Il bivio n. 1 è chiuso: ADR-0053

Non scegliendo un soffitto. La matrice normativa del threat model è una tabella
per **riga di effetto**, dà a `fs.write` la riga che a taint 2 dice `ASK`, e il
kernel non la eseguiva: decideva da classe di rischio più un numero appuntato a
mano, e l'emendamento del 16/08 aveva spostato quella cella per `sys.shell`
sola. Ora il soffitto viene dalla riga, `core/policy/effect-rows.test.ts`
asserisce ogni cella, e tre celle cambiano: `fs.write` e `sys.process.kill`
passano da `deny` ad `ask` a taint 2, `surface.send_file` va nella riga *reply*.
Memo: `docs/evidence/decision-memo-taint-2026-09-02.md`.

Resta aperto il resto della domanda — se il taint **ambientale** sia il segnale
giusto (`SECURITY.md` §13). Si chiude con l'eval comparativo: adapter B e
corpus avversariale in `evals/security/`. Righe e colonne sono domande diverse.

## Bivio owner n. 2: un tool `jobs` per il modello

Oggi i job nascono solo da `muffin jobs add`; «scrivimi tra 5 minuti» passa da
`turn.wait` (funziona su Telegram, provato il 29/08). Un job creato da un turno
tainted è un'iniezione differita: serve una forma prima di costruirlo. Non DAY-1.

**Azioni owner senza codice:** chiave Tavily + `rot/egress.json` (oggi Muffin
non ha nessun accesso web: 0 `web_search`, 0 `http_get` in 165 turni) ·
`muffin rot harden` · togliere `discord` da `surfaces.enabled` finché flappa.

## Il 02/09

Quindici PR su `dev` (#277–#295). Inventario **36 READY · 14 BLOCKER · 6
OUT**, da rifare dopo ADR-0053. `dev → main` (#289, `dd38d40`) e `muffin update`
eseguiti: build `dd38d40`, `doctor` senza `fail`.

**Ledger di studio:** `docs/evidence/design-study-ledger-2026-09-02.md`,
evidence datata, non authority — si legge quando il dominio entra nel lavoro.

**Parcheggiato:** `docs/evidence/richieste-differite-2026-08-30.md` — misure
(7 todo fermi fuori sessione, 44 fatti `asked_to` su 83), non una forma.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il modello
impara per rifiuto. Codex rende `<permission_profile>`, OpenClaw
`## Authorized Senders`.

**Harness:** il finto Bot API (`evals/acceptance/telegram.ts`) non serve
`getFile`: B10 (immagini) e C8 (nota vocale) restano senza scenario per questo,
non per il prodotto. Le run di accettazione durano ora ~5 minuti: il tetto del
job è 10.

**Altro:** `gateway.err` non data le righe (19 ore di errore, una volta);
`pricing.ts` sottostima 5 famiglie su 8; il `try` di `recall.ts` avvolge anche
la provenienza, così un guasto dello store sembra rete.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato dei
requisiti DAY-1,
critical-path.md#ordine-corrente l'ordine.
