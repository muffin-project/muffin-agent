# 10 — Risoluzioni della Fase C

> Le tre critiche ostili (`critique/c1-threat-model.md`, `c2-complessita.md`, `c3-ingegnere-m0-m1.md`) hanno prodotto 16 attacchi, 14 bersagli di complessità e ~60 domande d'ingegneria. Qui il verdetto su ciascuna famiglia: **accolta** (e dove è stata applicata), **respinta con argomento**, o **decisione dell'owner** (una sola, in §4). Le obiezioni sono risolte NEI documenti, non in appendice — questo file è la mappa, non il parcheggio.

## 1. C1 — threat model: accolte 15/16, 1 già dichiarata

| # | Attacco | Esito |
|---|---|---|
| 1 | **Renderer rich-media = egress non mediato** (Chromium risolve risorse remote prima di ogni conferma) | **ACCOLTA — era la falla vera.** Doppia chiusura: il rendering diventa capability (`render.rich_media`) e il browser sparisce del tutto (§3: rendering offline con libreria leggera, nessun processo browser, nessuna rete per costruzione). Ogni campo tier>0 escapato a testo puro, template fisso versionato. → 03 §3-ter, ADR-0016 rivisto |
| 2 | RoT: enforcement OS presuppone processo non privilegiato, mai dichiarato | **ACCOLTA.** Due modalità esplicite + verifica UID/proprietà al boot; in single-user si dichiara "rilevazione, non prevenzione" e `sys.shell` resta ASK per sempre. → 09 §4, 03 §4(g) |
| 3 | Tool description MCP nella fascia di fiducia sbagliata (rug-pull) | **ACCOLTA.** Hash pinnato di nome+description+schema, ri-approvazione su variazione, descrizioni esterne spotlighted e collocate dopo i tool interni. → 03 §4(c-bis) |
| 4 | Taint congelato a metà turno (fetch-then-act) | **ACCOLTA.** Il taint si ricalcola a ogni `decide()`; "immutabile per il turno" vale solo per principal/tenant/capability-set; scope = turno, non sessione. → 03 §2, 09 §1 |
| 5 | Il tier si perde ai bordi di sintesi (sub-agent, compattazione, profili, digest) | **ACCOLTA.** Ereditarietà del tier promossa a invariante trasversale: ogni testo derivato porta il tier massimo delle fonti, il ritorno di un sub-agent è trattato come tool result. → 03 §2 |
| 6 | Brief proattivo consegna il ricordo avvelenato con provenienza poco saliente | **ACCOLTA.** Provenienza visibile *all'occhio dell'owner* per ogni riga non tier-0/1 nei digest, non solo nel context del modello. → 03 §3-ter(5) |
| 7 | Cricchetto: la proposta legge trace grezzi; nessun audit del diff | **ACCOLTA.** Input limitato a fatti già filtrati dalla pipeline; diff testuale mostrato prima dell'attivazione (notify-after resta solo per soglie numeriche). Converge con C2-#6. → 03 §4(f) |
| 8 | `system@scheduler` / `agent@dev` senza colonna: HITL senza umano | **ACCOLTA.** Principal a sé: ogni ASK diventa ASK-in-coda, mai auto-ALLOW; `outward.*` e `config.ratchet` esclusi da `system@scheduler`. → 03 §3 |
| 9 | PR sul RoT senza protezione differenziata (rubber-stamping da volume) | **ACCOLTA.** CODEOWNERS sui path del RoT, diff isolato obbligatorio, CI che segnala. → 03 §7 |
| 10 | UI di conferma influenzabile da testo tainted | **ACCOLTA** nella regola 4 del rendering (template fisso, testo non-owner in blocco distinto, mai nel bottone). |
| 11 | Entity resolution non dichiarata tenant-scoped | **ACCOLTA.** Candidate-matching vincolato a `tenant_id` identico (fast-path e fallback), + test "stesso nome, due tenant". → 02 §3, 05 §4 |
| 12 | Consolidamento/profili senza partizionamento dichiarato | **ACCOLTA.** I job batch iterano un tenant per volta con lo stesso layer di accesso delle query utente. → 02 §3 |
| 13 | Workspace sandbox non namespaced per tenant | **ACCOLTA.** Workspace `(tenant_id, turn_id)`, wipe *prima* dell'uso, test di fuga fs cross-tenant. → 03 §3-bis |
| 14 | Proxy egress locale raggiungibile da processi non sandboxati | **ACCOLTA come rischio residuo dichiarato** (nessuno dei 5 harness auditati lo risolve) + token per-sessione come evoluzione. → 03 §7 |
| 15 | `dev` e fs: scritture fuori dal write-scope? | **ACCOLTA.** Ogni operazione fs innescata da `dev` è vincolata al write-scope del clone, enforced a livello OS. → 03 §3-bis |
| 16 | Community: "conferma dell'interessato" senza forza di autenticazione | **ACCOLTA come vincolo fissato ora** (out-of-band obbligatorio), anche se il flusso è post-v1. → ADR-0017 |

