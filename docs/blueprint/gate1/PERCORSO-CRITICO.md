# Percorso critico verso DAY 1

Questo file possiede **ordine e dipendenze**, non lo stato Gate. Lo stato di una
riga vive soltanto in `../M5-BIS.md`; le PR e i merge correnti vivono in Git e
nel handoff `../LAVORO.md`.

La versione precedente, che mescolava ordine, status, cronaca di merge e decisioni
operative, è preservata in
`docs/history/day1-2026-08-19/PERCORSO-CRITICO-originale.md`.

## Stato di affidabilità dell'ordine

**INVENTORY RECONCILIATION REQUIRED.** L'inventario M5 corrente contiene ancora
claim e sintesi stale; non usare conteggi globali o la vecchia frase «blocco 1
chiuso» come evidence.

Contraddizione già verificata:

- il vecchio percorso dichiarava chiuso il blocco trasversale;
- `recall-speaker` resta un difetto reale: un episodio scritto dall'agente può
  ancora essere reso come «tu» se il recall usa solo il trust tier e perde il
  ruolo/speaker.

Finché M5 non è riconciliato riga per riga, questo percorso ordina **i blocker
noti e verificati**, senza fingere che l'elenco globale sia già fresco.

## 1 · Chiudi le invarianti trasversali residue

### 1.1 `recall-speaker`

**Perché prima:** provenance/speaker errati contaminano il livello epistemico su
cui si appoggiano memoria e personalizzazione. Il nuovo schema conserva `role` e
speaker; il rendering di recall deve conservarli fino al prompt invece di
collassare `tier 0` in «owner said».

Claim: una frase precedente di Muffin non può essere renderizzata o interpretata
come parola dell'owner soltanto perché è trust tier 0.

### 1.2 `inbound-unit` / Telegram `update_id → one durable turn`

**Perché prima:** un crash fra inbox e turn può duplicare lavoro, model call,
effetti o delivery. La forma deve comporre con l'identità già usata per le
occorrenze scheduler.

PR #78 implementa questa famiglia ma, all'osservazione del 19/08, il branch è
divergente rispetto a `dev`. Prima dell'integrazione CRITICAL deve incorporare il
`dev` corrente e rifare l'evidence pertinente + judge indipendente; il testo di
questa riga non è un verdetto sulla PR.

## 2 · Chiudi la forma durevole prima del dogfood

Queste famiglie vengono prima delle capability additive perché, una volta che la
nuova installazione accumula dati reali, cambiare forma diventa migrazione.

### 2.1 Schema evolution / migrations

Serve un percorso provato da database precedente **popolato** a HEAD, non solo
`CREATE TABLE IF NOT EXISTS` su database fresco. Include il problema dei CHECK
SQLite non alterabili in-place e l'upgrade dei durable store già esistenti.

### 2.2 Update + hot backup + restore

Aggiornare Muffin deve preservare la home. Backup/restore deve essere provato
nella topologia reale con gateway/WAL, non soltanto come copia a processo fermo.

### 2.3 Reversible effects / undo journal

Rendere realmente eseguibili gli effetti reversibili richiede una semantica
unica: durable intent, snapshot pre-effect stabile per call, effect, outcome e
undo/reconcile. Non trasformare `draft` in `allow` per evitare il problema.

## 3 · Chiudi le capability che causerebbero fallback nei 14 giorni

Dopo le fondamenta sopra, prendi le righe `BLOCKER` di M5 che richiedono ancora
meccanismo o wiring reale. Raggruppale per causa radice, non una PR per riga.
L'ordine relativo è:

1. approval/ASK realmente azionabile e durevole dove promesso;
2. provider/network retry e failure esplicito;
3. owner binding/pairing protetto;
4. Telegram/media necessari alla finestra personale;
5. budget/cap per singolo lavoro dove necessario;
6. onboarding/prompt state residuo;
7. `sys.inspect` / propriocezione tecnica;
8. altre capability che la riconciliazione M5 dimostra ancora costringerebbero
   l'owner a uscire da Muffin.

Una riga che richiede soltanto acceptance del meccanismo già cablato va nella
fase successiva, non riceve architettura nuova.

## 4 · Completa le journey di accettazione

Raggruppa le righe con meccanismo già presente in poche journey integrate:

- install/config/doctor/update/backup;
- session + memory + temporal/provenance;
- document/file production and delivery;
- shell/process/http/search;
- Telegram owner private journey;
- scheduler/budget/failure visibility;
- identity/persona character eval sui modelli Gate.

Il criterio non è «uno scenario per forza per ogni riga» se il Verification
Profile non lo richiede. Il criterio è che l'evidence del percorso integrato
falsifichi davvero la claim.

## 5 · Owner-machine battery e audit finale

Quando M5 non ha più blocker personali reali:

1. build/install/update sulla macchina dell'owner;
2. supervisor/reboot/logout dove la claim dipende da essi;
3. Telegram/provider/network reali per le journey che non possono essere
   concluse con un fake senza cambiare la claim;
4. `doctor` e stato live controllati;
5. fresh integrated red-team con la domanda terminale del mandato;
6. solo dopo: promozione `dev → main` secondo `BRANCHING.md` e inizio DAY 1.

## Parallel work che non modifica questo ordine

Direzione prodotto/open-source, installer consumer, community extensions,
public narrative e altre attività post-DAY-1 possono progredire in branch
separati quando non competono con il percorso critico. Non diventano Gate solo
perché sono interessanti.

## Regola di manutenzione

Aggiorna questo file soltanto quando cambia **l'ordine o una dipendenza**.

- una riga passa READY/BLOCKER/OUT → aggiorna M5;
- una PR apre/chiude → aggiorna Git/LAVORO;
- una nuova evidence cambia la causa radice o l'ordine → aggiorna qui.

Non barrare una cronaca di PR e non ricopiare conteggi M5: sono già posseduti
altrove.