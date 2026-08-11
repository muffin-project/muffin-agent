# 09 — Contratti concreti per M0/M1 (tipi, formati, numeri)

> Nato dalla critica C3 (`critique/c3-ingegnere-m0-m1.md`): le decisioni erano solide, mancava lo strato sotto — tipi, formati file, numeri, sequenze. Questo documento è **normativo**: dove contraddice gli altri, vince questo. Ogni voce risolve una domanda numerata di C3 (riferimento tra parentesi).
>
> Regola di lettura: TypeScript è pseudo-codice normativo (nomi campo e semantica vincolanti, dettagli di sintassi no).

## 1. Tipi del kernel (A1-A8, A11)

```ts
// core/policy/types.ts
type Principal =
  | { kind: 'owner';  connector: ConnectorId }                    // l'owner, da qualunque canale autenticato
  | { kind: 'member'; connector: ConnectorId; tenantId: TenantId; externalId: string }
  | { kind: 'system'; source: 'scheduler' | 'consolidation' | 'ratchet' }
  | { kind: 'agent';  role: 'dev' };                              // Muffin che lavora su se stesso
type TenantId = string;            // 'host' | `group:${connector}:${externalId}` | `community:${slug}`
type ConnectorId = string;         // 'cli' | 'telegram' | …
type TrustTier = 0 | 1 | 2 | 3;    // = taint. Stesso dominio di episodes.trust_tier (A5)

type CapabilityId = string;        // dotted, stabile, versionato col repo: 'memory.read', 'fs.write',
                                   // 'net.egress', 'sys.shell', 'sys.process', 'dev.repo', 'config.ratchet', 'outward.send'
type Resource =
  | { kind: 'path';   value: string }        // assoluto, già normalizzato (no '..', symlink risolti)
  | { kind: 'url';    value: string }        // assoluto, con host estratto dal chiamante
  | { kind: 'tenant'; value: TenantId }
  | { kind: 'none' };

type Decision =
  | { effect: 'allow' }
  | { effect: 'ask';   ask: { audience: 'owner'; prompt: string } }
  | { effect: 'draft'; undo: { capability: CapabilityId; window_s: number } }
  | { effect: 'deny';  code: DenyCode; detail?: string };
type DenyCode = 'no_capability' | 'taint_exceeded' | 'tenant_mismatch' | 'budget_exhausted'
              | 'rot_violation' | 'resource_denied' | 'principal_forbidden';

function decide(req: {
  principal: Principal; tenant: TenantId; capability: CapabilityId;
  resource: Resource; args: Readonly<Record<string, unknown>>; taint: TrustTier;
}): Decision;   // SINCRONA e pura (A7): nessun I/O, nessuna rete, nessun await.
                // Legge solo la policy già caricata in memoria al boot.
```

- **`tenant` è ridondante ma esplicito (A2)**: `decide()` verifica la coerenza col principal e restituisce `deny/tenant_mismatch` se divergono — è un guard contro bug del chiamante, non una scelta del chiamante.
- **`args` sono i parametri già validati dallo schema del tool** (non JSON raw dal modello): la validazione di schema precede sempre la policy. Il kernel ispeziona solo i campi che la dichiarazione di capability marca come `policyArgs` (A4).
- **In M1 il taint è determinato dal solo principal** (owner→0, member→2, system→eredita dal job, agent→0) perché la memoria non esiste ancora (F3). Da M2 è `max(tier dei blocchi in context)`.

### Dichiarazione di capability di un tool (A3, A8, B2)

Vive **accanto al tool** nella sua feature-cartella (coerente con ADR-0002); `core/policy` fornisce solo tipo e registrazione al boot.

```ts
export const fsWriteCapability = {
  id: 'fs.write',
  risk: 'medium',                      // 'low' | 'medium' | 'high'
  reversible: 'undoable',              // 'yes' | 'undoable' (undo_log) | 'no'
  maxTaint: 0,                         // taint massimo del contesto ammesso
  resourceKind: 'path',
  policyArgs: ['path'],                // campi di args ispezionati dal kernel
  hostOnly: true,                      // mai raggiungibile da tenant remoti
} as const satisfies CapabilityDecl;
```

