# ADR-0001 — Runtime unico TypeScript/Node

**Contesto.** Il BRIEF ipotizza un ibrido Python (core/AI) + TypeScript (gateway). Vincoli: manutentore singolo; "Muffin costruisce Muffin"; nessun training di modelli in-process (l'inferenza è sempre dietro HTTP).

**Decisione.** Un solo runtime: Node ≥22 + TypeScript strict, ESM. Sidecar in altri linguaggi ammessi solo come processi esterni opzionali dietro contratto CLI/HTTP, etichettati impalcatura.

**Alternative scartate.** *Ibrido Py+TS*: paga due toolchain e un boundary di serializzazione per librerie (Python AI) che non servono senza training; il costo è permanente, il beneficio ipotetico. *Python unico*: butta 193K LOC di prova d'esistenza TS e la padronanza del manutentore; l'ecosistema TS 2026 è Tier-1 su tutto lo stack richiesto (MCP SDK v2, SDK provider, better-sqlite3/sqlite-vec). *Rust (à la Goose)*: performance non è il collo; costo di sviluppo per un singolo molto più alto.

**Conseguenze.** Più facile: un deploy, un debugger, dogfooding del proprio codice. Più difficile: se emergesse una dipendenza dura Python-only (es. una libreria di estrazione unica), va incapsulata come sidecar invece che importata.

**Reversibilità.** Costosa (è LA scelta di fondazione): cambiarla tra sei mesi = riscrittura. Segnale che era sbagliata: passare >20% del tempo a reimplementare in TS cose mature altrove, o un sidecar Python che diventa permanente e cresce.

---

## Emendamento 2026-08-21 — ADR-0050 restringe cosa significa «runtime unico»

La frase originale «sidecar in altri linguaggi … etichettati impalcatura» era corretta contro il fork iniziale **Python-core + TypeScript-gateway**, ma è diventata troppo forte dopo la runtime-topology decision.

ADR-0050 mantiene un solo **canonical Home runtime/authority** e non riapre un secondo core Python. Cambia però il giudizio sui processi di computation/execution esterni: un Worker può essere permanente e language-appropriate quando il boundary compra una proprietà reale — placement, resource lifecycle, crash/security isolation o una dipendenza che non ha senso reimplementare in TypeScript.

Esempi possibili:

```text
TypeScript Home/control runtime
        │
        ├─ Python Whisper/local-ML worker
        ├─ browser/execution worker
        └─ Node-local service
```

Questi processi non possiedono identity, canonical Work/Effects/Authority o il commit semantico delle Beliefs. Restano executor/compute dietro un contratto esplicito.

Quindi la proprietà durevole di ADR-0001 è ora:

> **Il core/Home runtime canonico resta TypeScript/Node; non si introduce un secondo runtime canonico per comodità di libreria. Worker esterni possono usare il linguaggio adatto quando il loro boundary è giustificato da un consumer reale.**

Un sidecar che diventa permanente non falsifica più da solo ADR-0001. Il segnale di falsificazione diventa invece: logica canonica/authority che migra sistematicamente fuori dal runtime TypeScript oppure più runtime che possiedono la stessa transizione semantica.