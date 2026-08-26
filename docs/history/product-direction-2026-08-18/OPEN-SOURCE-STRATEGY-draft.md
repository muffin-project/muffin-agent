# Strategia open source, distribuzione ed ecosistema

> **Stato: VIVO · decisione owner 2026-08-18.**
> Questo documento definisce la forma del prodotto quando Muffin smette di essere
> una sola installazione privata e diventa un progetto open source usabile da
> altre persone. `docs/THESIS.md` resta la scommessa; `docs/foundations/VISION.md`
> resta la nord-stella; `docs/blueprint/M5-BIS.md` decide esclusivamente il Gate 1
> dell'owner. Qui si decide come non perdere quella forma quando arrivano utenti,
> installer, integrazioni, contributor e servizi opzionali.

## 1. Il confine del prodotto

Muffin resta **owner-run**.

Una installazione = un agente logico + un substrato personale sotto il controllo
relativo owner. Il progetto non richiede che l'infrastruttura di Muffin ospiti il
runtime, la memoria, i turni o il database degli utenti.

Forma di default:

```text
surface / control plane
          │
          ▼
   Muffin dell'owner
          │
   ┌──────┼────────┐
 memory  work   secrets/policy
          │
 macchina / home node / VPS dell'owner
```

**Infrastruttura centrale può semplificare la nascita; non deve essere necessaria
alla vita.** Download, metadata di release, documentazione, un eventuale relay di
bootstrap o un CommanderBot possono essere servizi centrali. Un Muffin già
installato deve continuare a vivere se quei servizi spariscono.

Non costruiamo per default:

- un runtime SaaS multi-tenant che esegue tutti i Muffin;
- un database centrale con le memorie degli owner;
- un control plane obbligatorio per continuare a parlare con l'agente;
- una persona/policy diversa per ogni surface.

Un eventuale hosted Muffin futuro sarebbe un **prodotto diverso**, con threat
model, economics e tesi diversi. Non entra accidentalmente per comodità di
onboarding.

## 2. Self-hosted non significa developer-only

Il fatto che l'owner esegua Muffin non autorizza un'esperienza di installazione da
sviluppatore.

Il target pubblico è consumer-grade:

```text
scarica / installa
→ scegli come far ragionare Muffin
→ configura o collega il provider
→ scegli le surface
→ abilita l'avvio automatico
→ parla con Muffin
```

Node, npm, systemd, launchd, SQLite, token, secret store e schema sono dettagli
interni. Il repository può continuarli a usare; l'utente normale non deve sapere
che esistono per completare un'installazione standard.

Profili di distribuzione previsti:

1. **Desktop** — Mac/PC dell'owner; il percorso più semplice.
2. **Home node** — mini-PC/NAS/Raspberry/box sempre acceso dell'owner.
3. **Own VPS** — macchina remota pagata e controllata dall'owner.
4. **Future appliance** — hardware dedicato che resta una porta sullo stesso
   agente, non un secondo Muffin.

Il percorso da source clone rimane per contributor e utenti avanzati; non è il
percorso prodotto.

### Control plane locale

Una GUI futura non deve rimpiazzare Muffin come interlocutore. È il cofano quando
serve aprirlo:

- stato runtime/gateway;
- provider e modello correnti;
- spesa;
- work aperto, waiting e approval;
- surface;
- backup/update/rollback;
- capability e authority;
- MCP/plugin/skill;
- diagnostica e self-inspection.

La chat può restare su Telegram, voce o altra surface. La GUI esiste perché
l'owner possa capire e governare il sistema senza usare il terminale.

## 3. Personalizzazione: collegare prima, importare quando non si può

Muffin non deve aspettare anni per conoscere abbastanza l'owner da essere utile.
La continuità profonda si accumula nel tempo, ma il **cold start** può essere
ridotto importando storia già esistente.

Ordine:

1. **connector/API/MCP affidabile** quando la piattaforma espone un accesso
   appropriato;
2. **export ufficiale della piattaforma** quando l'accesso continuo non esiste o
   non è desiderato;
3. **nudge guidato**: Muffin spiega all'owner come scaricare i propri dati e
   importarli;
4. parsing ad-hoc solo quando la fonte è stabile e il valore giustifica il costo.