### PermissionSnapshot (A11)

**Lazy + memoizzato** per turno: `snapshot.check(capability, resource, args)` chiama `decide()` alla prima richiesta e cachea l'esito per la chiave `(capability, resource)`. Immutabile nel senso che principal/tenant/taint del turno non cambiano dopo il pre-loop; se un tool result alza il taint (M2+), il turno **non** ricalcola all'indietro ma il taint nuovo vale per le decisioni successive — e la transizione è un evento nel trace. (Il caso "taint che sale a metà turno" è nel mandato di C1: se emergono catene sfruttabili, la regola diventa più stretta.)

## 2. ChatCall e profili modello (A9, A10, A13, A14)

```ts
// agent/providers/types.ts
type ChatCall = {
  model: string;                       // id provider-specifico
  system: ContentBlock[];              // blocchi con cacheHint
  messages: Message[];                 // role: 'user'|'assistant'|'tool'
  tools?: ToolSpec[];                  // { name, description, inputSchema: JSONSchema }
  toolChoice?: 'auto' | 'none';        // mai 'required' di default (lezione ADR-111: rompe le chiusure legittime)
  maxOutputTokens: number;
  temperature: number;
  thinking?: { budgetTokens: number };  // no-op tracciato se l'adapter non lo supporta
  structuredOutput?: { schema: JSONSchema; name: string };
  stream: boolean;
  signal?: AbortSignal;
};
type ChatResult = {
  text: string | null;
  toolCalls: { id: string; name: string; args: unknown }[];   // args già JSON-parsati
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  raw?: unknown;                       // solo per il trace, mai per la logica
};
```

`cacheHint` sui blocchi è **posizionale**: `{ cache: 'stable' }` marca la fine di un prefisso cacheabile. L'adapter Anthropic lo traduce in `cache_control` su blocchi di sistema **e** di messaggio; l'adapter openai-compat lo traduce **solo sui blocchi di sistema**, e **solo per gli endpoint che cacheano su richiesta** (oggi: hostname `openrouter.ai`, dove Anthropic e Alibaba non hanno caching implicito — `wantsExplicitCache`). Per tutti gli altri endpoint resta la stringa piatta di sempre: metà dell'ecosistema compat cachea implicitamente, e un campo ignoto su un parser rigido è un 400. *(Riscritto 2026-08-11: la versione precedente diceva "openai-compat lo ignora e traccia il no-op" — la prima metà è diventata falsa, la seconda non è mai stata vera. L'asimmetria sui blocchi di messaggio resta e ora è scritta.)*

