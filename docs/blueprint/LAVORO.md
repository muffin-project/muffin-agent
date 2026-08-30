# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Non leggendo il codice: pilotando il REPL in **tmux**
(`capture-pane` rende lo schermo; `script` registra i byte e fa concludere il
falso), o misurando su tracce, WAL e sul `muffin.db` vero — da lì sono nate tutte
le slice del 30/08.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository, `npm
ci`, typecheck, build, suite host, accettazione host, e `gate-linux.sh` in
Docker. Il verde si scrive `LOCAL-GATE PASS @ <sha>`, **mai** «CI verde». Il
clone serve perché la suite lanciata a mano raccoglieva 945 file dove il
repository ne ha 201: `.releases/` e `.codex/worktrees/` sono invisibili a
`git status` e non a vitest.

## Le tre decisioni aperte, tutte dell'owner

1. **Instradamento** (`config.provider.routing`). Oggi 0% di cache: OpenRouter
   manda al più economico dei 12 provider, che non onora i breakpoint. Con
   `only: ["alibaba"]` la cache prende il 95% dal secondo turno e costa **meno**
   (~$0.0009 contro ~$0.0031 a turno). Ma è cinese, e `dataCollection: "deny"`
   non l'ha mai deciso nessuno: `identity.md` e i ricordi vanno a chi costa meno,
   senza vincoli su chi se li tiene.
2. **`muffin rot harden`** — serve `sudo`, e da lì i reseal servono `sudo`.
   Finché non è fatto, `sys.shell` chiede **sempre** conferma.
3. **C8, note vocali**: whisper.cpp locale o un'API — decide se la tua voce esce
   di casa.

## Cosa manca per usarlo davvero

`surfaces.enabled = ["cli"]`, un solo segreto. Servono, dall'owner: **token bot
Telegram** (senza, niente telefono), **chiave Tavily** (senza, `web_search` non
si registra), **billing CI**.

## Nessuna PR aperta

#186 è chiusa con l'evidenza: la metà lineage è rientrata con #253, e l'altra —
l'undo che riallinea la cronologia — descrive un percorso mai raggiunto.
Misurato: **`fs.write` ha 0 chiamate** in tutto il corpus e `~/.muffin/undo/` non
esiste. Torna in gioco quando una scrittura verrà usata davvero; il ramo resta.

## Cosa aspetta te, adesso

1. **Ollama è giù.** `doctor` lo dice: l'embedder non risponde, quindi il recall
   è **solo testuale** e **120 sorgenti** non hanno un vettore. `ollama serve`,
   poi `muffin memory extract` per drenare l'arretrato.
2. **Il binario installato è vecchio**: `muffin 0.0.0 (3ae9595, 28/08)`, cioè
   `main` prima di tutto il lavoro del 30/08. Niente di quanto integrato ti sta
   girando.
3. **`dev` è 45 commit avanti a `main`** e la promozione è una PR che mergi tu —
   senza crediti CI, l'unica prova è il gate locale, che è verde su ogni merge.

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel rifiuta
alla chiamata e il modello impara per rifiuto — incluso il tetto di taint, per
cui «leggi, calcola, scrivi» è rifiutato *sempre* senza che nessuno gli dica
perché. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`. Va
nella coda volatile: il taint cambia dentro il turno.

**Memory health:** gran parte esiste già — `doctor` nomina l'embedder giù, la
conseguenza e il rimedio; da #257 `memory stats` non può dirsi in pari sopra un
arretrato. Resta il **person model**: 3 entità, e 42 dei 79 fatti attivi sono
eventi-richiesta (`asked_to`, `asks_to`).

**Altro:** community è solo una forma di stringa, promessa nel tipo e non
capability; `pricing.ts` sottostima 5 famiglie su 8; socket v2.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
`STATE.md` è cronologia, non stato corrente.
