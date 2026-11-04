# ADR-0096 — System One giudica in shadow accanto alla domanda

**Stato:** accettato · 2026-10-01 · issue #740 (fase 1), dottrina #607.

## Contesto

La seconda metà della #740 è `/auto`: l'owner delega un lavoro e System One
decide *quali* ask di quel lavoro sono ordinari. La issue stessa vieta il
salto diretto al consumo probabilistico: prima shadow, poi controfattuale,
poi classi calibrate. E l'evidenza avversa già registrata su #607 (benchmark
phishing: Jev 62.6% vs 81.3%, ECE peggiore) rende la calibrazione obbligatoria
— «promozione per famiglia di giudizio, mai "Jev passed overall"».

Serve quindi il **sensore**: un'interfaccia runtime che giudica gli ask
reali mentre l'owner decide davvero, e lascia i dati per decidere se il
consumo potrà mai esistere. I vincoli dottrinali (tutti già decisi altrove):
il kernel resta puro, sincrono e senza modello (ADR-0095; rifiuto
`approvals.mode: smart` in `hermes-documentazione.md` §1); System One è
un'interfaccia con provider sostituibili e Jev/TypeSafe è un candidato
(#607); niente dipendenza obbligatoria, niente rete nei test, chiave assente
→ saltato e detto, mai fallito.

## Decisione

1. **Il porto è di Muffin, l'SDK sta in un adapter.** `core/judgment/port.ts`
   definisce giudizi tipizzati (noul = probabilità del sì; choice = opzione +
   distribuzione) e `SystemOnePort`; `typesafe.ts` è l'unico file del runtime
   che importi `@typesafe-ai/sdk`. Timeout, retry e fetch iniettabile
   dichiarati una volta, nel costruttore dell'adapter: gli edge noti
   dell'SDK (#607) restano dietro il confine.
2. **Shadow vuol dire accanto, mai davanti.** L'hook sta nel ramo `ask` di
   `tool-call.ts`, dopo la riga `approvals.ask` e prima della domanda alla
   superficie: il giudizio parte, la domanda parte, nessuna delle due aspetta
   l'altra. Il sensore **non può consumare** l'ask per costruzione — non c'è
   un ramo che lo permetta. Sotto `/yolo` non si giudica: senza domanda
   non c'è decisione owner da calibrare.
3. **Spento per assenza.** Nessuna sezione `judgment` in config → nessuna
   rete, nessuna riga, byte-per-byte il ramo ask di sempre. Config presente
   e segreto mancato → una bootLine, non un errore. La chiave vive nel
   registro dei segreti (`secret://`), mai inline, mai dall'ambiente: la
   verità di produzione è la config dell'installazione.
4. **Ciò che esce dalla macchina è l'envelope, redatto.** Fatti compatti —
   richiesta dell'owner, capability e riga di effetto, comando/risorsa,
   descrizione del modello, taint, principal, verdetto e perché-ask — mai la
   conversazione, mai il repo. Ogni campo testuale passa da `redactText`
   (la stessa del tracing) **prima** della spedizione e prima della riga: un
   comando con un token dentro parte come «redacted:N». L'accettazione lo
   prova sul filo, leggendo il corpo che il giudice riceve.
5. **La riga è il dato di calibrazione.** `ask_judgments`: pending alla
   partenza, poi `ok`/`timeout`/`error`; porta l'envelope intero (per
   rigiocarlo con pacchetti nuovi), l'impronta dello stato, il modello che
   ha **davvero** risposto, uso, latenza, modalità di delega, e si raggiunge
   per `approval_id`/`turn_id` — i join con la decisione owner
   (`approvals`) e l'esito reale (`turn_tool_calls`) sono la fase 2, non un
  'intuizione. Un guasto del provider è una riga, non un evento del turno.
6. **Fire-and-forget con crash visibile.** L'ask non attende mai il sensore;
   un throw sincrono dentro l'hook resta nel log; un giudizio in volo alla
   chiusura resta `pending` — il buco si legge nel report, non si interpreta
   come un verdetto.
7. **Un pacchetto per famiglia, versionato.** `shadow-shell/v1`: i nove
   giudizi stretti del commento «Shell semantics» della #740 (noul, mai un
   «safe» olistico), applicato a `sys.shell`/`sys.shell.write`. Le soglie non
   vivono nel pacchetto: quelle sono dati di calibrazione, architettura no.
8. **Visibilità.** `sys.inspect` dice se un giudice è attivo e quale modello
   è richiesto; le righe dicono chi ha risposto davvero.

## Alternative scartate

- **Giudizio nel kernel**: rompe il contratto puro/sincrono e rende il deny
  negoziabile per costruzione (ADR-0095).
- **Consumo subito, busta vuota**: è la fase 3 senza la 2 — la issue lo
  vieta, l'evidenza avversa lo sconsiglia, e il meccanismo senza calibrazione
  sarebbe promesso ma non decidibile.
- **SDK sparso nel runtime**: due posti che importano l'SDK sono due posti
  che divergono al primo cambio (#607 chiede un confine solo).
- **Chiave da ambiente** (`TYPESAFE_API_KEY`): giusto per il piano sviluppo
  di #607, sbagliato in produzione — la config sigillata per installazione
  è la verità, non la shell di chi avvia.
- **Giudizi per ogni ask, di ogni capability**: l'envelope e il pacchetto
  sono shell-first per direzione dell'owner; le altre famiglie arrivano con
  pacchetti loro, non con un generico.

## Conseguenze

- Nuova dipendenza `@typesafe-ai/sdk` (MIT, Node ≥20) dietro un solo
  adapter; passa il controllo licenze di CI; nessun test tocca la rete
  (fetch iniettabile; l'accettazione usa un server di loopback).
- Nuova tabella `ask_judgments` e nuovo span `muffin.judgment.shadow`.
- Nuova sezione config `judgment` (tutto opzionale, default assente).
- SECURITY.md guadagna il paragrafo su cosa esce dalla macchina.
- La fase 2 (join + report controfattuale) e la 3 (consumo calibrato) hanno
  l'innesco e i dati: il resto è loro.

## Falsificatori

- Senza config `judgment`: nessuna riga, nessuna rete, e la suite
  approvazioni esistente verde invariata (parità).
- Tolto l'hook in `tool-call.ts`: tre test rossi (`agent/ask-shadow.test.ts`),
  incluso «nessuna riga» — il sensore è cablato o non è.
- Un token nel comando: il corpo che il giudice riceve lo contiene
  **redatto** (scenario di accettazione, sul binario vero).
- Provider giù: riga `error` e domanda/sospensione/risposta intatte.
- Sotto `/yolo`: nessuna nuova domanda, nessun nuovo giudizio.
