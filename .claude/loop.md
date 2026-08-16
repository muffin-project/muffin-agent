# Il control loop di Muffin

Porta Muffin al **DAY-1 READY** definito in `docs/blueprint/M5-BIS.md`, poi
accompagna i quattordici giorni d'uso reale senza perdere il lavoro parallelo
su gruppi, M6 e M7. Non eseguire una manutenzione generica: scegli il prossimo
obiettivo dal fondo dell'inventario e chiudilo secondo `docs/ORCHESTRATION.md`.

## Prima di scegliere

1. Leggi per intero `CLAUDE.md`, `AGENTS.md`, `docs/THESIS.md`,
   `docs/DESIGN-PRINCIPLES.md`, `docs/PRACTICES.md`,
   `docs/ORCHESTRATION.md`, `docs/BRANCHING.md` e `docs/JUDGE.md`.
2. Leggi il blocco START HERE di `docs/blueprint/STATE.md`, il blocco iniettato
   di `docs/blueprint/LAVORO.md`, l'inventario `docs/blueprint/M5-BIS.md`, i due
   gate di `docs/blueprint/04-roadmap.md`, il threat model e i contratti.
3. Ricostruisci lo stato reale, non quello ricordato: worktree, tutti i branch
   locali e remoti, PR e check, deleghe, diff non committati. Una PR in review o
   un `ADJUST` aperto viene prima di nuovo lavoro.
4. Se i documenti e lo stato osservato divergono, correggi prima il handoff.

## Come scegli l'obiettivo

- Prima rendi possibile il giorno 1: continuità del turno e del lavoro;
  autorità/taint; superficie privata e delivery; memoria; acceptance reale.
- Chiudi prima le decisioni di schema: dal giorno 1 i dati non si resettano più.
- Durante i quattordici giorni continua a correggere ciò che emerge e prepara i
  gruppi in parallelo; non attivare i gruppi prima del checkpoint previsto.
- Una decisione prodotto, sicurezza, privacy, schema o irreversibile richiede
  opzioni, costi e una domanda precisa all'owner. Non scegliere in silenzio.

## Ogni pezzo considera l'intero sistema

Prima di implementare, traccia produttori, consumer, failure path e viste
derivate della garanzia. Controlla anche branch e worktree non integrati per non
duplicare una primitiva o sovrascrivere lavoro migliore.

Un valore valido oggi per `host`, Telegram, una chat privata, un modello o una
macchina non diventa una costante per comodità. Autorità, tenant, surface,
provider, budget, percorso e capability attraversano i confini come dati
tipizzati o configurazione. Il default single-user è una configurazione della
forma generale, non un secondo percorso cognitivo. Nessuna surface può eleggere
l'owner da nomi, bio, username, stanze, foto o contenuto; ogni campo letto resta
input potenzialmente iniettato anche dopo parsing.

## Come chiudi un'iterazione

Riproduci il difetto, prova che il test cade scollegando il cablaggio, esegui
build, suite, failure path e scenario reale dovuto. Aggiorna documenti, mappa,
`STATE.md` e `LAVORO.md`. Fai commit recuperabili, draft PR al checkpoint,
attendi CI e un judge nuovo; integra solo su `MERGE`. Dopo l'integrazione
ricostruisci lo stato prima di scegliere altro.

Non dichiarare DAY-1 READY perché il codice compila: richiede zero BLOCKER e
zero `?` nell'inventario personale, un percorso reale provato come lo userà
l'owner e nessun lavoro integrato soltanto per affermazione.
