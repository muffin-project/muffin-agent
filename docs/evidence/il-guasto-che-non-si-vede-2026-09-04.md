# Il guasto che non si vede — caccia al ripiego muto, 2026-09-04

**Data:** 2026-09-04 · **Stato:** evidence datata, non authority · **Head:**
`slice/caccia-ripiego-muto` da `dev` `91b9528` · **Macchina:** macOS 25.0.
Un solo reperto, verificato rompendo la dipendenza per davvero e osservando
l'esito fuori dal codice; una riparazione applicata perché inequivocabile, con
test che va rosso se la si toglie. Il resto è ordinato per conseguenza, non per
quanti candidati ho aperto.

## 0. Come ho cercato, e perché il rapporto è corto

La richiesta iniziale prevedeva sette sotto-agenti in parallelo su territori
disgiunti; il coordinatore li ha fermati perché sette processi concorrenti
sullo stesso repository si contendono la CPU (vitest e tsc diventano lenti o
falliscono per contesa, non per difetto — vedi la voce di memoria "Rosso da
contesa, non da codice") e perché la richiesta era una caccia, non
un'orchestrazione. Ho ripreso da solo, seguendo l'ordine di priorità dato: (1)
un numero che l'owner legge in `doctor` o `vault check`, (2) l'ingestione
(vault, documenti, media, note vocali), (3) la consegna, (4) provider e rete.

Ho letto `cli/doctor.ts` (1491 righe), `core/vault/vault.ts`,
`core/documents/extract.ts`, `core/audio/trascrivi.ts`,
`agent/tools/search.ts`, `core/budget/budget.ts`, `core/turns/store.ts` e
`connectors/telegram/media.ts` — le zone che coprono le quattro priorità e non
sono nella lista di territorio già assegnato. La maggior parte è già stata
oggetto di cacce precedenti, documentate nel codice stesso con incidenti
misurati e numeri di judge/PR (`cli/doctor.ts` cita esplicitamente il
precedente "documenti a zero" e la propria disciplina di non fidarsi di un
PATH che esiste; `core/vault/vault.ts` cita Khoj e Reor come precedenti dello
stesso guasto di classe). In quelle zone non ho trovato niente che rompessi
davvero e che mentisse: le ho lasciate come "domande poste senza reperto" più
sotto, non come reperti.

Un'area — `core/vault/vault.ts` — aveva comunque un caso non coperto dalla sua
stessa disciplina, ed è il reperto di questo rapporto.

---

## 1. Reperto — `identityOf` collassa "illeggibile" in "non è un formato che sappiamo leggere", e `audit()` lo cancella dal conto

**File:** `core/vault/vault.ts` (prima della riparazione: funzione `identityOf`,
riga 628; chiamata da `reindex`/`indexScan` riga 366, e da `audit` riga 558 —
righe dell'HEAD di `dev` al momento della caccia, `91b9528`; dopo la
riparazione la funzione si è spostata a riga 687 e i chiamanti a 366-388 e
547-593, per via del codice aggiunto).

### Cosa fallisce

`identityOf(path)` fa `readFileSync(path)` dentro un `try` e ritorna `null` sia
se il file **non si può leggere** (permessi tolti, errore di I/O, un file
sparito fra l'enumerazione di `list()` e questa riga) sia se il file **si legge
benissimo ma non è un formato che sappiamo trattare** (immagine, archivio,
nota vuota). Tre cause distinte — "non so se questo è indicizzabile perché non
riesco ad aprirlo" contro "l'ho aperto, e non c'è niente da indicizzare" —
diventavano lo stesso `null`, e i due chiamanti (`indexScan` per `reindex`,
il primo ciclo di `audit`) leggevano quel `null` come "bytes che nessun
estrattore gestisce" **sempre**, anche quando la vera causa era la prima.

### Come l'ho rotto, per davvero

Script eseguito con `npx tsx` dentro il worktree, usando lo stesso fixture di
`core/vault/vault.test.ts` (`MemoryStore` su `:memory:`, `Vault` sulla
directory vera):

```js
writeFileSync(join(root, 'segreto.txt'),
  'questo appunto invece perde il permesso di lettura subito dopo essere stato scritto, ma il contenuto ci sarebbe.');
chmodSync(segreto, 0o000);          // owner del file, chmod 000: EACCES confermato con `cat`

const report = await vault.reindex('tenant-owner');
console.log(JSON.stringify(report.skipped, null, 2));
```

Uscita, **prima** della riparazione:

```json
[
  {
    "path": "segreto.txt",
    "why": "non è testo né PDF né DOCX — serve un estrattore"
  }
]
```

Falso: il file è un `.txt` con contenuto vero, e "serve un estrattore" non ha
rimedio possibile per un problema di permessi. E per `vault.audit('tenant-owner')`
sullo stesso file, mai indicizzato prima:

```json
{ "files": 0, "indexed": 0, "missing": [], "stale": [], "orphaned": [] }
```

`muffin vault check` — il comando che esiste, per parole del suo stesso
commento in `cli/vault.ts`, "perché il meccanismo che funziona non è la stessa
cosa dell'indice giusto" — avrebbe stampato `0 file leggibili sul disco · 0
indicizzati` seguito da `indice allineato`, **exit 0**, con un documento vero
seduto nel vault che nessuno vedrà mai indicizzare. È esattamente il guasto che
il modulo cita da Khoj (`khoj#1105`, "hash calculations complete normally" e
poi si ferma senza indicizzare) e da Reor (`reor#118`, un watcher che aggiorna
la UI ma non il vector DB) nel proprio commento di testa — riprodotto qui da
un bit di permesso invece che da un bug di percorso.

Ho anche verificato la terza causa collassata nello stesso `null`: una nota
di solo spazi bianchi. Il docstring di `identityOf` diceva *"An empty note is
`null` too: it is what `reindex` skips as `vuoto`"* — ma il codice, prima
della riparazione, dava lo stesso messaggio "serve un estrattore" anche a
questa, contraddicendo il proprio commento:

```json
[ { "path": "vuoto.txt", "why": "non è testo né PDF né DOCX — serve un estrattore" } ]
```

### Cosa direbbe se fosse riparato

Le tre cause ora sono distinte. `identityOf` ritorna un tipo a tag
(`{kind:'ok', …} | {kind:'unsupported'} | {kind:'empty'}`) e lascia propagare
l'errore di lettura invece di inghiottirlo:

- `reindex`/`indexScan` (`core/vault/vault.ts:366-388`): un file illeggibile
  ora dice `illeggibile: EACCES: permission denied, open '…/segreto.txt'` —
  il vero errore del sistema operativo, non un'affermazione falsa sul formato.
  Una nota vuota dice `vuoto`, come il commento aveva sempre promesso.
- `audit()` (`core/vault/vault.ts:547-597`): un nuovo campo `unreadable:
  string[]` su `VaultAudit` porta il file al conto invece di farlo sparire —
  distinto da `missing` (un reindex non risolverebbe un problema di permessi)
  e da `orphaned` (il file non è sparito dal disco, è lì e illeggibile). Un
  file già indicizzato che diventa illeggibile in seguito finisce in
  `unreadable` e non finisce **anche** in `orphaned` (guardia esplicita,
  perché altrimenti l'audit direbbe "cancella questa riga", falso: il file
  esiste ancora).
- `cli/vault.ts` (`cmdVaultCheck`): stampa `! sul disco, illeggibile ora
  <path>` e lo somma al conteggio del drift, quindi `muffin vault check` non
  torna più pulito su un vault con un file che non si può aprire.

Ricontrollato dopo la riparazione, stesso script:

```json
[ { "path": "segreto.txt", "why": "illeggibile: EACCES: permission denied, open '…/segreto.txt'" } ]
{ "files": 0, "indexed": 0, "missing": [], "stale": [], "orphaned": [], "unreadable": [ "segreto.txt" ] }
[ { "path": "vuoto.txt", "why": "vuoto" } ]
```

### Conseguenza per l'owner

Un documento reale nel vault — una nota, un contratto, qualunque cosa perda il
permesso di lettura per una causa banale (un `chmod` sbagliato di un altro
strumento, un mount di rete con ACL strane, un file scritto da un processo con
uid diverso) — non viene indicizzato **e nessun comando lo dice**: né
`reindex` (messaggio falso e senza rimedio), né `audit`/`vault check` (il file
sparisce dal conto). Rispetto al precedente citato nel brief ("indicizzazione
a zero da sempre, verde in ogni test"), qui il danno è per singolo file
piuttosto che per l'intero vault — ma è la stessa classe di guasto, e ho
verificato che si propaga fino al connettore: `connectors/discord/connector.ts:526-527`
mostra all'owner, dentro la chat, esattamente la stessa stringa `skipped.why`
per un allegato appena scaricato — con la riparazione, un allegato che arriva
e diventa illeggibile per una race sul filesystem ora dice la causa vera
invece di "serve un estrattore" su un file che ovviamente ha un formato
gestito (è appena arrivato via Bot API).

### Riparazione, e come si rompe togliendola

File toccati: `core/vault/vault.ts`, `cli/vault.ts`, `core/vault/vault.test.ts`.
Tre test nuovi in `core/vault/vault.test.ts`, più un'asserzione aggiunta a un
test esistente:

1. *"un file diventato illeggibile non è «serve un estrattore»: reindex dice
   perché non può leggerlo"* — `chmod 000` su un file scritto, verifica che
   `skipped[].why` contenga `illeggibile` e non `estrattore`.
2. *"un documento illeggibile non torna «indice allineato»: audit lo nomina,
   non lo cancella dal conto"* — verifica `audit().unreadable === ['segreto.txt']`
   e che non finisca né in `missing` né in `orphaned`.
3. *"un file indicizzato che poi diventa illeggibile non è «orphaned»"* —
   indicizza, poi toglie il permesso, verifica che non compaia in `orphaned`.
4. Asserzione aggiunta al test esistente *"skips binaries and says why…"*:
   `vuoto.md` deve avere `why === 'vuoto'`, non il messaggio generico.

**Mutazione eseguita**: ripristinato `core/vault/vault.ts` alla versione
`HEAD` (pre-riparazione) tenendo il nuovo `vault.test.ts`, rilanciato
`npx vitest run core/vault/vault.test.ts`. Risultato: **4 test falliti su 31**
— esattamente e soltanto i quattro sopra, con l'asserzione che li ha presi
riportata nell'output (`expected 'non è testo…' to be 'vuoto'`, `to contain
'illeggibile'`, `expected undefined to deeply equal ['segreto.txt']` ×2).
Ripristinata poi la riparazione: **31/31 verdi**.

Verifica eseguita, numeri veri:

| comando | esito |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0, nessun output |
| `npx vitest run core/vault/vault.test.ts` | **31 test, 1 file, tutti verdi** |
| `npx vitest run core/vault/vault.test.ts` (con la riparazione tolta) | **4 falliti su 31**, gli stessi quattro nuovi |
| `npx vitest run` (suite intera) | vedi §3 |

---

## 2. Domande poste senza reperto

Candidati considerati e non promossi, perché non li ho rotti per davvero o
perché la lettura del codice mostra una scelta di prodotto già ragionata,
non un guasto accidentale.

- **`quantiNonIndicizzatiSafe` e `countOrNull` (`cli/doctor.ts:1384-1422`)**
  inghiottono *qualunque* eccezione in `0`/`null`, non solo "tabella
  mancante" come dice il commento. Ho verificato che lo scenario più
  plausibile — `chunks` presente senza `episodes`/`facts`/`entities` — non è
  raggiungibile in produzione: `agent/runtime.ts:522-529` costruisce sempre
  `MemoryStore` (che crea le tabelle di memoria) **prima** di `VectorIndex`
  (che crea `chunks`), quindi le due famiglie di tabelle nascono sempre
  insieme. Non ho trovato un modo pulito, senza indurre contesa artificiale
  su SQLite (la cosa che il coordinatore ha già segnalato come rumore, non
  difetto), di far fallire quella query per una causa diversa da "tabella
  assente". Resta un `catch` più largo del necessario, ma non l'ho potuto
  rompere: lo lascio come domanda, non come reperto.
- **`readUndelivered`/`health` con `DOCTOR_WINDOW_MS = 24h`
  (`core/turns/store.ts:1104-1119, 1144-1148, 1270`)**: un turno la cui
  consegna non si è mai confermata smette di comparire in `doctor` dopo 24
  ore, per sempre, anche se la riga nel database resta `pending` o
  `possibly_sent`. Il codice lo dichiara esplicitamente come scelta
  ("rows are never deleted... they simply stop being today's news"), pensata
  per la domanda "è successo un crash rilevante oggi" — ma `undelivered()`
  riusa la stessa soglia per una domanda diversa: "questo messaggio è mai
  arrivato". Le due domande non invecchiano allo stesso modo: un crash di tre
  giorni fa è storia, un messaggio mai confermato di tre giorni fa è ancora
  un messaggio che l'owner forse non ha mai ricevuto. È una decisione di
  prodotto dichiarata, non un ripiego muto — la segnalo perché il
  ragionamento che la giustifica per `health()` non si applica automaticamente
  a `undelivered()`, ma non l'ho "rotta": nessuna riga del codice mente, dice
  esattamente cosa fa e perché.
- **`agent/tools/search.ts`, `core/audio/trascrivi.ts`, `core/budget/budget.ts`,
  `connectors/telegram/media.ts`, `connectors/discord/connector.ts`**: letti
  per intero cercando lo stesso schema (un `catch` che restituisce un valore
  plausibile, un contatore senza durata, un `null` a doppio significato). In
  tutti questi la disciplina è già quella giusta: unioni chiuse (`Extraction`,
  `Trascrizione`, `Prerequisito`) che non lasciano un "vuoto per un motivo
  nessuno ha registrato", `isError`/`retryable` distinti da un risultato
  vuoto, e ogni fallimento propagato o loggato con la causa vera. Non ho
  trovato niente da rompere lì che mentisse.

---

## 3. Verifica eseguita sull'albero intero

| comando | esito |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0, nessun output |
| `npx vitest run` (prima corsa, prima di rigenerare la mappa) | **1 fallito su 248 file** — `docs/derived/architecture-map/mappa.test.ts`, un'ancora spostata dalle righe aggiunte a `core/vault/vault.ts`; 3180 passati, 3 skippati |
| `node docs/derived/architecture-map/ancore.mjs && node docs/derived/architecture-map/build.mjs` | `588 ancore scritte`, `400 hanno seguito il codice spostato`, `mappa.html: 289 KB · 588 ancore` |
| `npx vitest run` (dopo la rigenerazione, prima del rebase) | **248 file, 3181 test passati, 3 skippati, 0 falliti** |
| `git rebase origin/dev` (`91b9528`, un commit di sicurezza arrivato durante la caccia, senza conflitti con `core/vault/`) | pulito; l'hook `post-merge-regen` ha rigenerato la mappa da solo su un commit aggiuntivo |
| `npx tsc --noEmit -p tsconfig.json` (dopo il rebase) | exit 0 |
| `npx vitest run` (dopo il rebase — numeri finali) | **249 file, 3187 test passati, 3 skippati, 0 falliti**, 95,2s |

Nessuna copia di stato privato dell'owner è entrata nel repository: i vault
usati per rompere `identityOf` erano directory temporanee sotto `/tmp`,
cancellate a fine sessione. Nessun processo di prova è rimasto vivo: gli
script di riproduzione erano fuori dall'albero tracciato (`repro-*.mjs` nella
radice del worktree, cancellati) e i comandi `vitest`/`tsc` sopra sono
terminati da soli, senza demoni residui da fermare per PID.
