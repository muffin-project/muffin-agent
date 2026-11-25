# ADR-0112 — L'identità a strati: kernel, fondazione, user.md, memoria

**Stato: architettura approvata dall'owner il 2026-11-25 (Europe/Rome).** Il
testo della fondazione è un cambio di default da recensire nella PR che
introduce questo ADR. Profilo di verifica **CRITICAL**
(`docs/development/ORCHESTRATION.md`: identità, Root of Trust, memoria).
Non dà all'agente nessun nuovo write-path: né su `rot/`, né su `defaults/`,
né su `user.md`.

Numero: **0112** era il prossimo libero su `dev` al momento della stesura
(`node docs/decisions/prossimo-numero.mjs`).

## Contesto

Fino a questo ADR `muffin init` copiava `defaults/rot/identity.md` in
`~/.muffin/rot/identity.md` una volta sola, e il runtime leggeva **solo**
quella copia. La copia in home *sostituiva* il default spedito: chi aveva
già un file non riceveva più nessun aggiornamento del carattere, e non
c'era un posto per le preferenze dell'owner che non fosse riscrivere il
patto di prodotto. Le preferenze dette in chat («d'ora in poi usa sempre
liste puntate») finivano come fatti `asked_*` di un turno chiuso (ADR-0068)
e non arrivavano ai turni dopo.

L'owner ha chiesto di separare la parte uguale per tutti (il carattere di
compagno: aiutare a pensare e a capirsi, collaborare invece di dare solo
ragione, lavorare in background, più messaggi brevi) dalla
personalizzazione che vale solo per lui.

## Ricerca (25 novembre 2026)

Fonti primarie, consultate prima della decisione:

- OpenAI Model Spec, catena di comando e personalizzazione che non scavalca
  i principi sopra il livello *guideline*:
  <https://model-spec.openai.com/2026-10-29.html>
