# Blueprint Muffin — indice di lettura

Refactor da zero di Muffin, prodotto in tre fasi (ricerca parallela → sintesi sequenziale → critica ostile) dal mandato in `BRIEF.md`. Verdetto sul nome: **Muffin**, senza suffisso (ADR-0012).

## Ordine di lettura consigliato

| File | Cosa contiene | Quando serve |
|---|---|---|
| `../THESIS.md` + `../foundations/VISION.md` | La scommessa e la nord-stella: un agente continuo, tre assi, molte superfici | Prima di cambiare direzione di prodotto |
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
| `adr/0001-0043`, `0045-0046` | Decisioni integrate: contesto, alternative, conseguenze, **reversibilità**. ADR-0044 resta su `slice/taint-in-ingresso` finché quella slice non viene fusa | Quando una scelta va rimessa in discussione |
| `research/a1-a6`, `b1-b3` | Evidenza grezza di Fase A/D con fonte (inventario, prior art, standard, memoria, modelli, sandbox; runtime, multimodale, media) | Verificare un claim |
| `research/` (il resto) | Ricerche nate durante il building, una per domanda: confronto coi peer, inventario vecchio-nuovo, **confronto con la consulenza esterna**, superficie capability, architettura del system prompt, proattività, salienza e fusione, caching per-connector, benchmark, EU AI Act, onboarding, dev-setup | Prima di progettare l'organo di cui parlano |
| `knowledge/` | Il corpus cognitivo — cosa abbiamo capito noi e perché, con VIVO/SUPERATO in testa a ogni voce | **Prima di progettare un organo cognitivo** (memoria, proattività, specchio, retrieval) |
| `critique/c1-c3` | Le tre critiche ostili integrali | Vedere cosa è stato attaccato |

## Precedenza tra documenti

`09-contratti-m0-m1.md` è normativo sui dettagli di implementazione: dove contraddice un altro documento, vince. `10-risoluzioni-fase-c.md` registra le modifiche post-critica: dove un documento non fosse ancora allineato, vale la risoluzione. Gli ADR restano la fonte del *perché*.

## Cosa è nato dopo l'approvazione delle assunzioni (Fase D)

L'owner ha approvato le assunzioni #1-39 il 2026-08-04. Dopo di allora sono nate **due decisioni nuove** e sei verifiche:
- **ADR-0022** — un processo, ma con gate di priorità foreground e worker per il batch pesante (da B1).
- **ADR-0023** — media: doppio binario in ingresso, immagine+testo in uscita (da B3).
- Le sei verifiche di Fase D e le decisioni owner #40-45 sono in `08-assunzioni.md` (le voci superate sono barrate e rimandano a cosa le sostituisce).

## Stato

**Questo paragrafo non è la fonte dello stato: lo è `STATE.md`**, che è anche il
blocco iniettato a ogni sessione. Qui resta solo la fase di *questo* blueprint —
Fase A, B, C e D completate — perché è ciò che il documento descrive.

Delle quattro voci che questa sezione elencava come aperte, **tre sono chiuse**
(strangler scelto in `10` §4 e nell'ordine di costruzione di `04`; namespace
verificato in ADR-0012 §verifica; licenza **MIT** in ADR-0019) e tenerle qui
faceva sembrare aperte cose decise. **Una è ancora aperta** e vive in `STATE.md`
§Aperto: la scelta del modello consumer-locale di riferimento, da rivalutare a
metà agosto 2026.