**Selezione adapter (A14)**: campo esplicito in config `provider: 'anthropic' | 'openai-compat'` — nessuna inferenza dall'URL. `muffin init` lo chiede quando l'endpoint non è riconosciuto. *(Scope, 2026-08-11: il divieto d'inferenza riguarda la **selezione dell'adapter**, dove un'ipotesi sbagliata fallisce alla prima chiamata. Il dialetto di caching dentro openai-compat è invece inferito dall'endpoint per costruzione — lì un'ipotesi sbagliata non fallisce mai: paga 10× in silenzio, che è il fallimento peggiore dei due, e `doctor` la mostra.)*

**Profilo per-modello** (`agent/profiles/<slug>.json`, A10):

```json
{ "schemaVersion": 1, "match": ["claude-sonnet-5*"], "maxToolsExposed": 24, "maxToolCallsPerTurn": 40,
  "structuredOutputMode": "native", "thinking": "allowed",
  "recovery": ["nudge", "retryOnce"], "notes": "profilo neutro: nessuna stampella" }
```

`match` = glob sul nome modello, primo match vince, fallback = `profiles/conservative.json` per modelli ignoti. Strategie di recovery ammesse: `nudge` (reinietta l'istruzione di continuare), `reinjectTools` (rilista i tool validi dopo un nome inesistente), `retryOnce`, `strictJson` (forza structured output). **Nessun `providerSwitch` in v1** (richiederebbe un secondo provider configurato: fuori scope, dichiarato).

## 3. Il floor: i numeri (E1, E2, K7)

| Parametro | Valore v1 | Perché questo numero |
|---|---|---|
| **N — tool esposti simultaneamente** | **10** | La superficie per-turno del Muffin attuale è 15-22 e mostra rumore di retrieval; il primitive-layer punta a ~10-12. I modelli consumer 20-35B reggono questo ordine. |
| **X — tool-call sequenziali per turno** | **15** | Copre i task reali osservati (ricerca+lettura+scrittura+verifica) restando sotto la soglia dove i modelli piccoli perdono il filo. |
| **Y — context utile** | **32K token**, con un fatto rilevante piazzato negli ultimi 2K e uno nei primi 2K, entrambi da recuperare | Sotto la finestra nominale di qualunque candidato; misura l'attenzione effettiva, non quella dichiarata. |
| **Recovery** | 1 tool-call malformato e 1 tool in errore per scenario, recuperati senza intervento umano | I due fallimenti più frequenti osservati. |
| **Cap duro di iterazioni** | **40 per turno** (indipendente dal profilo e dal budget) | Argine di sicurezza al loop infinito, mai raggiunto da un turno sano. |

Il floor passa se **tutti** gli scenari passano su entrambi i modelli di riferimento in 3 run consecutive.

## 4. File del RoT: formato e integrità (B1, B5, B6, C3, K4)

```
~/.muffin/rot/
  manifest.json        # { schemaVersion, files: [{path, sha256}], rotVersion, installedAt, installedBy }
  policy.json          # matrice: regole (principal-kind × capability × maxTaint) → effect
  capabilities.json    # snapshot delle capability dichiarate, congelato all'install
  egress.json          # allowlist domini per capability
  budgets.json         # cap spesa/proattività, quiet hours
  identity.md          # invarianti di condotta (unico Markdown)
  evals/               # suite di riferimento del cricchetto (JSON per caso)
```

JSON (non YAML: parsing senza dipendenze, niente ambiguità di tipo; i commenti stanno in un campo `_comment`). Ogni file ha `schemaVersion` (B6); il loader rifiuta versioni sconosciute con messaggio esplicito.

**Integrità (B5)**: `manifest.json` contiene `sha256` di ogni file del RoT; l'hash del manifest stesso è salvato **fuori** dal RoT, in `~/.muffin/.rot-anchor` (file di proprietà dell'installer, scritto solo da `muffin init`/`muffin update`). Al boot: ricalcola gli hash dei file → confronta col manifest → confronta l'hash del manifest con l'anchor. Mismatch = **boot rifiutato** con l'elenco dei file divergenti e l'istruzione per rigenerare legittimamente (`muffin rot reinstall`).

**Enforcement, risposta onesta a C3 (C3/K4)** — due modalità dichiarate, mai una promessa vaga:
- **Hardened (raccomandata, default se l'install ha privilegi)**: `muffin init --hardened` (richiede sudo) crea l'utente di servizio `muffin`; i file del RoT restano di proprietà dell'utente installante, `0444` per il gruppo; il runtime gira come `muffin`. Un agente compromesso **non può** riscrivere il RoT — è prevenzione.
- **Single-user (default senza privilegi)**: RoT `0444` di proprietà dello stesso utente + anchor + verifica al boot. Contro un agente con capability shell che gira come quell'utente questa è **rilevazione, non prevenzione**: il chmod è reversibile dal processo stesso. Conseguenza normativa: in modalità single-user la capability `sys.shell` è **sempre ASK** (mai ALLOW silenzioso) e il boot lo stampa a ogni avvio. Nessun documento pubblico dichiarerà "immutabile" per questa modalità.
- **Verifica a runtime (C4)**: watcher sui file del RoT; modifica rilevata mentre il processo gira → il runtime entra in **safe mode** (nega ogni capability ≥medium, continua a rispondere, avvisa l'owner) fino a riavvio verificato.

## 5. Config, secrets, directory (B3, B4, K5)

- **Config**: `~/.muffin/config.json`, `schemaVersion`, validato con zod al load. La CLI la scrive; Muffin la modifica via ratchet (M6). Un solo file: se cresce oltre il leggibile è un segnale che qualcosa doveva essere inferito e non configurato.
- **Secrets**: default **file cifrato age** `~/.muffin/secrets/secrets.age` (portabile, headless-safe, uguale su macOS e Linux — il Keychain è opt-in perché su sessione SSH il dialog di sistema blocca, C6); passphrase chiesta a `init` e tenuta in memoria dal runtime, oppure chiave in `~/.muffin/secrets/key.txt` `0400` per l'avvio non presidiato (trade-off dichiarato). Riferimento in config: `"apiKey": "secret://anthropic_api_key"`.
- **Directory (K5)**: non è XDG-multi-dir: è **una** cartella `~/.muffin/` (override `MUFFIN_HOME`). Il termine "XDG-compatibile" negli altri documenti va letto come "rispetta `XDG_CONFIG_HOME` se impostata per collocare la cartella", non come "sparge i dati in tre posti". Motivo: backup/export/cancellazione GDPR = un percorso.

## 6. Boot, init, doctor (C1, C2, C5)

**`muffin init`** (idempotente, resumibile): 1) crea/verifica `~/.muffin/` e sottocartelle → 2) installa RoT dai default del repo + scrive manifest e anchor → 3) chiede provider/endpoint/chiave (unica parte interattiva) e scrive config+secret → 4) (opz.) `--hardened` crea l'utente di servizio → 5) crea `muffin.db` con lo schema minimo (budget/audit; le tabelle memoria arrivano con M2) → 6) esegue `doctor` e stampa il riepilogo. Interruzione a metà: rilanciare `init` riprende dallo step non completato (ogni step è verificabile e ripetibile); `--force` reinstalla il RoT.

