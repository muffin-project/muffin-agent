# ADR-0114 — Registro unico delle impostazioni e raccolta segreti fuori-chat

**Stato: architettura approvata dall'owner il 2026-11-26 (Europe/Rome).**
Questa PR è solo il documento: **zero cambiamento runtime**. Profilo di
verifica **CRITICAL** (configurazione, segreti, Root of Trust, superfici).

Numero: **0114** era il prossimo libero su tutti i rami remoti al momento
della stesura (`node docs/decisions/prossimo-numero.mjs`). **0113** è già
preso sul ramo `feat/xai-oauth-login`
(`docs/decisions/0113-login-xai-con-oauth.md`).

Emenda ADR-0070, ADR-0058 e ADR-0035: il testo originale di quei documenti
resta; gli emendamenti stanno in coda. Si appoggia ad ADR-0048, ADR-0109,
ADR-0011, ADR-0050 e alla direttrice #516 (S4).

## Contesto

Le manopole di Muffin vivono sparse (`config.json`, `rot/budgets.json`,
`rot/egress.json`, secret store, `user.md`). Il nucleo condiviso esiste ma
è piccolo: `core/config/settings.ts::setConfigKnob` (ADR-0070) espone due
voci (`traces.retentionDays`, `search.maxResults`) a tre porte (CLI, REPL,
Telegram), intercettate prima del turno e solo per
`principal.kind === 'owner'`. I comandi `muffin model`, `muffin fallback`,
`muffin search`, `muffin auth` e gli altri restano implementazioni
separate. `muffin status` / `collectStatus` (PR #1043) è di sola lettura
ma vive in `cli/`, quindi Telegram non può riusarlo senza far importare
`cli/` ad `agent/`.

ADR-0070 ha stabilito che *«il modello non deve poter cambiare le
impostazioni»* e ha scartato un tool `config.set`. Lasciava già aperta una
porta: *«il giorno in cui l'owner vorrà "Muffin regola le impostazioni
conversando", quella riga della matrice è già lì»* (`config` in
`core/policy/matrix.ts`, oggi senza `CapabilityDecl`).

L'owner, il 26/11/2026, ha deciso tre cose insieme:

1. **Parità totale e un solo motore.** Tutto ciò che si fa dal terminale
   deve potersi fare da Telegram. Un registro unico di azioni alimenta
   quattro porte, senza implementazioni scollegate: menu `muffin settings`
   / `/settings` nel terminale; menu `/settings` su Telegram; i
   sottocomandi CLI esistenti come adattatori sottili; la richiesta in
   conversazione («imposta xai come fallback», «alza il budget», «spegni
   gli embedding»).
2. **`muffin settings`** entra nell'aiuto principale al posto di
   `model` / `fallback` / `search`, che restano alias funzionanti.
3. **I segreti non transitano mai** da un messaggio di chat né dal
   contesto del modello. Prima si usa OAuth o il provisioning nativo del
   provider; se serve una chiave manuale, entra da un input mascherato
   fuori banda. L'incolla in chat, anche seguito da `deleteMessage`, è
   fuori percorso.

Il pannello web locale di impostazioni su `127.0.0.1` resta rimandato a
dopo un periodo d'uso reale (#863). Non è il form effimero di raccolta
segreti descritto sotto.

## Ricerca (26 novembre 2026)

Fonti primarie, consultate prima della decisione:

- OWASP Top 10 for LLM Applications 2026, *LLM03:2026 Excessive Agency*
  (era LLM06:2025):
  <https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/>
- OWASP AI Agent Security Cheat Sheet — separare decisione ed esecuzione,
  approvare l'azione esatta, artefatti di breve vita, fail-closed; un flag
  `user_confirmed` messo dal modello non basta:
  <https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html>
- OWASP Prompt Injection Prevention:
  <https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html>
- MCP Elicitation (2026-07-28) — i segreti non passano in *form mode*,
  solo in *URL mode*:
  <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>
