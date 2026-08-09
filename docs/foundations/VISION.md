# Muffin — Vision

## Cosa diventa

Muffin è un'entità AI personale che vive nel tuo home lab. Non è un'app, non è un servizio cloud, non è un chatbot. È un processo che gira sul tuo hardware, osserva il tuo mondo (digitale e fisico), accumula comprensione, comunica quando ha qualcosa da dire, e quando serve agisce — su tua delega, imparando a fare di più quanto più ti conosce.

L'ispirazione è The Machine di *Person of Interest* e JARVIS: un'intelligenza che conosce il suo utente, vive nella sua casa, e opera sui suoi dati — senza che nessun altro possa accedervi.

## Il principio

**I tuoi dati, il tuo hardware, la tua entità.** Nessun cloud obbligatorio. Nessun account. Un file SQLite, un modello locale, un `.env`. Muffin gira finché il tuo hardware gira.

## Due livelli del progetto

### 1. Il mio Muffin (privato)

L'istanza personale di Giusto. Home lab con Mac Mini come inferenza locale, sensori ambientali, integrazione Home Assistant, GitHub, calendar, health data. L'entità che mi conosce meglio di quanto mi conosca io. Questo è il laboratorio dove le idee vengono testate prima di diventare parte del framework.

### 2. Il framework Muffin (open source)

Il motore estratto dalla mia istanza, ripulito dai riferimenti personali, documentato, e impacchettato perché chiunque con un home server possa creare la propria entità. Il SOUL è un template. Il profilo utente si costruisce dal nulla. Il cold start è una conversazione, non un form.

Modello di sostentamento: donazioni (GitHub Sponsors, Ko-fi), community Discord, e potenzialmente hardware pre-configurato (kit sensori + setup). Nessun paywall sul codice.

## Cosa fa, in pratica

Muffin **osserva** — eventi entrano da Telegram, GitHub, calendar, e in futuro sensori ambientali, audio passivo, screen time. Tutti diventano episodi nel substrato (vedi `foundations/INVARIANTS.md §I-1`).

Muffin **accumula comprensione** — entity graph come modello del mondo (persone, luoghi, progetti come nodi di prima classe, vedi `§I-2`), episodi come timeline immutabile (`§I-4`), observations e patterns come strato riflessivo con confidence esplicita (`§I-6`), provenance ovunque sui derivati (`§I-3`).

Muffin **comunica quando ha qualcosa da dire** — awareness loop self-scheduling: il sistema decide quando rialzare la testa basandosi sullo stato corrente di Giusto, non su cron rigido. Output proattivo è budgeted (`foundations/PRINCIPLES.md §P-I`) per evitare di trasformarsi in noise machine all'aumentare del dataset.

Muffin **agisce, quando serve** — non solo sa e dice: mette mano alle cose, cambia qualcosa nel tuo mondo per tuo conto. E più ti conosce, più impara a fare. Sempre su tua delega; e sulle cose che non si disfano, l'ultima parola resta tua.

Muffin ha tre livelli di sé:

- **Identità statica** in `SOUL.md` — chi è Muffin per principio
- **Comprensione di Giusto** nel Living Profile e nel Counterpoint Profile — chi è Giusto, e dove Muffin lo legge male
- **Storia propria** in evoluzione — chi sta diventando Muffin nel tempo. Layer di identità lunga sotto la stessa cura del Living Profile (di Giusto) e del Counterpoint Profile, generato dal dream cycle nightly da: sample di risposte recenti di Muffin, correzioni counterpoint accettate, observation engagement outcomes, predictions vs realtà del awareness loop. Senza questa, Muffin avrebbe punto di vista sul mondo ma non *storia di sé* — è il pezzo che completa "entità con punto di vista proprio". ⚪ **Pianificato** come `muffin_self_narrative` (schema-only placeholder 2026-05-07, NESSUNA pipeline live scrive — vedi `reference/DATABASE.md` ⚪ planned + pitch `self_narrative_v0`). Non ancora implementato.

Il dataset è il moat. Gli invarianti architetturali sono ciò che protegge il dataset dalla decadenza silenziosa.