**Boot del runtime** (ordine vincolante, C2): (1) tracing exporter su file — per primo, così ogni fallimento successivo è tracciato; (2) config; (3) verifica RoT (fallimento → exit 78); (4) capability registry; (5) budget engine; (6) DB; (7) policy pronta; (8) M1: adapter modello + loop; (9) connector.

**`muffin doctor`** (C5): verifica presenza/permessi di `~/.muffin`, `schemaVersion` di ogni file, integrità RoT, modalità (hardened/single-user), presenza chiave **senza chiamate di rete** (`--online` per un ping da 1 token, opt-in perché costa), apertura DB, **sandbox funzionante** (da M3), spazio disco per i trace.

**Il check del sandbox esegue, non cerca** (lezione dal VPS attuale, 2026-08-04): `bwrap` presente nel PATH **non** significa sandbox funzionante — su Ubuntu 24.04+ il default `kernel.apparmor_restrict_unprivileged_userns=1` blocca gli user namespace che bubblewrap richiede, e il binario c'è comunque. `doctor` lancia un contenimento di prova reale (`bwrap --ro-bind / / --unshare-all --die-with-parent true`) **come l'utente che eseguirà il runtime** — mai come root, che aggira la restrizione e restituirebbe un falso positivo. Esiti: funziona / binario assente / **binario presente ma userns negato** (con il rimedio stampato: profilo AppArmor per `bwrap`, oppure il sysctl). Stesso principio su macOS: si prova `sandbox-exec`, non si assume che esista. Output human-readable + `--json` per gli script.

## 7. Errori e degradazioni (D1-D9)