- MCP Authorization (2026-07-28) — OAuth 2.1; i client dovrebbero usare
  Client ID Metadata Documents; Dynamic Client Registration (RFC 7591) è
  deprecato in quel revision e resta come ripiego:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>
- OpenRouter OAuth PKCE — lo scambio di un `code` + `code_verifier` produce
  una API key *dell'utente*; il code da solo non basta:
  <https://openrouter.ai/docs/guides/overview/auth/oauth>,
  <https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key>
- OAuth 2.0 Device Authorization Grant (RFC 8628):
  <https://www.rfc-editor.org/rfc/rfc8628.html>
- Telegram Mini Apps — `initData` si valida sul server (HMAC-SHA-256 del
  token bot con chiave `WebAppData`, `auth_date` fresco);
  `Telegram.WebApp.sendData` consegna un `Message.web_app_data` e transita
  dai server Telegram:
  <https://core.telegram.org/bots/webapps>
- Tailscale Serve — HTTPS sul *solo* tailnet verso `127.0.0.1`; Funnel è
  pubblico. I nomi macchina compaiono nel ledger CT:
  <https://tailscale.com/docs/features/tailscale-serve>,
  <https://tailscale.com/docs/how-to/set-up-https-certificates>
- OpenClaw `secrets` — il tool non ha un parametro valore; l'input è un
  prompt mascherato; il valore non entra in chat, transcript o contesto:
  <https://docs.openclaw.ai/tools/secrets>
- Hermes Secret Guard — dialog nativo, niente parametro valore, una chiave
  incollata in chat è intercettata prima dell'inferenza:
  <https://hermes-agent.nousresearch.com/marketplace/secret-guard>