- ChatGPT: custom instructions distinte dalla Memory
  (<https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions>,
  <https://help.openai.com/en/articles/8590148-memory-in-chatgpt>); la
  personality non cambia le regole di safety
  (<https://help.openai.com/en/articles/11899719-customizing-your-chatgpt-personality>).
- Claude Code: i file di istruzioni si concatenano dal più ampio al più
  specifico, e la policy gestita non si esclude
  (<https://code.claude.com/docs/en/claude-md>); Claude Memory, temi
  sensibili spenti di default
  (<https://claude.com/resources/articles/claudes-memory-works-everywhere-and-you-decide-whats-in-it>).
- Cursor Rules, precedenza Team > Project > User
  (<https://cursor.com/help/customization/rules>).
- Letta, blocchi `persona` e `human` distinti, blocchi read-only per le
  policy (<https://docs.letta.com/v1-sdk/memory/memory-blocks>).
- Hermes, `SOUL.md` / `USER.md` / `MEMORY.md` che non si alimentano a
  vicenda (<https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what>).
- OpenClaw, `USER.md` con un tetto suo di ~4000 caratteri, omesso intero se
  sfora (<https://docs.openclaw.ai/concepts/user-model>,
  <https://docs.openclaw.ai/agent-workspace>).
- Anthropic, tag XML per delimitare il contenuto fornito nel prompt
  (<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags>).

Il pattern comune: chi è l'agente, chi è l'umano e cosa si è imparato
stanno in tre contenitori diversi; la safety vince per autorità, lo stile
per specificità; detto e dedotto restano distinti.

## Decisione

Quattro strati, in quest'ordine di autorità:

1. **Kernel di policy — codice.** `WORK_RULES` / `WORK_RULES_V2`, matrice di
   policy, `rot.*` `neverAtRuntime`. Nessun file personale, nessuna memoria
   e nessun messaggio lo scavalca.
2. **Fondazione — `defaults/rot/identity.md`, letta dal prodotto a
   runtime** (`agent/context/identity.ts`, `SHIPPED_IDENTITY`, risolto
   accanto al modulo sia nel repository sia in `dist/`). Uguale per tutti,
   senza dati personali. Un `muffin update` la cambia per ogni casa che non
   l'ha sostituita. Read-only per l'agente.
3. **`~/.muffin/user.md` — opzionale, dell'owner, fuori da `rot/`.** Va solo
   alla classe owner, dopo la fondazione, con un tetto suo
   (`USER_OVERLAY_TOKEN_BUDGET`, 1000 token stimati ≈ 4000 caratteri). Sopra
   il tetto si omette **intero** e il blocco lo dice: un taglio perderebbe
   in silenzio la direttiva oltre il limite. Il blocco apre con
   un'etichetta: sono preferenze dell'owner, specializzano stile e modo,
   non scavalcano regole di lavoro, sicurezza e onestà; un conflitto si
   segnala; un'inferenza non scavalca queste righe. Il testo dell'owner sta
   dentro `<preferenze-owner>`. Nessun comando lo scrive: né init, né
   update, adopt o migrate.
4. **Preferenze imparate — memoria del tenant, non un file.**
   `memory_propose` accetta `standing: true`. La preferenza si **appunta**
   (nucleo appuntato, che entra in ogni turno owner) solo se è
   *owner-stated*: le parole dell'owner verificate byte per byte
   nell'ingresso autenticato (#776) e il turno a tier 0, lo stesso gate di
   `addFact`. Una preferenza dedotta diventa al massimo una credenza non
   appuntata e la risposta del tool dice al modello di chiedere. La
   conferma è l'owner che la dice con parole sue, anche dopo una domanda
   («sì, d'ora in poi usa sempre liste puntate»): in quel caso si appunta
   la credenza già esistente, solo se anche quella è `said` e a tier 0. Si
   toglie con `memory_forget` o `muffin memory unpin`. Nessuno store
   parallelo.

### Transizione (coerente con ADR-0108)

`resolveIdentityLayers` decide, senza scrivere nulla:

- **`user.md` presente** → fondazione dal prodotto + `user.md`. La copia
  `~/.muffin/rot/identity.md`, se c'è, non entra come terzo patto.
- **Nessun `user.md`, copia in home assente o non toccata** (stesso hash
  registrato da `init` in `defaults-manifest.json`, o byte identici al file
  spedito) → fondazione dal prodotto. Non c'è niente dell'owner da perdere.
- **Nessun `user.md`, copia in home modificata a mano** → resta il patto,
  come prima. Sommare i due testi raddoppierebbe il patto; passare da solo
  alla fondazione cambierebbe un carattere senza consenso.
- **Build senza fondazione spedita** → la copia in home, dichiarato da
  `muffin doctor`.

Il cut-over è un gesto dell'owner: creare `~/.muffin/user.md` con le sole
righe davvero sue. `muffin doctor` (riga `identità`) lo propone quando la
copia in home è modificata, senza safe mode, senza reseal e senza `cp`;
`muffin rot migrate` stampa lo stato e non riscrive niente. `init` continua
a seminare `rot/identity.md` se manca, così un rollback a una build
precedente trova ancora un patto. `rot/identity.md` esce dal confronto
«default derivati» del doctor: non è più la fonte della fondazione.

## Divergenze volute

- **Un pavimento di carattere spedito**, invece dello stile lasciato
  aperto dal Model Spec: è una scelta di prodotto (un compagno, non un
  esecutore).
- **La fondazione si rilegge dal prodotto**, invece del modello
  Hermes/OpenClaw «il file in home sostituisce il default e non si tocca
  più», che era il buco di Muffin.
- **Nessun auto-pin di regole dedotte**, a differenza di Claude Memory:
  ADR-0068 (poisoning) e il fatto che Muffin ha strumenti, non solo chat.
- **Nomi `identity.md` + `user.md`**, non `SOUL.md` + `USER.md`: stesso
  split, vocabolario già Muffin (`user.md` compare in ADR-0011 e ADR-0020).
- **`user.md` dopo `voice.md`** legacy, non prima come nella bozza: il più
  specifico arriva per ultimo, come nella concatenazione di Claude Code.

## Conseguenze

- Il prompt owner di una casa nuova cambia (nuovo testo di fondazione): il
  pin sha256 in `agent/context/assemble.test.ts` è ri-fissato, ogni
  prefisso caldo va a freddo una volta.
- La fondazione è stata riscritta con i tratti di compagno e conserva i
  pavimenti già spediti e già misurati: dichiararsi IA, non fingere memoria
  o lavoro, detto contro dedotto, niente manipolazione o coaching, il
  registro casuale («hey» non apre un ticket).
- Un'installazione con una copia in home modificata a mano non cambia
  finché l'owner non crea `user.md`.
- Resta aperto un tool dedicato e approvato per scrivere `user.md` dalla
  chat: fuori da questo ADR.