| Situazione | Comportamento normativo |
|---|---|
| Chiave/endpoint mancante | Il runtime **parte** (M0 vive), il loop rifiuta di avviarsi con messaggio che nomina il campo mancante e il comando per impostarlo. In M0 puro il guard è nel loader di config (D1/K10). |
| Risposta modello malformata | Applica la `recovery` del profilo, in ordine, max 3 tentativi totali; poi errore utente esplicito ("il modello non ha prodotto una risposta valida dopo 3 tentativi") + span con l'ultima risposta raw. Mai fingere una risposta (D2). |
| Tool-call con nome inesistente | `reinjectTools` (se nel profilo) o tool_result di errore strutturato; conta come iterazione. |
| DB lockato | `busy_timeout = 5000` di default; oltre → errore esplicito, mai retry silenzioso infinito (D4). |
| Timeout tool | Default globale **60s**, sovrascrivibile per capability nella dichiarazione; il modello riceve un tool_result di errore; conta come iterazione (D5). |
| RoT manomesso a runtime | Safe mode (§4). |
| Budget esaurito | Il tool-call in corso **termina**; il loop non inizia una nuova iterazione; messaggio di sistema distinto dalla voce dell'agente (prefisso riservato in CLI, canale/formattazione dedicata negli altri connector). Notifica al primo superamento del periodo (D7). |
| `ASK` senza risposta | In CLI blocca sullo stdin del REPL; in headless (`muffin run`) `ASK` = **deny automatico** con exit code dedicato (nessuno può rispondere); timeout configurabile default 10 min (D8). |
| Sandbox assente (da M3) | Capability exec degradano ad ASK; `doctor` lo dichiara. |

Tutti i messaggi di sistema sono distinguibili dalla voce dell'agente (D9): mai mescolati nel testo della risposta.

## 8. Loop, stato, sessione (E3-E6, F1-F2, K1)

- **Streaming**: sì in CLI (REPL), no in headless (`muffin run` bufferizza per avere exit code e output pulito).
- **Stato del turno**: in RAM in M1; il transcript di sessione è persistito su `~/.muffin/sessions/<id>.jsonl` in append a ogni messaggio completo, così un crash perde al più il turno in corso, non la sessione (E4).
- **`DRAFT`**: tipizzato ma non esercitato in M0/M1 (nessuna capability di quei moduli lo usa) — dichiarato (E5).
- **Pre-loop in M1**: la funzione ha già i tre slot di V7; lo slot recall è un no-op che ritorna `[]` finché M2 non lo implementa (nessun cambio di firma dopo, F1).
- **K1 risolto — M1 ha i propri tool, M3 aggiunge quelli pericolosi**: M1 include tre primitivi dichiarati con capability (`fs.read`, `fs.list`, `fs.write` — scope: cwd del turno, deny paths del RoT applicati) e nessun accesso a rete/shell/processi. Ha senso senza sandbox perché in M1 **esiste solo il principal owner via CLI**: nessun input non fidato entra nel sistema prima di M4. M3 aggiunge `sys.shell`, `sys.process`, `net.egress`, MCP — **e nello stesso modulo il sandbox**, mai prima. Il DoD di M1 è quindi raggiungibile con lo scope di M1.
- **K2 risolto**: la "tool call di prova" di M0 è un test diretto su `decide()` + una capability finta registrata dal test, senza modello e senza loop.

## 9. Tracing (G1-G7, B7)