- Pattern già in casa: approvazioni monouso legate alla chiamata esatta
  (ADR-0109, PR #1017, `core/approvals/store.ts`); OAuth PKCE OpenRouter e
  ChatGPT con callback su `127.0.0.1` (`core/config/openrouter-oauth.ts`,
  `core/config/chatgpt-oauth.ts`); `writeAuthoritativeSecret` e il
  confine di `readSecret` (ADR-0048).

Il pattern comune: un solo registro di azioni, più porte; il modello
propone; l'host conferma ed esegue, legando il sì alla chiamata esatta;
i segreti entrano fuori banda e non passano dal contesto del modello né
dalla cronologia di una chat.

## Decisione

### 1. Un registro unico delle azioni

Un catalogo dichiarativo vive in `core/` (evoluzione di `Knob` /
`setConfigKnob`, file previsto `core/config/actions.ts`). Ogni azione ha
un `id`, una sezione, uno schema dei parametri, una categoria, e due
verbi: `plan()` (produce un piano prima → dopo, file, impatto; **non
scrive**) e `commit()` (scrive solo dopo una prova di approvazione
dell'host già verificata e consumata). `setConfigKnob` resta e diventa
un adattatore sulle manopole già esposte.

Categorie, che il cancello applica al piano concreto (un ramo che
allarga rende l'intero piano `widen`):

| Categoria | Ruolo |
|---|---|
| `read` | Sola lettura, nessun segreto in chiaro. Nessuna conferma. |
| `restrict` | Restringe autorità o tetti. Un tap / un invio, con diff. |
| `widen` | Allarga autorità, tetti, superfici, egress, anelli pagati. Conferma esplicita ogni volta, mai «sì a tutto». |
| `secret-oauth` | Avvio di OAuth / MCP OAuth 2.1 / provisioning nativo. Nessun valore segreto nei parametri. |
| `secret-intake` | Avvio della raccolta mascherata fuori banda. Il modello propone solo l'avvio (slot, canale); il valore non è un parametro. |

### 2. Quattro porte, le stesse funzioni

1. I sottocomandi CLI esistenti (`model`, `fallback`, `search`, `auth`,
   `config set`, …) diventano adattatori sottili: parsano argv, chiamano
   `plan`, chiedono conferma TTY quando serve, poi `commit`.
2. `muffin settings` (e `/settings` nel REPL) è il wizard a sezioni,
   con lo stesso `read()` di `muffin status`.
3. Telegram `/settings` e `/status` sono intercettati in `resolve()`
   **prima del turno**, owner-only, zero costo, come `/model` oggi. I
   callback li gestisce l'host, mai il loop. Solo nella chat privata
   dell'owner.
4. In conversazione l'unica `CapabilityDecl` nuova è
   `propose_setting_change`. Non esiste `execute_setting_change`.

`collectStatus` si sposta in `core/` in una slice successiva, perché
`agent/` non importa da `cli/`. Nell'aiuto principale compare
`muffin settings`; `model`, `fallback` e `search` restano dispatchabili
e visibili in `muffin help --all`.

### 3. Il modello propone, l'host conferma ed esegue

Il modello non esegue mai una scrittura di impostazioni. Può solo
invocare `propose_setting_change` con un `actionId` del registro e
parametri che l'host valida sullo schema **prima** di registrare una
proposta. Il cancello è deterministico e sta fuori dal controllo del
modello, sullo stesso disegno di ADR-0109:

- l'approvazione è legata a `actionId + paramsDigest + principal +
  surface`; un sì su parametri o stato cambiati non vale;
- consumo monouso (`consumed_at`), nella stessa transazione dell'intent;
- si mostra il **piano dell'host** (prima → dopo, file, impatto, taint),
  non un riassunto del modello;
- un «sì» / «ok» in testo libero **non** autorizza;
- yolo e la delega **non** consumano un ask di impostazioni
  (`decided_by` solo `'owner'`);
- se il turno ha taint ≥ 2 (gruppo/sconosciuto o contenuto esterno),
  una proposta `widen`, `secret-oauth` o `secret-intake` non è
  approvabile in linea: si ripete da `/settings` o da un DM pulito;
- fail-closed se digest, policy, scadenza o audit non tornano.

La riga `config` della matrice resta `asksForIrreversible: true` e
`denyAbove: 1`. `config.*` resta in `MAI_CONCEDIBILI`. Nessun tool sotto
`agent/tools/` importa `commit`, `saveConfig`,
`writeAuthoritativeSecret` o `widenEgressForCapability`: un test di
layering lo vieta (simmetrico a `core/layering.test.ts`).

### 4. Gerarchia di connessione e raccolta segreti fuori-chat

Prima di chiedere all'owner di digitare una chiave, il registro prova,
per quel servizio, il gradino più alto disponibile:

1. **OAuth o provisioning nativo del provider** (già in casa: OpenRouter
   PKCE e ChatGPT login; Device Grant RFC 8628 quando il provider lo
   offre). Lo scambio lo fa il gateway; la chiave o il token finiscono
   in `writeAuthoritativeSecret`, mai in `config.json`, mai in una
   traccia, mai in un messaggio.
2. **MCP OAuth 2.1** per i server HTTP che lo supportano, quando arriverà
   (oggi `muffin mcp add` usa `--env K=secret://nome` e non ha OAuth).
   Priorità della specifica 2026-07-28: pre-registrazione se già c'è;
   altrimenti Client ID Metadata Documents; Dynamic Client Registration
   solo come ripiego. I server STDIO prendono le credenziali
   dall'ambiente, cioè dal secret store, mai da argv.
3. **Raccolta mascherata fuori banda**, solo se i gradini 1–2 non
   esistono per quel servizio. Tre canali, tutti verso
   `writeAuthoritativeSecret`; alla chat arriva al massimo *«chiave
   salvata»*:
   - **C** — prompt mascherato nel terminale (`promptSecret` /
     `muffin secret set`, valore solo da stdin, già ADR-0048).
   - **A** — form mascherato monouso su
     `http://127.0.0.1:<porta>/s/<token>` (scadenza breve, CSRF, input
     `password`). Il POST va dritto al gateway.
   - **B** — lo stesso form raggiunto via HTTPS sulla rete privata
     (Tailscale Serve verso quel loopback, **mai Funnel**). Una Mini App,
     se c'è, fa POST diretto con il token monouso e `initData` validato
     sul gateway (`user.id === ownerUserId`). **È vietato**
     `Telegram.WebApp.sendData` e ogni percorso che consegni il segreto
     come `web_app_data` o come messaggio al bot.
4. **Mai** incollare il segreto in una bolla Telegram, in un tool
   argument, in un log o in un turno.

Lo store, oggi, è un file `0600` in due backend (`home` e `persistent`):
permessi del filesystem, non cifratura a riposo. Age o Keychain restano
il gap dichiarato di ADR-0011; si potranno mettere dietro
`writeAuthoritativeSecret` senza cambiare le porte. I capability Node
(ADR-0050) non sono ancora runtime: i segreti restano sulla Home.

### 5. Cosa non è questa decisione

- Nessun cambiamento runtime in questa PR.
- Il pannello web di impostazioni (#863) non si costruisce qui. Il form
  `/s/<token>` è un endpoint effimero, un solo scopo, vita pari al token.
- Discord resta senza livello comandi, come già dichiarato in ADR-0070,
  finché quel connector non lo acquisisce per intero.

## Alternative scartate

**Cinque implementazioni scollegate** (un menu CLI, un menu Telegram, i
verbi storici, un tool conversazionale, un form ciascuno per i segreti).
È esattamente il difetto che l'owner ha chiesto di non ripetere.

**Incollare la chiave in chat Telegram e cancellarla con `deleteMessage`.**
La cancellazione è best-effort (messaggi < 48 ore, chat privata) e non è
un oblio: il valore è già transitato dai server Telegram. L'owner l'ha
esclusa.

**Un tool `config.set` che esegue la scrittura**, anche gated da `ask`.
Il modello deciderebbe di scrivere. Resta la proposta tipizzata; l'esecuzione
è dell'host.

**Tunnel pubblico, Tailscale Funnel, o `sendData` della Mini App** per
consegnare un segreto. Allargano la superficie o fanno transitarlo da
Telegram.

**Costruire il pannello web di impostazioni in questa fase.** L'owner lo
ha rimandato; il form `/s/<token>` non lo anticipa.

## Conseguenze

- ADR-0070, ADR-0058 e ADR-0035 ricevono un emendamento in coda, non una
  riscrittura. Il principio «il modello non scrive le impostazioni» e
  «il reseal è la parola dell'owner» restano; cambia *come* l'owner dà
  quella parola (terminale o pulsante monouso autenticato) e *come* il
  modello può *proporre*.
- Le slice successive, ciascuna con review indipendente e CI verde,
  partono da questo ADR: registro e spostamento di `collectStatus`;
  wizard `muffin settings`; sezioni con OAuth e opzioni C+A; `/status` e
  `/settings` su Telegram; opzione B e MCP OAuth 2.1 come follow-on;
  infine `propose_setting_change`, solo dopo che le altre porte scrivono
  già dalla stessa funzione.
- Un listener HTTP on-demand su `127.0.0.1` per `/s/<token>` (e i
  callback OAuth già esistenti) è un'eccezione stretta ad ADR-0035, non
  un gateway di rete.

## Come si falsifica

Questa PR, che non tocca il runtime:

- `docs/decisions/adr.test.ts`: il numero 0114 non è condiviso; la prima
  riga del file dichiara `ADR-0114`.
- Il diff non contiene file fuori da `docs/decisions/`.

Le slice successive, quando arriveranno, devono avere almeno: un test di
layering che vieta a `agent/tools/` di importare `commit` e i sink
privilegiati; un non-owner che non ottiene risposta da `/settings`;
nessun segreto in output, tracce, diario, callback o messaggi; un
`widen` senza conferma che non scrive; un token di intake riusato o
scaduto che viene rifiutato; un listener di A che rifiuta `0.0.0.0`;
nessun percorso di raccolta che chiami `sendData`.
