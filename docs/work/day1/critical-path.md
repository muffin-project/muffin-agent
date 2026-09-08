# Percorso critico DAY-1

Questo file possiede solo **ordine e dipendenze CURRENT**. Lo stato vive in
[`requirements-status.md`](requirements-status.md); la prova in `docs/evidence/`;
il lavoro attivo in Git/PR + [`handoff.md`](../handoff.md); le deferral in
[`ROADMAP.md`](../../ROADMAP.md).

## Ordine corrente

```text
foundation/cutover proven
        ↓
scheduling preciso surface-agnostic
        ↓
safe heartbeat/work-liveness
        ↓
privacy request-egress
        ↓
integrated real acceptance
        ↓
fresh reviewer
        ↓
DAY-1
```

Le tre claim non sono implementate da questo reset. Una sola può essere attiva:
la prima non provata.

## NEXT CLAIM

**Scheduling preciso surface-agnostic (B20).** Da ogni surface normale,
“domani alle 08:32 ricordami X” e un reminder ricorrente deterministico devono
essere esprimibili senza CLI/cron, usare la surface di default salvo override e
consegnare nel tempo di tolleranza deciso dall'owner. Il fire deterministico non
chiama il modello.

Preservare `Job.kind='script'`: esiste già, gira nel sandbox, non chiama il
modello e tratta stdout vuoto come silenzio. Il beat corrente di 30 s è un gap
di precisione, non la target shape; un maintenance heartbeat e un precise timer
sono primitive differenti.

**Ownership:** non assegnata finché il governance reset non è accettato.
`issue != delegation`: prima di iniziare, registrare executor, falsifier e
tolleranza owner. Nessuna claim successiva parte automaticamente.