- **Span**: `muffin.turn` (radice) → `muffin.chat_call` (una per iterazione) → `muffin.tool_call` → `muffin.policy_decision` (figlia della tool_call, sempre emessa anche su allow).
- **Attributi**: `gen_ai.*` pinnati per modello/token/costo (mai reinventati); attributi propri sotto `muffin.*` (`muffin.principal.kind`, `muffin.tenant`, `muffin.capability`, `muffin.taint`, `muffin.policy.effect`, `muffin.policy.deny_code`) — namespace separato perché `gen_ai.*` è Development e potrebbe collidere (G7).
- **Pin (G2, K6)**: semconv GenAI **v1.42.0** (la prima con il repo scisso), pinnata in `core/tracing/SEMCONV_VERSION`. Aggiornamenti = PR deliberata con diff degli attributi.
- **Export (B7)**: JSONL su `~/.muffin/traces/YYYY-MM-DD.jsonl`, un file al giorno, scritto direttamente (nessun OTel Collector richiesto per l'uso locale). Grep-abile per il debug di M1 (G4); `muffin trace tail`/`muffin trace grep` nella CLI di M1. **Retention**: applicata al boot e a ogni rotazione giornaliera dal runtime stesso — non serve lo scheduler (G5).
- **Redazione (G6)**: denylist di nomi campo (`key|token|secret|password|credential|auth`) + valori che matchano pattern di chiave nota; i valori redatti diventano `«redacted:<len>»`.

## 10. CLI (H1-H8)

| Comando | Uso | Exit code |
|---|---|---|
| `muffin init [--hardened] [--force]` | bootstrap | 0 ok · 78 config non valida |
| `muffin doctor [--json] [--online]` | diagnosi | 0 tutto ok · 1 warning · 2 errore bloccante |
| `muffin` | REPL | 0 uscita pulita |
| `muffin run "<goal>" [--json] [--timeout s]` | headless | 0 completato · 3 ASK non risolvibile in headless · 4 budget esaurito · 5 floor/loop cap raggiunto · 1 errore |
| `muffin trace tail\|grep <pattern>` | debug | 0/1 |
| `muffin rot reinstall\|verify` | integrità | 0/2 |

**stdout/stderr (H3)**: stdout = solo la risposta finale (o JSON con `--json`); stderr = log, avvisi di sistema, prompt. **Sessione (H4)**: `muffin run` = thread effimero per invocazione (`--session <id>` per continuare); REPL = una sessione per lancio, `/new` per azzerare. **Ctrl+C (H5)**: primo = annulla il turno in corso (abort del `signal`, il REPL resta); secondo entro 2s = esce. **Librerie (H6, J-*)**: `commander` (CLI), `@inquirer/prompts` (init), `readline` nativo per il REPL v1 (Ink solo se il REPL cresce), `zod` (schemi), `@opentelemetry/api`+`sdk-trace-node` con exporter custom su file, `better-sqlite3` **già in M0** (budget e audit: J3), `@anthropic-ai/sdk` + `openai` per i due adapter, `age` via libreria JS per i secrets. Vietati: framework LLM/agentici, graph-engine, ORM.

## 11. Test (I1-I6)

- **Framework**: `vitest`.
- **CI di capability con modello vero (I1-I4)**: gira **solo** su push nel repo (non su PR da fork: i secret non ci sono per design) e in nightly; la PR da fork esegue tutto il resto. Costo dichiarato: budget CI separato (default $20/mese, cap hard nel workflow); il modello **consumer-locale** gira su un **self-hosted runner** dell'owner (la sua macchina), non su runner GitHub — dichiarato come prerequisito, non scoperto dopo.
- **Determinismo (I3)**: `temperature: 0`, seed dove supportato; ogni scenario ha assert **semantici** (il tool giusto è stato chiamato con l'argomento giusto), mai su stringhe esatte; 3 run, si richiede 3/3 per "passa" e si segnala 2/3 come flaky da investigare (mai promosso a pass).
- **Fixtures (I5)**: `evals/fixtures/<scenario>.json` = `{ id, prompt, tools: [...], expect: { toolCalls: [...], mustNotCall: [...], finalTextMatches?: string } }` — dati sintetici, zero informazione personale.

## 12. Contraddizioni chiuse (K1-K11)

K1 → §8 (M1 ha `fs.*`, M3 porta shell/rete/MCP col sandbox). K2 → §8. K3 → §8 (slot recall no-op). K4/C3 → §4 (due modalità, garanzia dichiarata per ciascuna). K5 → §5 (una cartella). K6 → §9 (v1.42.0). K7 → §3 (N=10, X=15, Y=32K, cap 40). K8 → glossario: **frontier** = la lane `deep`/il modello di riferimento alto della CI (Sonnet 5 in v1); **top-tier** = Opus 5/Fable 5 quando servono. K9 → **due lane persistenti** (`main`, `light`) + **una invocazione esplicita** (`deep`): non è una terza lane, è un'escalation richiesta dal loop. K10 → §7 (guard nel loader di config). K11 → §6 (il DB nasce in `init`, M0).
