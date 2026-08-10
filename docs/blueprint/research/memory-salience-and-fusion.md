# Ricerca — salienza nella memoria agentica, e come (non) pesarla dentro RRF

> Commissionata 2026-08-09 per decidere **due cose sole**: (a) `importance` sui
> fatti — continua o ordinale? (b) dove agisce, dato che il recall fonde con RRF?
> Scout con mandato di etichettare ogni claim **misurato · riportato-senza-ablation
> · folklore**. Le quattro affermazioni portanti sono state **ri-verificate a mano**
> sulla fonte primaria (marcate ✔ sotto) prima di scrivere questo file.

## Bottom line

1. **`importance` ordinale a 3 livelli, non continua.**
2. **Non entra in RRF.** Va dove l'evidenza misurata la mette: **ritenzione**
   (cosa sopravvive), più un taglio bounded al cut.
3. **`origin` (detto/inferito) è il campo meglio fondato dei due** — e non è
   `trust_tier` con un altro nome.
4. Il termine `importance` nella formula di retrieval di Park et al. **non è mai
   stato ablato**: è folklore ereditato, non un risultato.

---

## 1. Il termine di importance a retrieval non è mai stato misurato ✔

**Verificato a mano** sul testo pieno (ar5iv, arXiv:2304.03442). La formula è
`score = α_recency·recency + α_importance·importance + α_relevance·relevance`, e
il paper dice testualmente **"all αs are set to 1"**. Le condizioni ablate sono
tre, e sono *tipi di memoria*, non componenti del retrieval:

1. no observation / no reflection / no planning (nessun accesso al memory stream)
2. no reflection, no planning (solo observations)
3. no reflections (observations + plans)

**Il peso di importance non compare in nessuna.** Mai variato, mai messo a zero.
Un'affermazione molto citata — "senza importance gli agenti diventano piatti" —
**non è nel paper** e lo scout non è riuscito a rintracciarla: va trattata come
folklore.

Il survey 2026 sulla memoria agentica (arXiv:2603.07670) elenca ancora *come
stimare l'importanza* fra le **domande aperte** — e le parole "salience",
"poignancy", "provenance" non compaiono affatto nel survey.

**MemoryBank** (arXiv:2305.10250), citato ovunque come prova di "decay pesato per
importanza", in realtà implementa **frequenza**: la memory strength `S` parte a 1
e **viene incrementata di 1 a ogni recall**. È un contatore di richiami — cioè
esattamente il regime dei-1000-eventi-di-routine che noi rifiutiamo. Gli autori
stessi lo chiamano *"exploratory and highly simplified"*. Nessuna ablation.

**L'unica ablation credibile è sulla ritenzione, non sul ranking**: SF-AMS
(arXiv:2607.22562) toglie la salienza semantica dal suo scoring e il multi-hop
crolla 37.59 → 14.60 su LoCoMo/Qwen2.5-7B. Ma è **una policy di cosa tenere**,
non un boost di ranking — e vale un paper solo, modello 7B, F1 assoluti bassi.

> **Asimmetria da cui deriva tutto il design**: importance-a-ritenzione ha
> un'ablation; importance-a-ranking non ne ha nessuna, in nessun sistema.

## 2. Perché ordinale a 3 livelli (e mai dentro `confidence`)

- **Scala 1-10 = la scelta peggiore, misurata.** arXiv:2601.03444 (gen 2026):
  aggregando i task, **0-5 dà l'allineamento umano più forte e 0-10 è
  costantemente il più debole**. Park usa 1-10.
- **Bias di tendenza centrale, non eliminabile col prompt.** arXiv:2605.16386:
  i rating si comprimono verso il centro, con **sotto-predizione sistematica
  dell'estremo alto** — né esempi few-shot su tutto il range né la rimozione del
  gergo lo tolgono. Fatale qui: "l'evento singolo ma carico" **vive esattamente
  nell'estremo alto che il rater sotto-predice**.
- **~55% della varianza non spiegata** dai criteri della rubrica
  (arXiv:2509.20293), e le dimensioni distinte collassano in un unico giudizio
  latente (correlazioni di rango spesso >0.93).

Quindi: **forced-choice, non rating**. Due sì/no in estrazione — "l'owner si
arrabbierebbe se lo dimenticassi?" e "è un evento singolo e carico, non
routine?" — con `2` solo se entrambi, `1` se il primo, altrimenti `0`. Su un
binario non si può ammucchiare al centro.

**Regola dura: `importance` non tocca mai `confidence` né `trust_tier`.**
Talarico & Rubin 2003 (Psychological Science) è netto: nei flashbulb memories
l'accuratezza **non** differiva e decadeva uguale, mentre vividezza e *fiducia
nell'accuratezza* restavano alte solo lì. L'intensità alza la confidenza
percepita, **non** l'accuratezza. È l'estensione naturale del nostro invariante
"la fiducia non sale mai": **l'importanza non è evidenza.**

## 3. L'aritmetica che decide dove NON mettere il boost ✔

**Ricalcolata a mano** sul nostro `K = 60` (`core/memory/recall.ts:89` usa
`1/(K + rank + 1)` con rank 0-based ≡ `1/(60+r)` con r 1-based):

| quantità | valore |
|---|---|
| contributo a rank 1 | 0.016393 |
| gap fra rank adiacenti in cima (1→2) | **0.000264** |
| span rank 1 → rank 8, una sola lista | **0.001688** |
| valore di comparire in una **seconda** lista a rank 1 | **0.016393** |

Il rapporto è **62×**: l'accordo fra due ranker vale 62 gap adiacenti. Da cui le
soglie, che sono aritmetica, non opinione:

