# ADR-0081 — Il gateway è l'execution owner quando è vivo

**Stato:** accettato · 2026-09-16 · chiude #533 (research accettata, slice minima verso la baseline).

## Contesto

Il 12/09/2026 il cambio di `models.main` ha mostrato la divergenza: il terminale
riavviato lavorava sul modello nuovo, Telegram (sul gateway già vivo) su quello
vecchio. La causa non era il refresh del modello (#532, chiusa): era che due
processi costruivano due Runtime e due turni locali eseguivano in parallelo —
il REPL faceva stand-down di scheduler e poller (ADR-0035) ma **eseguiva i
turni del terminale in proprio**, e la `ModelLane` è esplicitamente in-process.

Misurato in accettazione durante la slice: con il gateway vivo, un `run`
attraversava un turno Telegram in volo in 635 ms — due corsie, non una. I
turni in arrivo (`runWork`) non prendevano mai la lane: solo scheduler e lane
dei risvegli la condividevano.

## Decisione

Per una Home esiste in ogni momento un solo soggetto autorizzato a produrre
execution ed effects.

1. **Owner risolto a ogni turno** (`core/gateway/ownership.ts`): il socket di
   controllo che risponde è liveness (niente euristiche sui pid); protocollo
   noto → esegue il gateway; claim viva senza socket → conflitto fail closed
   (mai un secondo runtime); né l'uno né l'altra → owner locale esplicito.
2. **Il terminale è cliente** (`core/gateway/forward.ts`, protocollo v2 sul
   socket esistente, stessi ACL del filesystem, nessuna porta nuova):
   `run` esegue sul runtime del gateway con stream, approvazione e file sulla
   stessa connessione; `query` interroga l'esito per id.
3. **Una Home, una ModelLane**: scheduler, lane dei risvegli, turni in arrivo
   (`runWork`) e turni inoltrati dal terminale prendono lo stesso token, nel
   processo owner. In locale senza gateway, lo scheduler del REPL e i turni
   che serve condividono la sua.
4. **Nessun replay automatico**: l'id di execution è stabile (coniato dal
   client, è l'id della riga); rieseguirlo non riesegue — a esecuzione finita
   torna l'esito, in corso ci si attacca come osservatori, su riga altrui ci
   si rifiuta. Disconnect ≠ cancel (solo un frame `cancel` abortisce);
   response persa ≠ non eseguito (esito `unknown`, interrogabile con
   `muffin gateway turn <id>`).
5. **Autorità invariata**: il gateway esegue, il kernel decide. Nessuna
   capability nuova, nessun grant implicito per CLI/Telegram/gateway, nessun
   allargamento di filesystem, rete, MCP, sandbox, trust/taint o locality.

## Alternative considerate

- **Coda DB + polling dal REPL** (il REPL accoda, la lane esegue, il REPL
  interroga): respinta — servirebbero comunque un canale per stream,
  approvazioni e cancel, cioè lo stesso protocollo con più parti mobili e
  un UX peggiore.
- **Rifiutare i turni locali con gateway vivo**: respinta — rompe il
  terminale, e la Definition of Done chiede che il terminale giri *attraverso*
  il gateway.
- **Framework generico di esecuzione distribuita** (lease, consensus,
  exactly-once): respinto — fuori scope della slice; la proprietà minima
  (un owner, id stabili, dedup, no replay, unknown esplicito) basta alla
  baseline.

## Cosa può smentire la scelta

`evals/acceptance/scenarios/gateway-execution-owner.accept.ts`: turno via
gateway con una sola chiamata, approvazione con effetto reale nella stessa
execution, CLI che aspetta Telegram in volo, client ucciso senza duplicati,
cancel come `aborted`, fallback locale esplicito. Più `core/gateway/
forward.test.ts` (dedup, attach, lane) con mutazione che va rossa senza il
token condiviso.

## Evidenza

`docs/evidence/gateway-e-client-2026-08-27.md` (il canale esisteva, v1 sola
osservazione), issue #533, incident 12/09/2026.

## Fuori scope, registrati come follow-up

- Due terminali senza gateway eseguono entrambi in locale (il mutuo
  gateway-vs-locale è chiuso, il mutuo locale-vs-locale no).
- `/steer` dentro un turno inoltrato non è cablato (Ctrl+C sì).
- I finding dell'audit non bloccanti restano post-baseline (Agentic e
  Cognitive Harness), classificati `POST-BASELINE` / `BLOCKS OSS RELEASE`
  dove applicabile.
