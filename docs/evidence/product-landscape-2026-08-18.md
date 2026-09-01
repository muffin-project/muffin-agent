# Product / open-source landscape — 2026-08-18

> Snapshot volatile. Questa nota raccoglie fonti esterne che possono cambiare e
> non sostituisce le decisioni durevoli in `docs/OPEN-SOURCE-STRATEGY.md`.

## Domande

1. Qual è nel 2026 la barra competitiva per un personal agent self-hosted?
2. Cosa offre Telegram che può cambiare onboarding/surface design?
3. Quali primitive privacy locali sono già disponibili per chi usa API cloud?
4. Cosa manca alla repo per diventare un open source usabile e contribuibile?
5. Quali assunti della tesi vanno aggiornati perché gli incumbent stanno
   migliorando memoria/personalizzazione?

## 1. Distribuzione self-hosted: la barra si è alzata

### Hermes Agent

Fonti:

- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md
- https://hermes-agent.nousresearch.com/docs/
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/contributing.md
- https://github.com/NousResearch/hermes-agent/security

Osservazioni al 2026-08-18:

- installer desktop raccomandato su macOS/Windows;
- one-liner Linux/macOS/WSL2 che provisiona dipendenze, checkout, ambiente e
  provider configuration;
- percorso contributor distinto dal percorso utente;
- gateway/messaging come layer successivo a una chat base funzionante;
- CONTRIBUTING e security policy pubblica;
- priorità contribution esplicite: bug, compatibility, security, robustness
  prima di nuove primitive core.

Lezione per Muffin: self-hosted non giustifica clone + toolchain come UX
raccomandata. Un installer consumer è parte del prodotto.

### OpenClaw

Fonti:

- https://docs.openclaw.ai/install
- https://github.com/openclaw/openclaw/blob/main/docs/install/installer.md
- https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md
- https://github.com/openclaw/openclaw/blob/main/SECURITY.md

Osservazioni:

- installer che rileva OS, installa Node quando manca e lancia onboarding;
- daemon/gateway come parte del wizard;
- control UI dopo onboarding;
- source install separato per contributor;
- security policy molto esplicita sul trust model;
- feature/architecture contributions partono da issue/discussione, piccoli fix
  possono arrivare direttamente;
- maintainer aggiunti lentamente dopo contributi osservati.

Lezione: prima di aprire Muffin servono confini contribution/support/security;
non serve cercare co-maintainer prima del dogfood.

## 2. Telegram è diventata una piattaforma personal-agent

Fonti:

- Managed Bots: https://core.telegram.org/api/bots/managed-bots
- Bot API changelog: https://core.telegram.org/bots/api-changelog
- Bot features: https://core.telegram.org/bots/features
- Mini Apps: https://core.telegram.org/bots/webapps

### Managed Bots

Dal Bot API 9.6 (3 aprile 2026) Telegram supporta:

- richiesta/creazione di managed bots;
- evento `managed_bot_created`;
- `getManagedBotToken` e `replaceManagedBotToken`;
- deep link `https://t.me/newbot/{manager_bot_username}/...`.

MTProto documenta che il bot creato è posseduto dall'utente ma può essere
amministrato anche dal manager bot. Non è stata trovata nella documentazione
consultata una primitive di detach permanente del manager.

Implicazione: `@MuffinCommanderBot` è plausibile come onboarding/bootstrap, ma
non è equivalente al setup sovrano finché il manager conserva authority.
Runtime e DB restano owner-run.

### Altre primitive Telegram 2026

La piattaforma sta aggiungendo capability utili a Muffin (topic privati, Mini
Apps, modalità in cui il bot entra selettivamente in conversazioni, gestione più
ricca delle risposte AI). La conclusione durevole non è "Muffin dipende da
Telegram" ma "Telegram è una surface primaria iniziale che vale la pena
sfruttare in profondità finché resta il miglior client".

## 2-bis. Fonti personali: API quando conviene, export quando riduce l'attrito

Fonti Google:

- Gmail messages list: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Gmail history list: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- Gmail watch: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Gmail OAuth scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google Takeout: https://support.google.com/accounts/answer/3024190

Gmail offre sia lettura incrementale (`messages.list`/`history.list`) sia watch
per notificare cambiamenti. Quindi una source continua è tecnicamente naturale.
Il costo prodotto non è il polling: è l'autorizzazione pubblica.

Al 2026-08-18 `gmail.readonly`, `gmail.modify`, `gmail.metadata` e altri scope
ampi sono **restricted**. Una public app che li usa deve affrontare OAuth app
verification; se dati ottenuti da restricted scopes vengono memorizzati o
trasmessi su server dello sviluppatore, Google richiede anche security assessment
nelle condizioni indicate dalla propria policy.

Per Muffin questo rafforza la forma owner-run:

- token OAuth e dati acquisiti vivono sull'installazione dell'owner;
- eventuale servizio centrale serve al massimo come bootstrap OAuth dove la
  piattaforma lo richiede, non come data plane;
- scope minimi per capability (read personalization ≠ send mail);
- BYO OAuth client può restare escape hatch per utenti avanzati/test;
- per alpha o fonti con OAuth pesante, import da export ufficiale (es. Google
  Takeout) è una strada di cold-start valida e spesso più facile da distribuire.

Quindi "API first" non significa "API a qualunque costo": scegliamo il percorso
che dà all'owner più continuità con meno authority e meno infrastruttura centrale.

## 3. Privacy prima di un provider cloud

### Rizzo PII

