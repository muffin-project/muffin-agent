# Blueprint Muffin — indice di lettura

Refactor da zero di Muffin, prodotto in tre fasi (ricerca parallela → sintesi sequenziale → critica ostile) dal mandato in `BRIEF.md`. Verdetto sul nome: **Muffin**, senza suffisso (ADR-0012).

## Ordine di lettura consigliato

| File | Cosa contiene | Quando serve |
|---|---|---|
| `BRIEF.md` | Il mandato originale verbatim + Addendum owner №1 | Contesto di tutto |
| **`00-findings.md`** | Fase A: 12 finding, inventario keep/change/kill, prior art, standard, memoria, modelli | **Da qui** |
| `01-verdetti.md` | Verdetti su tutte le ipotesi di Livello 1 (V1-V13), nome, criterio di successo | Perché le scelte |
| `02-ontologia.md` | Memoria: TKG schema-light bi-temporale, provenienza, schema SQL, migrazione | Modulo memoria |
| `03-threat-model.md` | Kernel di policy, taint, sandbox, i percorsi d'attacco e dove si spezzano | Prima di ogni capability nuova |
| `04-roadmap.md` | M0-M7: cosa include, cosa no, DoD eseguibile, config, ordine strangler | Cosa costruire |
| `05-testing-evals.md` | 4 strati di test, suite memoria, red-team, cricchetto | Come si valida |
| `06-modelli.md` | Tier, approvvigionamento, lane, costi mensili per scenario | Scelte di modello |
| `07-durevole-vs-impalcatura.md` | Cosa sopravvive al prossimo salto di modello, cosa si smonta e a quale segnale | Prima di investire su un modulo |
| `08-assunzioni.md` | 39 scelte implicite da approvare esplicitamente | Revisione owner |
| **`09-contratti-m0-m1.md`** | **Normativo**: tipi, formati file, numeri del floor, boot, errori, CLI, dipendenze | **Per implementare** |
| `10-risoluzioni-fase-c.md` | Verdetti sulle 3 critiche ostili + la decisione che resta all'owner | Cosa è cambiato e perché |
| `adr/0001-0018` | Una decisione per file: contesto, alternative scartate, conseguenze, **reversibilità** | Quando una scelta va rimessa in discussione |
| `research/a1-a6` | Evidenza grezza con fonte (inventario, prior art, standard, memoria, modelli, sandbox) | Verificare un claim |
| `critique/c1-c3` | Le tre critiche ostili integrali | Vedere cosa è stato attaccato |

## Precedenza tra documenti

`09-contratti-m0-m1.md` è normativo sui dettagli di implementazione: dove contraddice un altro documento, vince. `10-risoluzioni-fase-c.md` registra le modifiche post-critica: dove un documento non fosse ancora allineato, vale la risoluzione. Gli ADR restano la fonte del *perché*.

## Cosa è nato dopo l'approvazione delle assunzioni (Fase D)

L'owner ha approvato le assunzioni #1-39 il 2026-08-04. Dopo di allora sono nate **due decisioni nuove** e sei verifiche:
- **ADR-0022** — un processo, ma con gate di priorità foreground e worker per il batch pesante (da B1).
- **ADR-0023** — media: doppio binario in ingresso, immagine+testo in uscita (da B3).
- Le sei verifiche di Fase D e le decisioni owner #40-45 sono in `08-assunzioni.md` (le voci superate sono barrate e rimandano a cosa le sostituisce).

## Stato

Fase A, B e C completate. Aperto: la decisione rewrite-vs-retrofit-vs-strangler (`10` §4, raccomandazione: strangler), la verifica delle collisioni di namespace per "muffin", la scelta del modello consumer-locale di riferimento via eval interna, e la licenza (owner).