- `B > 0.00026` → riordina ranghi adiacenti (intervento minimo sensato)
- `B ≥ 0.00169` → **importance riordina completamente il top-8 di un ranker**:
  la lista diventa "ordinata per importanza, spareggiata dal retrieval", e
  continua a *sembrare* una lista rilevante. Fallimento invisibile senza eval.
- `B ≥ 0.0164` → importance batte il **consenso fra ranker**: un fatto trovato da
  un solo ranker supera un fatto su cui FTS e vettori erano d'accordo. Distrugge
  l'unica cosa che RRF misura davvero.

**Moltiplicativo è strettamente peggio di additivo**: `rrf·(1+λ·imp)` scala anche
il termine di consenso, quindi il boost effettivo di un fatto dipende da *quanti
ranker l'hanno pescato* — compounda proprio col segnale contro cui compete.

**Nessun sistema di produzione mette un prior per-documento dentro la fusione.**
Elasticsearch, OpenSearch, Azure AI Search e Weaviate pesano le *liste*, non gli
item, e il prior per-documento entra o *dentro* un ranker (`rank_feature`, in
forma **saturante** `S/(S+pivot)`) o in uno **stadio separato dopo**. Graphiti —
il sistema KG-memoria più vicino al nostro — **✔ verificato a sorgente**: `rrf()`
ha `rank_const=1` (non 60), **nessun peso per-item**, e i suoi reranker
(`node_distance_reranker`, `episode_mentions_reranker`, MMR) sono stadi che
**sostituiscono** l'ordine RRF invece di mescolarsi. Nota: il suo prior di
frequenza è implementato proprio come stadio separato.

**Corollario onesto**: anche il nostro `K=60` è **una costante ereditata, non
misurata**. Bruch et al. (arXiv:2210.11934, TOIS, peer-reviewed) mostra che RRF
*è* sensibile ai parametri, contro la sua fama di parameter-free. Va nella lista
dei numeri-folklore accanto a `SUPERSEDE_THRESHOLD` e `limit=8`.

## 4. `origin` (detto/inferito) — il campo meglio fondato

- **arXiv:2606.12945** ("Learning What to Remember") è essenzialmente il nostro
  design, misurato con ablation a fattore singolo: **reliability = un'euristica
  di provenienza "user-stated > model-stated" → 0.497**, contro self-relevance
  0.518 e **emotional intensity 0.201**. Cioè: **detto-vs-inferito da solo vale
  ~2.5× l'intensità emotiva da sola.** (Caveat: la loro intensità è estratta
  lessicalmente, quindi 0.201 misura in parte un estrattore debole; e il task è
  ritenzione, non ranking.)
- **arXiv:2607.29433** ("Know It, Act on It"): con distrattori identici, i fatti
  *espliciti* falliscono in **retrieval** (48.7% degli errori), gli *inferiti*
  falliscono in **comprensione** (60.9%). Falliscono in modi diversi → vanno
  trattati in modo diverso → serve che la distinzione sia **memorizzata**.
- **arXiv:2605.10013**: gli utenti reagiscono alle inferenze con curiosità, non
  disagio — il disagio arriva **quando l'inferenza è sbagliata o usata per
  scopi diversi**. Argomento di governance: un'inferenza dev'essere **visibile e
  correggibile in quanto inferenza**.
- **PersistBench** (arXiv:2602.01146, ICML 2026): mediana **53% leakage
  cross-dominio** e **97% sycophancy indotta dalla memoria**. I fatti inferiti
  sono i portatori naturali di entrambi.
- Tradizione RDF/KG: la distinzione asserito/inferito è vecchia e standard
  (PROV-O `wasDerivedFrom`, named graphs), ma serve a **spiegazione e
  manutenzione** — **nessun sistema KG filtra il retrieval su di essa**.

**Resta ortogonale a `trust_tier`.** Una citazione verbatim dal web è
`(tier 3, said)`; un'inferenza nostra sull'owner è `(tier 0, inferred)`.
Collassarli in un numero distrugge entrambi.

## 5. Cosa NON si è potuto stabilire

- **Nessuna ablation, da nessuna parte, isola importance come termine di
  ranking.** Se lo mettiamo in RRF, siamo i primi a testarlo: va scritto nell'ADR.
- **Come sia stato scelto k=60**: il PDF Cormack 2009 non è estraibile. L'unica
  affermazione quasi-primaria è Azure: *"performs best when you set k to a small
  value, such as 60"*. Graphiti usa 1.
- **Nessuna misura pubblicata della varianza inter-run dei rating di *importanza***
  in particolare: il trasferimento dalla letteratura LLM-judge è un'inferenza, non
  una misura.
- Schemi esatti di **Mem0** e **A-MEM**, e Letta/MemGPT (evidenza solo blog-level).

## Fonti

arXiv:[2304.03442](https://arxiv.org/abs/2304.03442) ·
[2305.10250](https://arxiv.org/abs/2305.10250) ·
[2603.07670](https://arxiv.org/html/2603.07670v1) ·
[2607.22562](https://arxiv.org/html/2607.22562) ·
[2606.12945](https://arxiv.org/html/2606.12945v2) ·
[2607.29433](https://arxiv.org/html/2607.29433) ·
[2605.10013](https://arxiv.org/abs/2605.10013) ·
[2602.01146](https://arxiv.org/abs/2602.01146) ·
[2601.03444](https://arxiv.org/abs/2601.03444) ·
[2605.16386](https://arxiv.org/abs/2605.16386) ·
[2509.20293](https://arxiv.org/html/2509.20293) ·
[2210.11934](https://arxiv.org/abs/2210.11934) ·
[Graphiti search_utils.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_utils.py) ·
[ES rank_feature](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-rank-feature-query) ·
Talarico & Rubin 2003, *Psychological Science*
