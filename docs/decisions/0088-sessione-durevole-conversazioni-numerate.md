# ADR-0088 — Sessione durevole, conversazioni numerate: `/new` è il confine, non il topic

**Stato:** accettato · 2026-09-20 · verdetto owner (`ACCEPT`): «una Session
durevole può contenere più Conversation generation; `/new` è il confine
esplicito che incrementa la generation. Nessun auto-splitting per topic.
Principal, Session, Conversation e Turn restano identità distinte.»

## Contesto

ADR-0056 ha fissato che la chiave di sessione è una funzione dell'identità
(`owner` per l'owner, `${connector}:${conversationId}` per un `member`) e che
`/new` è una rotazione: archivia il file e riparte vuoto **sotto la stessa
chiave** (§4). Restavano aperte tre domande che questa decisione chiude:

1. La rotazione apre «una conversazione nuova» o la stessa conversazione
   svuotata?
2. Un cambio di topic può aprire da solo una conversazione nuova?
3. Session, Conversation e Turn sono tre nomi per una cosa sola o tre identità?

Il failure che rende la domanda materiale: se il topic bastasse a separare,
ogni digressione diventerebbe una conversazione diversa — e la continuità che
ADR-0056 ha costruito (una finestra fusa per l'owner attraverso le porte)
sarebbe smontata da un classificatore di topic, senza che l'owner abbia mai
chiesto di ricominciare.

## Decisione

Quattro identità distinte, un solo confine esplicito:

- **Principal** — *chi* parla (`owner` / `member`, da `identify`; ADR-0056,
  invariato). Non contiene storia, contiene il diritto alla chiave.
- **Session** — il contenitore durevole della storia di un principal su una
  chiave (`owner`, o una chiave di gruppo). Sopravvive a restart, cambi di
  superficie e rotazioni. È ciò che il recall legge senza mai filtrarlo per
  conversazione.
- **Conversation** — una *generation* di una Session. `/new` archivia il
  trascritto corrente e apre la generation N+1 **sotto la stessa Session**.
  Solo l'atto esplicito dell'utente (`/new`, o l'equivalente su un'altra
  superficie) incrementa la generation.
- **Turn** — l'unità di lavoro (ADR-0042/0047, invariati). Molti turni vivono
  dentro una Conversation; una Conversation non è mai un Turn allargato.

**Nessun auto-splitting per topic.** La deriva di argomento non crea mai da
sola una Conversation: né un segmentatore, né una soglia di salience, né un
giudizio di «sarebbe meglio ricominciare» possono incrementare la generation.
La direzione «boundary topicale» annotata nelle note legacy (Layer 5,
`docs/history/foundations/legacy/REFERENCES.md`) è esplicitamente scartata
per l'identità di Conversation: la segmentazione per episodi/recall resta un
problema di *recupero*, e non deve mai coniare identità di Conversation.

## Conseguenze

**Cosa non cambia oggi (di proposito):**

- La regola di chiave di ADR-0056 e la semantica di `SessionStore.rotate`
  (`core/session/store.ts`) restano invariate: `/new` archivia il file e
  riparte vuoto **sotto la stessa chiave di Session**.
- Il consumatore che richiede di nominare la generation esiste ed è **#597**:
  lo stickiness del provider (`ChatCall.conversation` → `session_id` su
  OpenRouter) ha bisogno di un'identità di Conversation stabile dentro una
  generation e diversa dopo `/new`, e l'id di Session da solo non può darla
  (una Session dura quanto la chiave, una Conversation quanto la generation).
  Perciò #597 persiste la generation in un sidecar `<sessionId>.conv.json`
  `{version, generation}` accanto al transcript, mai in Git: assente = 0
  (default legacy, `open()` non scrive mai); corrotto = errore loud su
  read/open/bump, mai degrado silenzioso a 0; scrittura atomica tmp+rename;
  `newConversation()` è l'unico percorso di `/new` (rotazione del transcript
  quando c'è, generazione sempre avanti anche a transcript assente:
  l'intento decide il confine, non il file); `resolveConversationId` rende
  `id#gN`. Cancellare il sidecar torna al fallback session-valued: reversibile.
- Id headless e job (`cli/run.ts`, scheduler, observe-run) restano separati
  (ADR-0056 §3): un job non è una Conversation dell'owner.
- Il recall non filtra per generation: la generation è un confine di
  *presentazione e continuità*, non un recinto di memoria.

**Vincolo per il lavoro futuro:** quando lo storage nominerà la generation
(contatore, tabella, metadato), dovrà soddisfare tre proprietà, provate da
test: stessa chiave di Session attraverso `/new`; incremento solo su atto
esplicito; nessuna generation derivata dal topic. Un'implementazione che
crea conversazioni da sola falsifica questa decisione invece di estenderla.
#597 è la prima implementazione di questo vincolo e lo soddisfa per
costruzione (sidecar letto da `open()`, avanzato solo da `newConversation()`,
mai dal topic); un secondo consumatore riusa lo stesso sidecar, non un nuovo
meccanismo.

## Come si falsifica

- Evidenza di dogfood che l'owner si aspetta storie separate per topic e vive
  la finestra fusa come confusione, non come continuità: allora la risposta è
  un filtro di *presentazione* per topic dentro la stessa Conversation, non
  uno split di identità — e se nemmeno quello basta, questa decisione va
  riaperta con un nuovo ADR, non reinterpretata.
- Una seconda persona sul tenant `host`: tutto il ragionamento su Principal →
  Session va rifatto (già noto da ADR-0056 §«Cosa farebbe rivedere»).