Esempi: Gmail, Calendar, Contacts, Drive, Photos, browser history, chat export,
health/fitness, code history, file archive.

L'import non deve trasformare un dump in verità. Ogni record conserva almeno:

- fonte originale;
- timestamp originale quando disponibile;
- data di import;
- principal/owner a cui appartiene;
- provenance/trust;
- distinzione tra evidenza, derivato e inferenza.

Un'importazione può accelerare la conoscenza; non può falsificare la sequenza
storica facendo sembrare osservato oggi ciò che proviene da cinque anni fa.

## 4. Portabilità: il moat è la continuità, non SQLite

La continuità non è `muffin.db` e non è un embedding model.

Distinguiamo due categorie.

### Canonico / da preservare

- evidenza e origine;
- episodi/eventi;
- correzioni e supersessioni;
- identità e costituzione;
- authority/grant espliciti;
- lavoro e promesse ancora dovute;
- effect journal e conseguenze osservate;
- decisioni dell'owner;
- tombstone/forget intent necessari a rispettare cancellazioni.

### Derivato / ricostruibile

- embedding;
- vector index e FTS;
- summary;
- ranking e activation;
- cache;
- materialized view;
- belief derivata quando la sua evidenza canonica esiste ancora.

Gli indici non sono immortali. Il **significato portabile** lo è.

Prima di una release pubblica stabile serve quindi un export canonico versionato
("Muffin Capsule" è un nome di lavoro, non un formato deciso) da cui una nuova
versione possa ricostruire gli indici senza perdere storia, provenance, work,
effects e governance.

Il test di portabilità non è "copio il DB e parte". È:

> una versione futura, su una macchina diversa e con un modello diverso, importa
> il patrimonio dell'owner e continua senza riscriverne la storia.

## 5. Dimenticare è una capability dell'owner

La storia è append-oriented, non "la vita umana è append-only".

Servono due proprietà contemporaneamente:

- audit e correzioni non vengono riscritti silenziosamente;
- l'owner può ordinare che un dato non sia più conservato o recuperabile.

Una cancellazione può lasciare metadata/tombstone necessari a evitare
resurrezioni o a spiegare che qualcosa è stato rimosso, ma non deve usare
"auditability" come scusa per conservare per sempre il contenuto che l'owner ha
chiesto di dimenticare.

La semantica precisa di forget/export/retention è una decisione di forma da
chiudere prima della prima release pubblica stabile.

## 6. Il provider è compute e anche egress

Quando Muffin usa un modello API, il provider riceve il context inviato al
modello. Quindi un provider remoto non è soltanto "il cervello": è un
**destinatario privilegiato di dati**.

Questo deve essere esplicito e ispezionabile.

Forma concettuale:

```text
data/context
   │
   ├─ local-only ───────────────→ modello locale
   │
   └─ cloud-allowed
          │
          ├─ optional privacy transform
          ▼
      provider autorizzato
```

Per il Gate 1 può bastare che l'owner dichiari consapevolmente che il provider
configurato è autorizzato a ricevere il model context. La forma futura deve
permettere policy più fini, incluso contenuto `local-only`.

### Privacy transform facoltativo

Per installazioni che usano API cloud, Muffin può offrire un layer locale
facoltativo di anonimizzazione/redazione reversibile prima del provider.

Requisiti:

- pluggable: non hard dependency del core;
- eseguito localmente;
- mapping di re-identificazione locale;
- provider vede placeholder/surrogati, non il valore originale quando il detector
  lo riconosce;
- limitazioni dichiarate: nessun detector PII è una garanzia universale;
- opt-in per policy/installazione o per classe di contenuto;
- compatibile con local-only routing.

**Rizzo PII** è un candidato interessante soprattutto per italiano e documenti
legali: modello locale CPU-friendly, 22 classi PII e sostituzione reversibile.
Non va trattato come soluzione universale. Un adapter deve poter ospitare anche
altri detector (per esempio OpenAI Privacy Filter open-weight o alternative
future) senza cambiare il loop.

Non confondere questo layer con il secret boundary: i secret conosciuti da Muffin
restano strutturalmente esclusi dal data plane; non dipendono da un detector PII.

