# Percorso critico verso DAY 1

Questo file possiede **ordine e dipendenze**, non lo stato Gate. Lo stato vive soltanto in `../M5-BIS.md`; il lavoro vivo in Git + `../LAVORO.md`; le deliberate deferral in `../../ROADMAP.md`.

La versione immediatamente precedente alla riconciliazione ADR-0050/0051/0052 è preservata in `docs/history/day1-2026-08-25/PERCORSO-CRITICO-pre-topology.md`.

## Stato dell'ordine — riconciliato 25/08/2026

M5 è stato riletto contro il `dev` successivo a PR #88. Il percorso non usa più la vecchia equivalenza `transport event == Turn` e non tratta più voice/multipart come opzionali per il DAY-1 personale.

Principio di ordinamento:

```text
semantic invariants / durable identities
        ↓
schema + recovery of valuable continuity
        ↓
authority/effect primitives
        ↓
capability mechanisms that would force fallback
        ↓
integrated evidence + real owner battery
```

Una riga di sola evidence non riceve un subsystem nuovo. Più righe con la stessa causa radice condividono una slice quando il claim resta reviewable.

## 0 · RETURN TO OWNER viene prima del resto dell'ordine

Milestone owner del 2026-08-25; definizione e classificazione vivono in
`../M5-BIS.md` §Milestone RETURN TO OWNER (una sola casa, qui solo l'ordine).
Fino al suo stop-point l'ordine operativo è:

```text
S1  ingress foundation atterra   (PR #90 + fence della delivery + judge sulla claim nuova)
S2  schema lifecycle             (A6 + A7 + A8-min: migration runner versionato, backup/restore)
S3  hardening minimo             (D12-min + E6; parallela a S2)
S4  bring-up modello locale + install reale + smoke journey
```

Path critico S1 → S2 → S4. Al termine: stop pre-dogfood development, install,
uso reale. Le sezioni da §2.3 in giù restano l'ordine *di Gate*, ma la loro
esecuzione riparte **dopo** RETURN, riprioritizzata dall'evidence del dogfood.

## 1 · Chiudi l'ingress foundation prima di costruirci sopra

### 1.1 `recall-speaker` — chiuso

Speaker e trust sono assi separati fino al prompt. Una risposta precedente di Muffin non diventa owner speech perché è tier 0. Evidence: `core/memory/recall-speaker.test.ts` + judge CRITICAL di PR #82.

### 1.2 Native-event identity / mediazione di #78 — primo claim runtime aperto

**Claim:** ogni native event ricevuto ha identità durevole e viene consumato semanticamente una sola volta attraverso crash/retry, ma non è per definizione un Turn.

Forma current:

```text
NativeEvent
   ↓ durable/idempotent receipt
IngressFragment / composition membership
   ↓
sealed user intent
   ↓
durable Work identity
```

Più eventi possono condividere lo stesso Work. Una volta esistente la Work identity, retry/recovery non ricrea model call, tool/effect o delivery soltanto per riconsegnare lo stesso evento.

PR #78 contiene evidence preziosa da riusare: inbox durevole, accept/bind/settle, fault injection e no-duplicate execution/delivery. Va **mediata**, non mergiata meccanicamente e non riscritta da zero. Il judge CRITICAL deve attaccare la nuova claim, non `update_id → exactly one Turn`.

### 1.3 Surface composition + busy input + typed provenance

Dopo che l'evento ha una identità onesta, il runtime deve rendere vera la seconda metà di ADR-0052:

- una Surface continua a ricevere durevolmente mentre Work è vivo;
- primitive native di grouping precedono euristiche temporali;
- input successivo può diventare `COLLECT`, `STEER`, `FOLLOWUP` o `INTERRUPT` a safe boundary;
- typed parts dei consumer DAY-1 conservano provenance/taint separata;
- un already-started Effect non viene reinterpretato come “mai successo”.

B2 e B16 sono due viste dello stesso confine, ma non richiedono per forza una PR monolitica: separare durability/composition da busy-input/provider-media quando serve alla review. Non introdurre broker, tabella `Intent` o universal media envelope senza consumer.

## 2 · Chiudi la forma durevole prima che il dogfood la renda costosa

### 2.1 Schema evolution / migrations — A6 + A7

Serve un percorso versionato provato da database precedente **popolato** a HEAD. Derived indexes possono ricostruirsi; Evidence/Beliefs/Work/Effects/Authority canonici no.

### 2.2 Hot backup + restore — A8

Backup/restore nella topologia reale con gateway residente e SQLite WAL. La copia a freddo già provata non chiude la claim.

### 2.3 Reversible effects / undo — D2 + D3 + D11

Una semantica sola:

```text
safety snapshot/precondition
→ durable effect intent
→ execute
→ outcome
→ reusable undo
→ Work/context reconciliation
```

Se lo snapshot è ciò che rende eseguibile un effect reversibile, snapshot failure = effect non parte. Non trasformare `draft` in `allow` per aggirare il problema.

## 3 · Chiudi i mechanism blocker che causerebbero fallback

Ordine relativo dopo le fondamenta:

1. **D12 ASK/approval durevole:** mostra canonical plan/args/resource/taint; il consenso non sopravvive a un piano cambiato.
2. **B6 retry/failure semantics:** provider/network/tool recovery coerente con rerunnability ed effect uncertainty.
3. **B15 owner binding protetto:** identity della Surface non deve dipendere da config authority modificabile come preferenza ordinaria.
4. **B10 + C8 Telegram multimodale/voice:** immagini/file sul provider path; audio originale come Evidence, transcript derivato/provenanced; errori espliciti. Consumano il contratto B16 invece di crearne uno parallelo.
5. **E1 work/job spend bound:** evitare che un singolo background Work consumi il budget globale.
6. **E6 action cap reale:** il cap deve limitare anche un batch di molte tool call in una singola model response.
7. **C5 model-facing provenance:** lettura read-only dello stesso store usato da `memory why`.
8. **E7 `sys.inspect`:** propriocezione live dalle stesse source of truth di doctor/status/prompt.
9. **A2/A3 character behaviour:** mechanism già cablato; qui resta soprattutto real-model evidence, quindi non inventare runtime.

D9 Skills resta fuori da questa lista di implementation: HEAD ha già `fence()` + prompt wiring; va risolta come **evidence reconciliation**, non con nuovo codice salvo finding reale.

## 4 · Completa poche journey integrate per i blocker di sola evidence

Raggruppa per percorso, non una PR/test per riga:

- install/config/doctor/update/backup — A4 e la prova finale dei mechanism A6/A7/A8;
- memory extraction/consolidation/temporal/provenance/documents — C2/C3/C5/C6/C7;
- shell/process/http/search — D4/D5/D6/D7;
- file production/delivery — B14;
- Skills fencing/wiring — D9, con mutation/acceptance appropriata senza reimplementazione;
- trace reconstruction — E3;
- Telegram owner journey — B1/B8/B10/B16/C8 sul servizio/surface reale dove il fake cambierebbe la claim;
- identity/persona — A2/A3 sui modelli Gate;
- failure synthesis — E5 solo dopo che le classi sottostanti sono chiuse.

Il criterio è falsificare la claim vera. Una journey può coprire più righe quando passa davvero dagli stessi confini.

## 5 · Owner-machine battery e audit finale

Quando M5 non ha più blocker:

1. build/install/update sulla macchina dell'owner;
2. supervisor + reboot/logout dove necessari;
3. Telegram/provider/network reali per le claim non falsificabili onestamente con fake;
4. voice/transcription reale;
5. doctor/status/sys.inspect sullo stato effettivo;
6. fresh integrated red-team con la domanda terminale del mandato: “cosa mi costringerebbe ancora ad aprire un altro agente/app durante i 14 giorni?”;
7. solo dopo: `dev → main` secondo `BRANCHING.md` e inizio DAY 1.

## Fuori da questo ordine

Le righe `OUT` hanno la loro fase in `docs/ROADMAP.md`: proactivity oltre job espliciti, overflow/context-pressure UX, Discord parity, MCP hot lifecycle, world-state generico e altre capability non richieste dalla finestra personale.

Nodes, local inference, Home migration e public extension work non diventano Gate per eleganza. Entrano solo se il deployment DAY-1 o un fallback reale li rende indispensabili.

## Regola di manutenzione

Aggiorna questo file soltanto quando cambia una **dipendenza/causa radice/ordine**. Gli stati vanno in M5; le PR vive in Git/LAVORO; la fase futura in ROADMAP. Se una nuova decisione architetturale cambia il significato di una claim, si riconcilia prima la domanda e solo dopo si implementa contro di essa.