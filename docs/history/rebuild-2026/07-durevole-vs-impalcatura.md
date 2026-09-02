# 07 — Durevole vs impalcatura

> Regola del BRIEF: l'impalcatura serve adesso, ma va etichettata e isolata così che toglierla non richieda riscritture. Per ogni impalcatura: **quale limite del modello la giustifica** e **quale segnale dice che è ora di smontarla**. E la domanda inversa: cosa diventa PIÙ importante coi modelli migliori.

## 1. La tesi dell'owner, verificata

"Più il modello è capace, più conta cosa gli è permesso fare" — **CONFERMATA dall'evidenza**, non solo plausibile: (a) Anthropic distribuisce il proprio top-model in due varianti che differiscono SOLO per salvaguardie (Fable pubblico / Mythos ad accesso ristretto perché "trova e sfrutta vulnerabilità meglio di quasi ogni umano esperto" — A5 §1.1): il contenimento è già oggi il differenziale di prodotto al vertice; (b) la storia CVE di OpenClaw mostra che il danno scala con le capability, non con la stupidità del modello; (c) ogni salto di capability rende più preziosi esattamente i pezzi sotto etichettati "durevoli". Corollario progettuale: investire in kernel/taint/audit non è overhead prudenziale — è la parte dell'architettura che apprezza nel tempo.

## 2. Classificazione per modulo

| Modulo | Classe | Se impalcatura: limite che la giustifica → segnale di smontaggio |
|---|---|---|
| M0 kernel/RoT/policy/budget/audit | **DUREVOLE** | — (più capace il modello, più serve) |
| M0 tracing OTel | **DUREVOLE** (il tracing) / impalcatura (il pin di versione) | semconv `gen_ai.*` Development → smonti il pin quando diventa Stable |
| M1 loop unico | **DUREVOLE** | — |
| M1 profili per-modello (stampelle: subset tool, recovery cascade, structured-output forzati, thinking toggle) | **IMPALCATURA** | tool-calling fragile dei modelli piccoli → il segnale è la CI di capability: quando il riferimento consumer passa il floor col profilo "neutro", il profilo con stampelle si spegne |
| M1 context assembly cache-stable | **IMPALCATURA** (l'ordinamento per cache) / durevole (la stratificazione semantica) | economia del caching (write 1.25-2×/read -90%) → se il pricing cambia forma o il context diventa "gratis", resta solo l'ordine semantico |
| M2 episodi + provenienza + bi-temporalità + tenancy | **DUREVOLE** | — (è il confine dati, non un workaround) |
| M2 compattazione/digest, recall budget, reranking | **IMPALCATURA** | context finito e attenzione degradante → segnale: long-context *effettivo* (non claimed) che copre la storia viva a costo accettabile — allora il recall diventa selezione leggera e i digest decorativi |
| M2 giudice di contraddizione | **DUREVOLE** nel ruolo, impalcatura nell'implementazione (LLM-judge dedicato) | modelli deboli su contradiction (problema aperto del campo) → quando il main-model la fa in-context in modo misurato-affidabile, il giudice separato collassa nel loop |
| M3 primitivi host + capability declarations | **DUREVOLE** | — |
| M3 sandbox di esecuzione (Seatbelt/bubblewrap + proxy egress) | **DUREVOLE** | — (più capace il modello, più conta il contenimento; e con code-execution il sandbox è l'unico meccanismo residuo — A6 §4.2) |
| M3 skill SKILL.md | **DUREVOLE** come formato (standard esterno), contenuto rivedibile | — |
| M4 transport tipato + renderer capability-aware | **DUREVOLE** (il contratto), istanze sostituibili | — |
| M5 cron compilato + event-bus | **DUREVOLE** | — |
| M5 gate di proattività (soglia esplicita, quiet-hours, tier ≤1) | **DUREVOLE** il gate di *permesso*; impalcatura la *soglia euristica* | il modello non sa ancora giudicare "vale un'interruzione" → segnale: eval di proattività (precision/recall degli interventi giudicati utili dall'owner) sopra soglia per N settimane → la soglia passa da euristica a giudizio del modello, il gate di permesso resta |
| M6 introspezione sui trace | **DUREVOLE** (il differenziale) | — |
| M6 cricchetto eval-gated | **DUREVOLE** il gate; impalcatura la *taglia* del perimetro auto-applicabile | fiducia non ancora guadagnata → il ladder si allarga con lo storico di canary puliti (ma il ladder resta config nel RoT) |
| M7 isolamento tenant | **DUREVOLE** | — |
| Lane statiche main/light | **IMPALCATURA** | costo del frontier → segnale: il trend prezzi (>10×/12-18 mesi) porta il modello "buono" sotto la soglia di indifferenza per il tuo volume → collassa a una lane sola (la struttura a lane è 3 righe di config: smontarla è banale per design) |
| Locale come profilo separato | **IMPALCATURA** economica/privacy oggi, potenzialmente durevole per sovranità | hardware consumer insufficiente per il tier alto → segnale: un open-weight consumer passa il floor *e* il costo totale (hw ammortizzato+energia) batte l'API per il tuo volume |
| Recovery cascade / retry su tool falliti | **IMPALCATURA** | affidabilità tool-calling → segnale: tasso di retry effettivo ~0 per M mesi nella telemetria |

## 3. Regola di isolamento (come si garantisce lo smontaggio senza riscrittura)

Ogni impalcatura vive in **un** posto con un confine netto: i profili in `agent/profiles/*` (file dichiarativi), il pin OTel in `core/tracing/`, l'ordinamento cache in `agent/context/`, le soglie in config-ratchet. Il core non contiene `if` che conoscono l'impalcatura: legge contratti (profilo, config). Test di onestà in CI: la suite gira anche con "profilo neutro" (tutte le stampelle spente) sul modello frontier — se qualcosa si rompe, un'impalcatura è colata nel core, ed è un bug architetturale da trattare come tale.
