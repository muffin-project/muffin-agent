# ADR-0073 — Una stanza ha le sue capacità, e dentro il suo confine non chiede

**Stato:** **accettato per i punti 1, 2, 3 e 5 · 2026-09-07**; il **punto 4
resta aperto** (la domanda effimera all'owner dentro il gruppo: un `ask` nato
in una stanza è ancora `deny` per un membro, com'era) · proposto 2026-09-04,
riscritto il 2026-09-06 · direzione owner, ricerca
`muffin-nei-gruppi-2026-09-04.md` §3 e §5 e
`harness-non-permessi-2026-09-06.md`

**Dove vive, adesso** (2026-09-07): il grant per stanza in
`core/policy/matrix.ts` (`tenants`, `MAI_CONCEDIBILI`, `grantedTo`), letto dal
kernel in `core/policy/decide.ts`; `vault.write` e il tool `vault_save` in
`agent/tools/vault-save.ts`, con la riga di effetto `vault` in `ROW_FLOOR`;
il menu del modello allineato al kernel in `agent/context/assemble.ts`
(`visibleTools`, quarto argomento). Provato per stanza da
`core/policy/solo-irreversibile.test.ts`, `core/policy/matrix.test.ts`,
`agent/capability-gaps.test.ts`, `agent/tools/vault-save.test.ts` e — sul
binario vero, con il sigillo riscritto fra due vite del gateway — dallo
scenario di accettazione F7 (`evals/acceptance/scenarios/f-gruppi.accept.ts`).

Il punto 5 è atterrato come l'ADR lo scrive: `turn.todo` e `turn.wait` restano
`hostOnly: true` — il default per un gruppo che nessuno ha esaminato resta no
— e una stanza li riceve nominandoli nel proprio grant, senza nessun
meccanismo separato, perché seguono già la sessione della stanza.

## Contesto

Direzione owner (04/09): in un gruppo specifico Muffin deve poter *«gestire
file, creare file, web search, web fetch, multi step, loop — shell no, vault
sì»*. Oggi un membro raggiunge `documents.read`, `sys.http` (lettura),
`memory.*`, `surface.reply`; **tutto il resto è `hostOnly`**
(`agent/capability-gaps.test.ts`).

Obiezione owner (06/09) alla prima stesura: *«troppe conferme che io devo
dare perché salvi un file; un agente non ha così tanti limiti, ha un harness
che gli evita di fare casini»*. La ricerca del 06/09 conferma l'obiezione con
le fonti primarie (OpenAI *Governing Agentic AI Systems* §4.2 e §4.4,
Willison *lethal trifecta*, CaMeL, Progent, i permission mode di Claude Code
e Codex CLI): **la conferma umana è per tre classi di azioni** — quelle
irreversibili, quelle i cui byte *escono* da un confine che il sistema
controlla, quelle che *allargano* un privilegio. Dentro un confine sigillato
e reversibile il lavoro dell'harness è rendere il danno impossibile o
disfabile, non interrogare.

Tre fatti misurati restano veri e vincolano il disegno:

1. **Non esiste uno spazio della stanza.** `resolveWorkspace(home, cwd)` è uno
   per installazione (ADR-0059) e `fs_write` è `hostOnly`: riaprire il disco
   ai membri è la Combinazione C applicata al filesystem.
2. **Non esiste una scrittura deliberata.** I soli produttori di scritture
   durevoli sono automatici (ingestione allegati, episodio di ogni turno).
   «Muffin, salva questo» è una capability nuova per qualunque tenant.
3. **Gli ask di un membro sono `deny`** (ADR-0071): un non-owner che compone
   byte in uscita viene negato, non interrogato, perché in un gruppo non c'è
   nessuno a cui chiedere. La reversibilità abbassa il costo di una
   *scrittura*, non quello di un'*esfiltrazione*: le due domande restano
   separate.

## Decisione (proposta)

**1. La capacità sta nel tenant, nella policy sigillata, e può solo
allargarsi per nome.** `rot/policy.json` accetta `tenants: { "<tenantId>":
{ grants: [...] } }`: un elenco di capability id che in quella stanza
smettono di essere `hostOnly`. Un grant **aggiunge** a una stanza nominata
(`group:…` o `community:…`), mai toglie a `host`, mai `sys.shell`, mai
`rot.*`, mai `outward.*` (lista chiusa in `matrix.ts`), mai `group:*` in
blocco. È l'asimmetria di Progent: restringere non chiede mai, allargare si
scrive nel sigillo. `doctor` elenca le stanze con grant.

**2. Lo spazio della stanza è il suo vault, e scriverci non chiede.** La
prima capability che una stanza riceve è `vault.write`: *«salva questo»* —
un link, un testo, un allegato già ingerito — nel vault **del tenant**, che
`documents.read` già legge per tenant. Riga di effetto propria (`vault`) con
un soffitto di taint **esplicito e alto**: una scrittura che resta nel vault
del proprio tenant, senza lettura cross-tenant e senza host esterno, non
attraversa mai un `ask`, a qualunque taint — solo il giornale del vault (come
`draft` per `fs_write`) e l'undo. Il confine, non la fiducia in chi scrive,
è ciò che rende la scrittura sicura. `fs_*` resta `hostOnly`: un gruppo non
ha un disco.

**3. Il cancello di ADR-0071 vale per ciò che esce dal tenant, non per ciò
che resta dentro.** Ereditano composto/non-owner → `deny` solo le richieste i
cui byte lasciano il confine: rete verso un host, `sys.search` con testo
scelto dal modello, lettura cross-tenant. `sys.search` in una stanza con
grant risponde a `perTenantDailyUsd` e resta soggetto a ADR-0071 come oggi.
**Nessun `sys.search:composed` per stanza**: la prima stesura lo concedeva
per nome, e riapriva esattamente il canale che 0071 aveva chiuso (contenuto
di estranei + query composta dal modello + canale esterno è la trifecta).
Si riapre solo con un corpus avversariale come quello di 0066/0071 in cui
nessuna scena di esfiltrazione via query composta completa senza essere
rilevata.

**4. L'`ask`, quando esiste, si lega all'irreversibilità, non a chi scrive.**
Un `ask` nato in un turno di stanza con grant riguarda solo un'azione
irreversibile o che esce dal tenant (punto 3); va all'owner come **messaggio
effimero** nel gruppo stesso (Bot API 10.2/10.3: il bot è admin), con i
pulsanti della coda durevole (D12). Mai agli admin del gruppo: la ricerca ha
scartato la Combinazione C e il vecchio Muffin *nominava* gli admin, non li
ascoltava. Se l'owner non è nella stanza (F4 garantisce che allora Muffin non
c'è), l'`ask` è `deny`, come oggi. Un salvataggio ordinario nel proprio
vault non produce mai questo messaggio: se lo produce, il punto 2 è rotto.

**5. `todo` e `wait` sono del turno, non della stanza.** Sono primitive del
runtime e in una stanza con grant seguono la sessione della stanza — un
topic ha la sua (F3). Nessun grant separato.

## Conseguenze

- Il kernel guadagna una dimensione (tenant → grant) e la perde la sola riga
  `hostOnly`: `decide.ts` legge `hostOnly && !grantedTo(tenant)`. Una
  mutazione che ignora il grant deve far cadere una prova per stanza.
- `core/policy/matrix.ts` acquisisce la riga `vault` con il suo soffitto
  dichiarato; una mutazione che la abbassa al livello delle righe di rete
  deve far cadere una prova («un membro salva, nessun ask»).
- La spesa di una stanza è già tettata; il grant non la cambia.
- F8 (proattività) non dipende da questa ADR e non la richiede.

## Cosa la falsifica

- **Punto 2:** in una stanza di prova con grant, un salvataggio ordinario di
  un membro genera un `ask` — allora il soffitto della riga `vault` è
  sbagliato o la riga è definita nel posto sbagliato. Misura: il registro
  degli `ask` per stanze con grant; la quota per scritture interne e
  reversibili deve tendere a zero.
- **Punto 3:** un corpus avversariale in cui un membro ostile usa
  `vault.write` come canale laterale (scrive byte destinati a essere letti
  più tardi fuori tenant) e l'attacco completa senza alcun cancello — allora
  il confine è disegnato nel punto sbagliato e va spostato alla *lettura*
  cross-tenant.
- **Punto 4:** gli ask effimeri restano senza risposta per giorni — allora
  sono un divieto travestito e il canale va ridisegnato.
- **Tutto:** se con `vault.write` l'owner continua a chiedere «un file» e non
  «salva questo», il punto 2 è sbagliato e va riaperto verso un workspace
  per tenant. Il meccanismo non è reale finché non lo prova il dogfood: un
  test verde su `capability-gaps` non basta.
