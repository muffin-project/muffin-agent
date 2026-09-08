# Muffin Extensions — ecosistema, capability e pubblicazione

> **Stato: DIREZIONE DI DESIGN · owner 2026-08-18.**
> Non è una specifica runtime e non autorizza l'implementazione pre-Day1.
> `docs/OPEN-SOURCE-STRATEGY.md` decide perché esiste un ecosistema; questo
> documento decide la sua forma minima per non trasformare il core in un
> catalogo di integrazioni o il catalogo in codice arbitrario implicitamente
> trusted.

## 1. Package e capability sono cose diverse

Una **extension** è l'unità che una persona installa, aggiorna, rimuove e che una
community può pubblicare e mantenere.

Una **capability** è l'unità su cui il kernel decide authority ed effects.

Quindi non vale né:

```text
plugin = una capability
```

né:

```text
plugin installato = tutto il suo codice è autorizzato a tutto
```

Esempio:

```text
Gmail extension
├─ importer.gmail.history
├─ mail.search
├─ mail.read
├─ mail.draft
└─ mail.send
```

L'extension è una. I poteri restano separati. `mail.read` può essere ALLOW mentre
`mail.send` resta ASK; rimuovere la seconda capability non deve disinstallare la
prima.

## 2. Il core resta stretto

La regola di breadth è:

```text
own semantics
rent capabilities

reuse > adapt > implement
```

Muffin possiede identità, Work, Effects, Authority e canonical state; per una
capability commodity preferisce riuso o adattamento a una seconda
implementazione. Hermes e gli altri peer sono benchmark/reference da
distillare, non un secondo personal agent e non un'autorità di roadmap.

Il core possiede le primitive che devono comporre qualunque use case:

- identity/principal;
- evidence e provenance;
- work e durable turns;
- effects e reversibility;
- policy/authority;
- taint/egress;
- secret references;
- sandbox/containment;
- provider, surface ed extension boundaries;
- introspection.

Non possiede per forza Gmail, Spotify, Home Assistant, Notion, GitHub, browser,
Rizzo PII o la prossima piattaforma che diventa popolare.

**Una capability che un owner non installa non deve esistere nella sua
installazione.** Il core non simula una integrazione assente e non porta il suo
peso operativo per principio.

Il linguaggio segue la responsabilità. Il Home TypeScript possiede semantica e
authority; un processo Python o altro runtime può fornire compute/capability
attraverso un confine locale, stretto e tipizzato, ma non diventa un secondo
Home o un secondo semantic writer. Il confine concreto si introduce solo quando
una capability misurata lo giustifica, non come framework preventivo.

## 3. `Plugin` è una parola UX, non una sola interfaccia runtime

Per chi usa Muffin può essere ragionevole dire «installa il plugin Gmail».
Internamente, lifecycle diversi non vanno schiacciati in un'interfaccia universale.

Contratti possibili:

- **connector** — ingresso/uscita continuo da una surface o piattaforma;
- **importer** — archivio/dump → evidence con provenance;
- **capability/tool provider** — nuove azioni o letture;
- **provider adapter** — fonte di inferenza;
- **privacy transform** — context → context trasformato localmente;
- **renderer** — rappresentazione di output per una surface;
- **skill** — procedura/prompt/protocollo sopra capability già esistenti;
- **MCP/A2A adapter** — standard boundary verso server/agenti esterni.

Possono condividere packaging, manifest, install/update e governance senza
condividere per forza il lifecycle runtime.

## 4. Manifest prima del codice

Muffin deve poter capire **cosa un'estensione dichiara di voler fare prima di
eseguirne il codice**.

La forma esatta non è ancora decisa, ma il manifest pubblico deve poter esprimere
almeno:

```yaml
id: community.gmail
version: 1.4.0
publisher: github:example
contracts:
  - connector
  - importer
  - capability-provider

capabilities:
  - mail.search
  - mail.read
  - mail.draft
  - mail.send

network:
  allow:
    - gmail.googleapis.com

filesystem:
  read: []
  write: []

secrets:
  - gmail_oauth

effects:
  mail.draft: reversible
  mail.send: outward-irreversible

platforms:
  - macos-arm64
  - linux-x64
```

Questo è **authority richiesta**, non authority concessa. L'installazione fa una
seconda operazione: l'owner vede la richiesta e il kernel crea soltanto le grant
consentite dalla policy.

Il manifest non può auto-autorizzarsi.

## 5. Permission diff come primitive di update

Un update che non cambia authority può seguire il normale percorso di update.
Un update che amplia authority è semanticamente una nuova richiesta.

Esempio:

```text
v1.4
network: gmail.googleapis.com
filesystem: none

v1.5
network: gmail.googleapis.com
filesystem.read: ~/Documents
```

La seconda versione non viene silenziosamente promossa perché «è lo stesso
plugin». Muffin mostra il diff e richiede una nuova decisione.

Stessa regola per:

- nuovi secret;
- nuovi host;
- write scope più largo;
- nuove capability;
- effetto che passa da read/draft a outward;
- nuova surface o principal class.

