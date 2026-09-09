# Harness, non permessi — perché troppe conferme per un salvataggio in gruppo

Ricerca su richiesta owner (05-06/09/2026), sola lettura. Domanda: «un agente
non ha così tanti limiti: piuttosto ha un harness che gli evita di fare
casini» — applicata a ADR-0073 (`vault.write` per stanza, approvatore owner
effimero).

## §1 Fonti primarie

- **CaMeL** (Debenedetti et al., Google DeepMind), *Defeating Prompt
  Injections by Design*, arXiv:2503.18813 — un LLM privilegiato pianifica, un
  LLM in quarantena legge dati non fidati senza tool, un interprete
  deterministico applica policy di capability/provenienza **prima** di ogni
  chiamata: sostituisce la conferma con un controllo statico sul flusso dati,
  non con più domande. Marzo 2025 (v2 24/06/2025).
  https://arxiv.org/pdf/2503.18813
- **Progent** (Shi et al.), *Programmable Privilege Control for LLM Agents*,
  arXiv:2504.11703 — DSL di least-privilege sui tool call; un update di
  policy è **narrowing** (si applica da solo) o **expansion** (serve
  approvazione esplicita, validata da un SMT solver): l'azione può solo
  restringersi senza chiedere, mai allargarsi in silenzio. Aprile 2025.
  https://arxiv.org/abs/2504.11703
- **AgentDojo** (Debenedetti et al.), *A Dynamic Environment to Evaluate
  Prompt Injection Attacks and Defenses*, arXiv:2406.13352, NeurIPS 2024 —
  banco di prova (97 task, 629 casi) usato da CaMeL e Progent per misurare
  utilità/sicurezza; non è un meccanismo, è il righello. Giugno 2024.
  https://arxiv.org/abs/2406.13352