## 7. Capability ed estensioni: core stretto, ecosistema largo

L'open source esploderà il numero di richieste. Il core non deve diventare la
somma dei desideri degli utenti.

Principio:

> il core contiene le primitive e le garanzie che devono comporre; capability
> specifiche vivono ai bordi quando possono farlo.

Preferenza indicativa:

```text
core primitive / durable contract
      ↓
connector · skill · plugin · MCP/A2A adapter
      ↓
use case
```

Un nuovo provider, una piattaforma o un workflow non diventa automaticamente una
nuova primitive core.

### MCP: trust del tool ≠ containment del processo

Il pinning di nome/descrizione/schema difende dal rug-pull semantico. Non rende il
processo MCP innocuo.

Un server MCP locale è codice terzo che gira sull'host. Prima di considerare
MCP terzi una capability pubblica sicura serve una risposta esplicita a:

- filesystem leggibile/scrivibile;
- rete raggiungibile;
- secret che riceve;
- processo/utente sotto cui gira;
- capacità di bypassare il kernel fuori dal protocollo MCP.

Se non è contenuto, va descritto come **trusted local code**, non come tool
sandboxato. Per il dogfood Day 1, se l'owner usa MCP terzi, questa domanda entra
nel Gate 1; altrimenti può restare disabilitato fino al containment.

## 8. Telegram: surface primaria iniziale, non dipendenza identitaria

Telegram nel 2026 offre primitive particolarmente adatte a un personal agent:
managed bots, topic privati, Mini Apps, guest/secretary modes e comunicazione fra
bot. Le sfruttiamo quando rendono Muffin più naturale senza spostare memoria,
identità o authority dentro Telegram.

### Setup sovrano

L'owner crea/possiede il proprio bot; il token vive solo nel secret backend della
propria installazione. Nessuna infrastruttura Muffin mantiene authority sul bot.

### Setup managed / convenience

Un eventuale `@MuffinCommanderBot` può usare Managed Bots per rendere la
creazione quasi one-tap. Questo è **bootstrap**, non hosting:

```text
CommanderBot → crea bot personale → collega installazione owner-run
```

Non ospitiamo runtime o DB degli utenti. Finché Telegram non offre una semantica
chiara di detach del manager, la modalità managed deve dichiarare che il manager
mantiene poteri amministrativi sul bot e non può essere venduta come equivalente
al setup sovrano.

### Possibili evoluzioni

- topic privati = work context/session view diverse sullo stesso Muffin;
- Mini App = activity/control plane dentro Telegram;
- Guest Mode = "porta Muffin qui" senza aggiungerlo permanentemente;
- Secretary Mode = outward messaging per conto dell'owner, solo con authority e
  effect safety adeguate;
- bot-to-bot = transport possibile, non protocollo cognitivo proprietario.

L'interoperabilità fra agenti deve preferire standard aperti (A2A/MCP dove
appropriato) ad un MuffinProtocol inventato per necessità locale.

## 9. Cosa costruire dopo il Day 1

Durante i quattordici giorni la fonte principale di roadmap diventa il fallback
reale.

Ogni volta che l'owner torna a un altro agente/app perché Muffin non può fare
qualcosa, registriamo:

- cosa stava cercando di ottenere;
- quale interfaccia ha dovuto aprire;
- quale primitive mancava;
- se il problema era capability, qualità, trust, latenza o UX.

Domanda guida:

> **Quale parte della vita digitale l'owner è ancora costretto a gestire
> direttamente?**

Priorità post-dogfood probabili, da confermare con uso:

1. browser/computer use;
2. email/calendar/contacts;
3. activity + approval surface;
4. consumer installer/control plane;
5. import/export/forget;
6. Telegram avanzato;
7. voce/hardware quando la surface produce valore reale.

Non aggiungere tre euristiche di retrieval se il problema osservato è che
l'owner deve ancora aprire Safari per fare il lavoro.

## 10. Apertura del repository: scala in quattro passi

Non cerchiamo co-maintainer prima di avere un oggetto installabile e dogfoodato.
Un collaboratore senza un prodotto reale da rompere produce soprattutto nuove
opinioni architetturali.

Sequenza:

### Fase 0 — owner Day 1