Fonti:

- https://github.com/Rizzo-AI-Academy/rizzo-pii
- https://rizzo-ai-academy.github.io/rizzo-pii/

Snapshot:

- modello locale ≈0.3B, CPU-friendly;
- italiano-first, orientato anche a testo legale;
- 22 classi PII, inclusi identificatori italiani;
- workflow reversibile: dato reale → placeholder locale → provider → restore
  locale;
- build desktop Windows/macOS/Linux.

Valutazione per Muffin: ottimo candidato ad adapter facoltativo per installazioni
italiane/API cloud. Non hard dependency e non security boundary universale.

### OpenAI Privacy Filter

Fonti:

- https://openai.com/index/introducing-openai-privacy-filter/
- https://github.com/openai/privacy-filter

Open-weight PII detector eseguibile localmente. È un'altra ragione per non
incorporare un detector specifico nel loop: serve un'interfaccia privacy
pluggable.

### Limiti della redaction

Fonti di ricerca:

- RedactionBench, arXiv:2606.18782
- LLM-Redactor, arXiv:2604.12064

Risultato importante: la redaction contestuale non è un problema risolto e nessun
singolo metodo domina. Local routing + redaction/trasformazione possono ridurre i
leak, ma non rendono vera la frase "nessun dato sensibile può uscire" per testo
arbitrario.

Decisione conseguente:

- secret conosciuti: garanzia strutturale separata;
- PII: privacy transform facoltativo con limiti visibili;
- dati marcati local-only: routing locale, non detector best-effort.

## 4. Community health e sicurezza open source

Fonti GitHub ufficiali:

- https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions
- https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors
- https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file
- https://docs.github.com/en/code-security/getting-started/quickstart-for-securing-your-repository

GitHub tratta come community-health primitives almeno CONTRIBUTING,
CODE_OF_CONDUCT, SECURITY, support/issue templates e license. Per repository
pubblici sono inoltre disponibili dependency/security tooling, secret scanning e
CodeQL/configurazioni equivalenti.

Snapshot Muffin `dev` al 2026-08-18:

- `LICENSE` presente;
- README presente;
- PR template presente;
- CI presente;
- `AGENTS.md` molto ricco;
- **nessun `CONTRIBUTING.md` root**;
- **nessun `SECURITY.md` root**;
- nessuna issue-template directory in `.github/`;
- package ancora `private: true`, versione `0.0.0`;
- install raccomandato dal README = clone + Node >=22 + `./install.sh`;
- `install.sh` esegue `npm install`/compile e PATH setup: buono come dev/pre-alpha,
  non come percorso consumer.

Quindi la repo non è "fatta male": è ancora una repo privata di costruzione.
Renderla pubblica senza uno strato di distribution/community la farebbe sembrare
più immatura del core che contiene.

## 5. Il moat non può essere solo memoria + local-first

Hermes dichiara già un modello dell'utente che si approfondisce nel tempo;
OpenClaw è local-first/always-on e offre gateway/surface; incumbent commerciali
stanno rapidamente migliorando personalizzazione e memoria cross-product.

Conclusione: "il vendor non potrà mai conoscermi" è una difesa troppo debole.
La differenza più resistente è:

> continuità personale **sovrana, portabile e verificabile** che sopravvive a
> provider, modello, device, surface e runtime.

Questo sposta il moat da "ho memoria" a qualità e ownership della continuità:
provenance, work dovuto, effects, authority, correzioni, storia temporale,
portabilità e indipendenza dai vendor.

## 6. Due finding tecnici da non perdere

### Provider-as-egress

Il loop invia al provider system prompt + history + recall + work + tool result.
Con un provider remoto questi dati escono dalla macchina prima di qualsiasi
`sys.http` del modello.

Serve quindi modellare/dichiarare il provider come destinatario privilegiato del
context. Per Day 1 può essere una decisione owner esplicita; la forma futura deve
supportare almeno `cloud-allowed` vs `local-only` e privacy transform facoltativo.

### MCP process containment

Il pinning degli MCP tool protegge da cambiamenti di definizione/rug pull, ma
`StdioClientTransport` lancia un processo locale. Se quel processo non è
contenuto, può potenzialmente usare filesystem/rete direttamente, fuori dal
policy kernel delle singole tool call.

Prima di presentare MCP terzi come capability sicura serve dichiarare se sono:

- trusted local code; oppure
- processi con filesystem/network/secret capability manifest e containment.

Se MCP terzi vengono usati nel dogfood, è una questione Gate 1; altrimenti è
pre-public-release.

## 7. Strategia di apertura consigliata

1. Gate 1 owner.
2. 14 giorni reali.
3. Trusted alpha con 2–5 persone selezionate per OS/packaging/security.
4. Public alpha quando install/update/backup/security disclosure sono
   comprensibili a un estraneo.
5. Maintainer soltanto dopo contributi ripetuti e affidabili.

Non usare un mega-prompt one-shot per chiudere Gate 1: il repository è già la
memoria del programma di lavoro. One-shot solo per slice bounded.

## 8. Cose da rivalidare più avanti

- se Telegram aggiunge un detach del manager per Managed Bots;
- maturità A2A e MCP Tasks;
- benchmark/privacy model migliori di Rizzo/OPF;
- installer/support matrix dei competitor;
- policy dei provider cloud su retention/training;
- formato canonico di export/import Muffin;
- forma della GUI/control plane;
- browser/computer-use scelto dopo i 14 giorni, guidato dai fallback reali.