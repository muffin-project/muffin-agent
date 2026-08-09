# Knowledge base — il corpus cognitivo del vecchio Muffin, curato per il nuovo

> Creato 2026-08-09 dal survey del corpus vecchio (agente). **Perché esiste**: il
> blueprint nuovo ha portato avanti la SOTA *ingegneristica* della memoria
> (`research/a4-memoria.md`: Zep, Mem0, Letta, HippoRAG…) ma **non** il corpus
> *cognitivo/neuroscientifico* né il **design della spina osservante**. Quelli
> vivono solo nei doc del vecchio Muffin. Qui li curiamo per essere **pescabili
> durante il building**.

## La distinzione (perché è una cartella a parte)

- `research/` — *cosa fa la SOTA esterna oggi* (paper, competitor, standard).
- `adr/` — *cosa abbiamo deciso* (append-only, datato).
- `knowledge/` (questa) — *cosa abbiamo capito noi e perché* — il corpus cognitivo
  accumulato, curato con **VIVO/SUPERATO** in testa a ogni voce e link alla fonte
  vecchia + all'ADR nuovo che eventualmente la supera.

## La regola

**Prima di progettare un organo cognitivo (memoria, proattività, specchio,
retrieval), leggi il file di tema qui.** Ogni voce dice cos'è vivo, cos'è morto
(e *perché* — la rete di sicurezza contro il ri-costruire errori già pagati), e
dove sta la fonte.

**La regola vera è più forte di "porta avanti il vecchio".** Che un concetto
esistesse nel vecchio Muffin non vuol dire che fosse fatto *bene* — metà del
graveyard è roba rimossa perché non funzionava. Questa knowledge base tiene i
**princìpi** (il perché neuroscientifico); il lavoro è **ri-esprimere ogni
principio come una primitiva — o una proprietà di una primitiva — messa dove ha
senso nell'architettura nuova, fatta bene, con la sua harness.** L'implementazione
vecchia è **riferimento**, non il target. Niente moduli-cognitivi bolt-on che
mezzo-funzionano: il principio si incarna nel primitivo giusto (schema memoria,
ranking del recall, decay, gate di proattività, assemblaggio del contesto), non in
un ennesimo modulo a lato. È la stessa filosofia del "syscall layer, non 52 tool".

## I 7 criteri con cui calibriamo (le 6+1 dimensioni di `UNDERSTANDING.md`)

Capire ≠ contare. Un fatto/evento non vale per quante volte compare:

1. **Intensity ≠ frequency** — un evento una-volta ma carico batte 1000 di routine.
2. **Affect signature** — la carica emotiva modula encoding e retrieval.
3. **Trend** — la direzione nel tempo, non solo il valore corrente.
4. **Context specificity** — dove/quando/con-chi, non il fatto nudo.
5. **Silenzio come segnale** — ciò che smette di comparire è spesso più informativo.
6. **Significance irreducible** — alcune cose contano e basta, non si derivano.
7. **Confidence** (+`source`: detto/inferito) — quanto siamo sicuri, e come lo sappiamo.

Questi sono i **criteri**, non decorazioni: la spina osservante e la memoria si
progettano sopra questi, non sul conteggio ingenuo.

**Il principio che li attraversa: dimenticare è una feature, non un bug.** Il
cervello dimentica per funzionare; muffin scarta il suo processing-cruft per non
soffocare. MA il decay è **pesato per importanza** (criterio 1) *e* **per
complemento**: muffin tiene ciò che *noi* lasciamo cadere ma ci serve (l'impegno,
il dettaglio, il volo dimenticato) — memoria solida dove la nostra è debole, per
ridurre il carico cognitivo. Non copia l'oblio umano: lo **complementa**. È il
valore stesso dell'assistente.

## Indice (port in ondate — la routine settimanale ne prende uno per volta)

| File | Tema | Stato port |
|---|---|---|
| `04-learn-from-absence.md` | Imparare dall'assenza/silenzio — §5 + `dream_phase_i.ts` I.6 | ✅ portato (esemplare) |
| `03-observing-spine.md` | La spina osservante — Forma A/B, awareness-loop, decider 4-gate, P-I | ✅ portato |
| `00-cognitive-bases.md` | `COGNITIVE_BASES.md` — antipattern→principio→mossa (8 sezioni) | ⏳ |
| `01-understanding.md` | `UNDERSTANDING.md` — le 6+1 dimensioni; **la formula somma-pesata è superata**, le dimensioni no | ✅ portato |
| `02-references.md` | Bibliografia annotata (~25 paper) — ri-verificare gli arXiv | ⏳ |
| `05-person-model.md` | living_profile / counterpoint / self-narrative / affect / patterns | ⏳ |
| `06-graveyard.md` | Esperimenti morti col LORO razionale (NON ri-aggiungere) | ⏳ |
| `07-common-ground.md` | Common ground / ToM annidata (io so, muffin sa cosa so…) — **infer-then-condition**; 2°-ordine NON validato (collo: coerenza cross-contesto) | ⏳ |

**Priorità**: `04` e `03` prima (il materiale che il blueprint NON ha e che l'owner
nomina), poi il corpus cognitivo (`00`/`01`/`02`), poi `05`/`06`.

## Cimitero rapido (dettaglio in `06-graveyard.md`) — NON ri-aggiungere

- **Belief revision** (`bot_claims*`) — RIMOSSO 2026-06-18: 8 iniezioni/30gg, ZERO
  revisioni. Coperto da counterpoint + `/bias`.
- **Verify pillar** (`unknown_terms`) — RIMOSSO ADR-151: F1 0.61, ~50% falsi
  positivi. Il modello verifica via web_search. (Il principio cognitivo dietro
  resta valido come lente.)
- **Classifier deittico euristico** (`utils/deictic.ts`) — RIMOSSO ADR-153:
  bloccava ~11% di ricerche legittime. Il modello risolve la deissi nativamente.

## Fonti vecchie (repo attuale, `docs/` e `src/`)

`docs/foundations/{COGNITIVE_BASES,UNDERSTANDING,REFERENCES,THESIS,PRINCIPLES,VISION,INVARIANTS}.md`
· `docs/pillars/{memory,planning}/…` · `context/HEARTBEAT.md` ·
`src/memory/CLAUDE.md` · `src/memory/dream_phase_i.ts` · `docs/DECISIONS.md` (ADR-066).
**Curatela**: allineare a `src/memory/CLAUDE.md` (fonte-codice) più che ai `.md`
datati, che driftano.