## 2. C2 — complessità: accolte 11/14, 2 respinte con argomento, 1 all'owner

**Accolte (il piano si accorcia).**
- **#11 Chromium → tagliato**: rendering con libreria leggera SVG→PNG, nessun processo browser. Chiude insieme il bersaglio di complessità e l'attacco C1-1: la stessa modifica risolve entrambe le critiche, ed è il segnale che era la scelta sbagliata.
- **#10 renderer canonico → ridimensionato**: contratto minimo (blocchi tipati text/table/image/file + capability dichiarate dal connector), niente motore generico di negoziazione. La direttiva owner ("poca verbosità, rich-media per connector") è soddisfatta da questo; il resto arriva col terzo connector.
- **#6 cricchetto → semplificato**: v1 = proposta + diff in chat + eval pertinente + owner approva. Canary con revert automatico **rimandato** (serve una baseline che non esiste ancora). Converge con C1-7.
- **#12 OTel → naming sì, SDK no**: si adottano gli attributi `gen_ai.*` (pinnati) scrivendo JSONL+SQLite in proprio; nessun SDK/exporter finché non esiste un consumatore esterno. Elimina anche il rischio context-propagation async.
- **#13 MCP → protocollo sì, UX di scoperta no**: si parla la spec 2026-07-28 per i server realmente in uso; niente marketplace/allowlist-UX generica per un catalogo vuoto.
- **#2 identities → tabella sì, state-machine no**: le colonne restano (fondamenta strutturali, costano zero), il flusso `proposed→confirmed` non si costruisce finché non esiste il secondo connector remoto.
- **#3 recall → niente classificatore "domanda storica"**: i fatti expired entrano nel recall con la loro etichetta temporale e decide il modello. Un classificatore in meno, una fonte d'errore in meno (stessa lezione degli intent-classifier retrocessi a monitor-only).
- **#4 giudice → one-shot ora, eval-a-soglia dopo la migrazione**: la migrazione conta i conflitti reali sul nuovo schema, poi si tara.
- **#8/#9 CI → pre-merge solo sul consumer-locale** (il vincolo stringente), frontier su nightly e release-gate. Dimezza il costo mantenendo il gate che conta.
- **#7 M6 → specificato**: report su di sé diviso in (i) aggregati deterministici SQL, spedibili subito, e (ii) narrativa, ammessa solo con ancoraggio a episodi come il report-utente. "Esito" va definito per classe di interazione prima del monitor anti-dipendenza.
- **#1 RoT → il meccanismo pesante diventa opt-in**: `--hardened` (utente di servizio) è opzionale; il default single-user usa hash+anchor con boot rifiutato solo su manomissione rilevata. Nessuno script di provisioning cross-platform da mantenere in v1.

**Respinte, con argomento.**
- **#5 "collassa il taint a un booleano"**: l'osservazione è corretta — nella matrice di v1 le colonne taint-2 e taint-3 danno lo stesso verdetto in tutte le righe. Ma il collasso a `trusted: boolean` va rifiutato per due motivi. Primo: le due colonne divergono appena esistono outward e community, cioè esattamente quando servirà, e allora il cambio tocca ogni dichiarazione di capability. Secondo, più importante: il tier è la stessa scala del dato (`trust_tier` in memoria) — averne una seconda, diversa, per la policy è precisamente la frammentazione che ADR-0013 esiste per evitare. **Compromesso applicato**: la scala resta 0-3 ovunque, ma le capability dichiarano `maxTaint` solo quando diverso dal default della loro classe di rischio — la cerimonia sparisce, la scala no.
- **#14b "il rewrite parallelo è la premessa sbagliata"**: la parte diagnostica è forte e va in §4 come decisione tua. La conclusione operativa ("retrofit sul repo che gira, niente secondo albero") la respingo *come default silenzioso*: contraddice una direttiva esplicita del checkpoint e una scelta di prodotto (l'artefatto pubblico open-source non nasce dentro un repo con 150 ADR storici, DB personale e god-file). Ma non la seppellisco: è la sola cosa su cui una tua correzione ora vale mesi.