Gate 1 verde, cutover reale, 14 giorni di uso.

### Fase 1 — trusted alpha

2–5 persone selezionate per massimizzare diversità di ambiente, non numeri:

- macOS Intel/Apple Silicon se rilevante;
- Linux desktop/server;
- Windows quando supportato;
- almeno una persona non autore del codice;
- preferibilmente un contributor con sensibilità security/packaging.

Obiettivo: installazione, update, recovery, portability e UX. Non governance.

### Fase 2 — public alpha open source

Il repo diventa pubblico quando un estraneo può:

1. capire cosa è Muffin in pochi minuti;
2. installarlo senza buildare da source nel percorso raccomandato;
3. arrivare a una conversazione funzionante;
4. sapere cosa viene inviato al cloud;
5. sapere come fare backup/uninstall;
6. segnalare privatamente una vulnerabilità;
7. contribuire senza leggere i documenti interni dell'owner.

### Fase 3 — stable

Solo quando update/migration/export/rollback sono contratti, non procedure
manuali del maintainer.

## 11. Collaboratori e governance

Prima del public alpha cerchiamo **tester e contributor mirati**, non maintainer.

Dopo l'apertura:

- bug e piccoli fix possono arrivare direttamente via PR;
- feature/architettura partono da issue/discussione;
- i maintainer emergono da contributi ripetuti e review affidabili;
- accesso write viene concesso lentamente;
- owner constitution e product thesis non vengono riscritti dalla popolarità di
  una feature request.

Il repository pubblico deve avere almeno:

- `CONTRIBUTING.md`;
- `SECURITY.md` con disclosure privata;
- issue templates (bug/feature);
- support boundary;
- Code of Conduct prima che esista una community non banale;
- changelog/release notes e versioning;
- `good first issue` reali, non task core/safety mascherati da onboarding;
- branch protection/review rules su `main`.

`AGENTS.md` resta la mappa per agenti/contributor tecnici; non può essere il
manuale di onboarding umano pubblico.

## 12. Release engineering è prodotto

Prima del public alpha il percorso raccomandato non può essere `git clone && npm
install`.

Serve una forma almeno equivalente a:

- macOS: package/app firmata e notarizzata;
- Windows: installer per-user quando la piattaforma entra nel supporto;
- Linux: one-liner/package/AppImage o altra forma senza toolchain di sviluppo;
- installer che provisiona dipendenze necessarie o le elimina dal percorso utente;
- onboarding idempotente;
- daemon/gateway installato dal wizard;
- `doctor` finale;
- update e rollback comprensibili.

Source install rimane supportato per contributor.

## 13. Il workflow di sviluppo non torna al mega-prompt

Il Gate 1 non viene chiuso con un nuovo prompt one-shot che contiene l'intero
progetto.

Abbiamo già una source of truth persistente nel repository e un `/loop` che
ricostruisce lo stato. Per lavoro lungo:

```text
/goal stabile
→ /loop
→ una claim alla volta
→ evidence budget FAST/STANDARD/CRITICAL
→ stato riconciliato
```

Un one-shot è appropriato per una slice chiusa, una ricerca o una trasformazione
con un output finito. È una regressione per un programma di lavoro che può
cambiare mentre viene eseguito.

## 14. Gate pre-open-source

Prima di rendere pubblico il repository, oltre al risultato dei 14 giorni,
verificare esplicitamente:

- installazione pulita da artefatto, non da checkout;
- update + rollback + migration da installazione reale;
- backup + restore;
- canonical export/import almeno definito e versionato;
- politica forget/retention;
- provider-as-egress reso visibile e governabile;
- secret boundary;
- containment/trust model MCP/plugin/skill;
- supply-chain controls, lockfile e dipendenze;
- `SECURITY.md` + private disclosure;
- secret scanning/push protection e CodeQL/analisi equivalenti dove utili;
- README orientato a utente prima, contributor dopo;
- support matrix OS/provider/surface;
- licenza e provenance delle dipendenze/asset;
- nessun file personale dell'owner nel repo o nei fixture.

Questo gate non è Gate 1. Il dogfood dell'owner deve iniziare prima: alcuni di
questi problemi esistono solo quando arriva la seconda installazione.