**Version trust non sostituisce permission review.**

## 6. Catalogo pubblico: metadata e curation, non hosting del runtime

Un futuro catalogo Muffin non deve eseguire gli agenti né ospitare i loro dati.
Può essere una registry di metadata che punta ad artefatti pubblicati altrove
(GitHub release, npm, container registry, pacchetto firmato).

Questo mantiene separati:

```text
publisher identity
metadata + manifest
artifact distribution
curation/review
owner authority
runtime execution
```

Il fatto che una extension sia nel catalogo non le concede nessuna authority
nell'installazione dell'owner.

## 7. Livelli di pubblicazione

I nomi finali sono aperti; la semantica no.

### Local / Unlisted

Installata da path/URL/repository dall'owner.

- manifest valido;
- nessuna review Muffin implicita;
- UI mostra chiaramente origine e authority richiesta;
- utile per sviluppo e use case privati.

### Community

Pubblicabile nel catalogo quando almeno:

- namespace/publisher verificabile;
- manifest schema-valid;
- versione immutabile identificabile;
- source/artifact provenance dichiarata;
- test minimi di install/config;
- permission manifest presente;
- maintainer/codeowner dichiarato;
- documentazione e limiti noti;
- scanner automatici senza finding bloccanti conosciuti.

`Community` significa **identità e baseline verificate**, non «sicuro per
qualsiasi installazione».

### Reviewed

Un livello più alto può richiedere:

- review umana indipendente;
- capability contract tests;
- verifica che il processo non eserciti authority non dichiarata nei test di
  containment;
- recovery/auth failure path;
- update/permission-diff test;
- maintenance attiva;
- security contact;
- storico sufficiente nel catalogo.

La review può decadere se il maintainer sparisce o la nuova versione non mantiene
i requisiti.

### First-party

Mantenuta dal progetto Muffin. Non significa «più potente» e non bypassa il
kernel. È una relazione di manutenzione, non una super-capability.

## 8. Community governance

Il catalogo deve poter crescere senza rendere il core team proprietario di ogni
integrazione.

Forma desiderata:

- ogni extension ha uno o più codeowner;
- piccoli fix possono essere comunitari;
- cambi di manifest/authority ricevono review esplicita;
- versioni malevole o abbandonate possono essere yanked dal catalogo senza
  disinstallazione remota automatica dalle macchine degli owner;
- report di sicurezza hanno canale privato;
- review status e maintenance status sono dati pubblici;
- la community può proporre promotion/demotion di qualità con evidenza.

La curation può diventare distribuita nel tempo; l'authority finale resta sempre
locale all'installazione.

## 9. Validation pipeline

Prima della pubblicazione pubblica, il pipeline dovrebbe poter verificare in modo
automatico ciò che è automatizzabile:

1. schema del manifest;
2. namespace/publisher;
3. artifact digest/version immutabile;
4. dipendenze e lock/provenance disponibili;
5. test dichiarati;
6. secret references — mai valori;
7. capability/resource vocabulary valida;
8. sandbox profile derivabile;
9. network/fs/effect requests visualizzabili all'owner;
10. nessun widening silenzioso rispetto alla versione precedente.

Static analysis e scanner non sono prova che il codice sia innocuo. Quando
l'estensione contiene codice eseguibile, il runtime boundary resta necessario.

## 10. MCP non è automaticamente un Muffin extension sicuro

Un MCP server può essere scoperto tramite registry standard, ma il suo processo
locale resta codice terzo. L'eventuale adapter Muffin può importarne metadata e
tool schema, ma deve poi applicare il modello Muffin di authority/containment.

Quindi:

```text
MCP Registry entry
       ↓ discovery metadata
Muffin extension adapter
       ↓ requested authority
owner/kernel decision
       ↓
contained process / declared trusted code
```

Namespace authenticity, schema pinning e review del catalogo risolvono problemi
diversi. Nessuno dei tre sostituisce il sandbox.

## 11. Skill-maker: imparare una routine non significa allargare authority

Un'idea valida del vecchio Muffin resta utile nella nuova forma: se Muffin nota
che l'owner ripete un workflow, può proporre di renderlo riusabile.

La risposta non deve essere necessariamente «genera codice nel core».

Può essere:

```text
routine osservata
→ usa capability già installate
→ crea una skill locale
```

oppure:

```text
routine osservata
→ manca una capability
→ suggerisce una extension community compatibile
→ owner vede authority richiesta
→ installa oppure rifiuta
```

L'apprendimento migliora il *come*; non inventa nuovi permessi.

## 12. Criterio di successo

L'ecosistema fallisce se per aggiungere Gmail dobbiamo modificare il core.

Fallisce anche se «installare Gmail» equivale a dare a un pacchetto comunitario
accesso indistinto alla macchina.

La forma riuscita è:

> **core piccolo, ecosistema largo, authority stretta e leggibile.**

Il catalogo serve a scoprire e mantenere capability. Il kernel continua a
decidere cosa possono realmente fare su ogni Muffin.