## 3. C3 — l'ingegnere: accolte tutte

Il verdetto ("decisioni ~85%, contratti ~30%; risposta alla definition of done: **no**") era corretto. Risposta: **`09-contratti-m0-m1.md`**, normativo, che fissa tipi (`Principal`, `Decision`, `decide()`, `CapabilityDecl`, `ChatCall`, profilo modello, `PermissionSnapshot`), formati file (RoT in JSON con manifest+anchor, config, secrets age, trace JSONL), sequenze (init, boot in 9 passi, doctor), tabella errori/degradazioni, comandi CLI con exit code, dipendenze nominate, e — soprattutto — **i numeri del floor**: N=10 tool esposti, X=15 tool-call sequenziali, Y=32K context utile, cap duro 40 iterazioni/turno.

Le 11 contraddizioni tra documenti sono chiuse in 09 §12. La più grave era **K1**: la DoD di M1 richiedeva tool `fs` che lo scope di M1 escludeva. Risoluzione: **M1 ha i propri primitivi** (`fs.read`, `fs.list`, `fs.write`, scope ristretto, deny-path del RoT applicati) — legittimo senza sandbox perché in M1 esiste solo il principal owner via CLI e nessun input non fidato è ancora entrato nel sistema; **M3 aggiunge shell/processi/rete/MCP e nello stesso modulo il sandbox**, mai prima.

## 4. La decisione che resta tua

**Rewrite parallelo (M0→M7 su albero nuovo) vs retrofit incrementale sul repo che gira.**

L'argomento di C2, riportato onestamente: un audit interno del 2026-07-16 con mandato quasi identico concluse "non serve un redesign"; la tua stessa tabella keep/change/kill segna KEEP su 13 elementi su 32; e con serate part-time, M0+M1 valgono settimane prima che tu veda un solo beneficio quotidiano nuovo — mentre M2 (memoria, il primo valore percepibile) è il terzo modulo.

Le tre opzioni, coi costi veri:
1. **Rewrite completo** (il piano com'è): repo pubblicabile e pulito, contratti nuovi ovunque, ma il valore quotidiano arriva tardi e per settimane mantieni due sistemi.
2. **Retrofit** (proposta C2): valore immediato (provenienza+taint, kernel binario, sandbox verificato sul VPS, self-report), ma l'artefatto pubblico resta un repo con 150 ADR e i god-file — e il confine repo/config/dati (ADR-0011), che è la precondizione per distribuirlo, non arriva mai da solo.
3. **Strangler** (la mia raccomandazione): albero nuovo, ma l'ordine cambia — **M0 → M1 → M2 (memoria) → M4 (Telegram) prima di M3**. Appena M2+M4 girano, il nuovo Muffin è già il tuo Muffin quotidiano su un canale reale, e il vecchio resta acceso solo per ciò che non è ancora migrato. I primitivi e il sandbox (M3) arrivano subito dopo, quando c'è già un sistema vivo da far lavorare. Costa una settimana in più di doppio-sistema; compra la fine del "sto costruendo da tre mesi e uso ancora il vecchio".

Se non mi dici altro, procedo con **3**.

## 5. Cosa è cambiato nei documenti

`03-threat-model.md`: §2 taint ricalcolato + invariante di ereditarietà del tier; §3 principal system/dev + riga rendering nella matrice; §3-ter rendering come capability (nuova); §3-bis workspace per tenant + fs di `dev`; §4 (c-bis) MCP pinning, (g) RoT vs shell dell'agente; §7 tre rischi residui nuovi. `02-ontologia.md`: entity resolution tenant-scoped, job batch per tenant, recall senza classificatore. `04-roadmap.md`: M1 con primitivi propri, M3 con sandbox, ordine strangler, CI pre-merge alleggerita. `05-testing-evals.md`: test cross-tenant su entità e fs. `09-contratti-m0-m1.md`: tutto lo strato dei contratti (nuovo). `ADR-0016` rivisto (niente browser), `ADR-0014` ridimensionato (canary rimandato), `ADR-0010` (OTel naming senza SDK, MCP senza UX), `ADR-0017` (conferma out-of-band). `08-assunzioni.md`: le nuove scelte implicite di questa fase.