- **Simon Willison**, *The lethal trifecta for AI agents*, 16/06/2025 —
  dati privati + contenuto non fidato + canale di esfiltrazione è la
  combinazione pericolosa; **non** propone i permessi come soluzione
  («we still don't know how to 100% reliably prevent this»): la difesa è
  togliere una delle tre gambe per costruzione, non chiedere più spesso.
  https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- **OpenAI**, *Practices for Governing Agentic AI Systems* (Shavit, Agarwal
  et al.), whitepaper, dicembre 2023 — §4.2 riserva l'approvazione umana ad
  azioni «too important to delegate», con rischio anche piccolo di essere
  fatte male (l'esempio testuale è una transazione finanziaria
  **irreversibile**); §4.4, testuale: «Actions that can only be reviewed
  after the fact should be more easily reversible than those that require
  approval» — la reversibilità è esplicitamente l'alternativa strutturale
  all'approvazione preventiva. https://cdn.openai.com/papers/practices-for-governing-agentic-ai-systems.pdf
- **Anthropic**, *Building Effective Agents*, dicembre 2024 — i guardrail
  «need to be structural, baked into the architecture, not procedural»:
  stessa tesi, letta dal lato harness invece che dal lato dati.
  https://www.anthropic.com/research/building-effective-agents
- **Claude Code**, documentazione permission-modes (corrente, 2026) — la
  lista di ciò che *nessuna* modalità approva mai è corta e mirata (percorsi
  protetti, cancellazioni su path critici, regole `ask` esplicite); tutto il
  resto dentro lo scope di lavoro corre senza chiedere, e un classificatore
  separato guarda solo scalata/esfiltrazione, non ogni scrittura. La
  sandbox (bash/rete) decide *cosa un'azione può raggiungere*, il permesso
  decide *se si chiede*: due assi separati esplicitamente.
  https://code.claude.com/docs/en/permission-modes
- **OpenAI Codex CLI**, *Agent approvals & security* (corrente, 2026) —
  l'approvazione scatta al superamento del confine sandbox
  (`workspace-write` → rete o fuori-workspace) o per rischio di comando
  classificato, mai per la scrittura dentro lo scope concesso in quanto
  tale. https://learn.chatgpt.com/docs/agent-approvals-security
- **OpenHands**, *ConfirmationPolicy* (issue #2308, SDK docs) — conferma
  opt-in e risk-based: `ConfirmRisky` lascia correre il lavoro di routine e
  ferma solo le operazioni ad alto rischio/distruttive.
  https://github.com/OpenHands/OpenHands/issues/2308

Fonti interne (già in `dev`, non ricercate ma usate come precedente diretto):
ADR-0071 (provenienza sostituisce il numero: citato mai un cancello, composto
di un non-owner è `deny` non `ask` — «in un gruppo non c'è nessuno che possa
rispondere»); `docs/SECURITY.md` §4/§13 (fencing come marcatura non
prevenzione; «reversible effect/undo semantics are not claimed here until
[...] DAY-1-proven»).

## §2 Il principio, e le sue eccezioni

**Il principio che tutte le fonti primarie condividono, in forme diverse:**
la conferma umana è per le azioni che sono (a) irreversibili, o (b) escono da
un confine che il sistema controlla (rete verso un host arbitrario, un
destinatario esterno), o (c) allargano il privilegio oltre quanto già
concesso. Dentro un confine sigillato e reversibile — sandbox, workspace,
vault — il lavoro dell'harness è rendere l'esito negativo strutturalmente
impossibile o economicamente disfabile (capability/provenienza per CaMeL,
DSL a least-privilege per Progent, sandbox per Codex/Claude Code, giornale
per OpenAI §4.4), non interrogare l'utente ad ogni passo meccanico.

**Le eccezioni, altrettanto esplicite, sono tre e vanno tenute:**

1. **Nessun approvatore ≠ reversibilità come sostituto.** ADR-0071 lo dice
   già per questa base di codice: composto da un non-owner è `deny`, non
   `ask`, perché in un gruppo non c'è nessuno a cui chiedere. La
   reversibilità abbassa il costo della *scrittura*, non quello di
   un'esfiltrazione che l'accompagna: le due domande restano separate.
2. **L'approvazione resta per l'irreversibile, sempre.** OpenAI §4.2 non
   dice «basta rendere tutto reversibile»: dice che quando anche una piccola
   probabilità di errore è troppo costosa (l'esempio è finanziario), la
   conferma resta. La reversibilità sostituisce l'approvazione solo per la
   classe di azioni per cui è vera, non elimina la categoria.
3. **Il ratchet di Progent è asimmetrico, non assente.** Restringere il
   privilegio non chiede mai; allargarlo chiede sempre. Un harness che rende
   *tutto* silenzioso perché «è reversibile» perde questa asimmetria — e
   Willison aggiunge lo scetticismo di fondo: una policy di dataflow che
   decide da sola resta vulnerabile a essere scritta male, quindi il
   backstop umano su un'espansione di privilegio non va rimosso, va
   riservato al momento giusto.

## §3 Confronto punto per punto con ADR-0073

**Punto 1 (grant per tenant, tighten-only, mai `group:*` in blocco) — regge.**
Coincide con l'asimmetria di Progent (narrowing automatico, widening
nominato) e con CaMeL (la policy è decisa in anticipo dal principale
fidato, non negoziata per-azione). Nessuna correzione necessaria.

**Punto 2 (`vault.write` reversibile, riga di effetto propria, giornale) —
regge nel principio, ma è sottospecificato dove conta.** È esattamente il
caso di OpenAI §4.4: una scrittura disfabile in un deposito recintato del
proprio tenant è la categoria che la letteratura assegna al «non chiedere,
logga e rendi reversibile». Il problema: l'ADR non dice **a quale soglia di
taint** la riga `vault` smette di chiedere. Se il ceiling di quella riga
resta basso come le righe di rischio più alto, ogni salvataggio di un
membro qualunque (taint 2 per costruzione, come misurato da §6.1 di
0071) tornerà a essere un `ask` — cioè esattamente il sintomo che l'owner
lamenta oggi, spostato da «non esiste» a «esiste ma chiede lo stesso». Il
punto 2 non è un divieto travestito, ma **manca** la frase che lo rende
verificabile: quale ceiling ha la riga `vault`, e su quali basi.

**Punto 3 (`sys.search:composed` per stanza, nominato) — rischio non
argomentato, va trattato come `manca`.** ADR-0071 ha chiuso esattamente
questo buco per una ragione scritta a chiare lettere: un membro non-owner
che compone una query è per costruzione il canale che il gate
sull'esfiltrazione esiste per fermare, e in un gruppo non c'è nessuno a cui
chiedere — quindi `deny`, non `ask`. Concedere `sys.search:composed` per
nome a una stanza riapre quel canale senza offrire un meccanismo diverso
da «fidati del grant»: è precisamente la combinazione che Willison chiama
trifecta (contenuto di stanza non fidato + query scelta dal modello +
canale esterno). L'ADR non porta l'evidenza — un corpus avversariale come
quello usato per 0066/0071 — che servirebbe per aprire questa eccezione.
Finché non esiste quella prova, il punto 3 va trattato come non pronto,
non come deciso.

**Punto 4 (owner effimero come approvatore dentro la stanza) — regge come
canale, ma eredita il problema del punto 2.** Il meccanismo di consegna
(messaggio effimero, Bot API, mai agli admin) è corretto e coerente con la
scelta già fatta da 0071 di non degradare a un "chiunque" nel gruppo. Il
difetto non è nel canale: è che se il punto 2 non fissa un ceiling
generoso per la riga `vault`, questo stesso canale diventa il posto dove
tutte le conferme superflue continuano ad arrivare — un `ask` funzionante è
comunque un `ask` di troppo se scatta per un salvataggio ordinario dentro
il proprio vault.

**Punto 5 (`todo`/`wait` di turno, non di stanza) — regge, ortogonale.**
Non tocca l'asse permesso-vs-harness; nessuna fonte esterna lo contraddice
o lo rafforza.

## §4 Proposta di riscrittura (≤5 punti, ciascuno falsificabile)

1. **La riga `vault` porta un ceiling esplicito e alto per il caso
   "cita/scrivi nel proprio tenant".** Un salvataggio di un membro dentro il
   vault del proprio gruppo (nessuna lettura cross-tenant, nessun host
   esterno) non deve mai attraversare un `ask` — solo giornale + reversibilità.
   *Falsificazione:* strumentare N turni reali di `vault.write` in una
   stanza con grant; se una quota misurabile di salvataggi ordinari genera
   comunque un `ask` all'owner, il ceiling è sbagliato e va alzato o la riga
   va ridefinita.
2. **Separare "comporre dentro il vault" da "comporre che esce dal tenant".**
   Solo le richieste i cui byte lasciano il confine del tenant (rete,
   `sys.search` con testo scelto dal modello, lettura cross-tenant) ereditano
   la logica composto/non-owner→`deny` di ADR-0071; una scrittura che resta
   nel vault del tenant non è un'uscita e non deve passare dallo stesso
   cancello.
   *Falsificazione:* corpus avversariale (stile
   `eval-taint-corpus-avversariale`) in cui un membro ostile usa
   `vault.write` come canale laterale (scrive dati destinati a essere letti
   più tardi fuori tenant); se l'attacco completa senza alcun gate, il
   confine è disegnato nel punto sbagliato.
3. **`sys.search:composed` resta owner-only finché non esiste un
   meccanismo di sicurezza equivalente a "nessuno a cui chiedere".** Non
   concederlo per nome a una stanza sulla sola base di questo ADR.
   *Falsificazione:* se e quando si propone di concederlo, va rieseguito lo
   stesso corpus di 0066/0071 sulla stanza con grant; una sola scena di
   esfiltrazione via query composta che completa senza essere rilevata
   blocca la concessione.
4. **L'`ask` all'owner, quando esiste, si lega al costo di irreversibilità,
   non all'identità del principale.** Riservarlo alle azioni ambigue o che
   escono dal tenant (punti 2-3), non al salvataggio di default.
   *Falsificazione:* dopo il rilascio, misurare il registro degli `ask`
   generati da stanze con grant — la quota di `ask` per un salvataggio
   puramente interno e reversibile deve tendere a zero; ogni valore
   apprezzabile prova che il ceiling del punto 1 non è stato davvero alzato.
5. **Il meccanismo non è "reale" finché non lo prova il dogfood, non il
   codice.** Vale il criterio già scritto in coda ad ADR-0073: se l'owner
   continua a dire «un file» invece di «salva questo», o gli `ask` restano
   senza risposta per giorni, il punto va riaperto — non basta che
   `agent/capability-gaps.test.ts` o l'equivalente per `vault` sia verde.

## §5 Cosa non ho potuto verificare

- Nessuna misura runtime: mandato di sola lettura, nessun test lanciato,
  nessuna stanza reale con grant esiste ancora (ADR proposto, non
  implementato) — i ceiling di riga citati al §3-4 sono ipotetici perché
  `core/policy/matrix.ts`/`effect-rows.ts` non hanno ancora una riga `vault`.
- Il whitepaper OpenAI è del 2023: lo cito come cornice concettuale
  (irreversibilità come soglia dell'approvazione), non come prassi 2026 di
  OpenAI — il documento più recente e operativo di OpenAI (Codex CLI
  approvals) è citato a parte.
- `openai.com/index/practices-for-governing-agentic-ai-systems/` ha risposto
  403 a WebFetch diretto; il contenuto è stato letto dal PDF
  (`cdn.openai.com`), non dalla pagina di annuncio.
- Non ho letto il paper CaMeL/Progent per intero (solo abstract + sintesi
  secondarie con citazioni verificate incrociando due fonti indipendenti);
  eventuali dettagli sperimentali fini (tassi di successo esatti su
  AgentDojo) non sono stati controllati riga per riga.
- Non ho verificato la documentazione ufficiale di Devin (accesso non
  disponibile in questa sessione) né di Hermes/OpenClaw sul tema permessi
  gruppo — il confronto peer al §3 si appoggia solo su Claude Code, Codex
  CLI, OpenHands.
