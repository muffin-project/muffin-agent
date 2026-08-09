# ADR-0024 — Chunking strutturale con contesto, non semantico

**Data:** 2026-08-05
**Stato:** accettata
**Contesto di ricerca:** tre scout paralleli (semantic-vs-strutturale, late-chunking/contextual-retrieval, sistemi second-brain reali). Richiesta originale dell'owner: *"per favore facciamo chunk semantico"*. Questa ADR la contraddice, con l'evidenza sotto.

---

## Contesto

Il vault (02 §7) ha bisogno di spezzare i documenti prima di indicizzarli. La prima implementazione era un accumulatore di paragrafi scritto a naso — nessuna ricerca, in violazione della regola del progetto che vuole SOTA prima di ogni scelta architettonica. L'owner l'ha fermata chiedendo chunking **semantico** (split guidato dalla similarità di embedding fra frasi adiacenti).

La ricerca dice che il semantico è la scelta sbagliata, e indica una scelta diversa da entrambe le opzioni sul tavolo.

## Evidenza

**Il semantic chunking non batte gli approcci semplici su documenti coerenti.** Sei studi controllati indipendenti convergono:

| Fonte | Cosa misura | Risultato |
|---|---|---|
| arXiv:2410.13070 (NAACL 2025 Findings) | F1@5, 10 dataset retrieval + 5 RAGBench | Vince **solo** su dataset "stitched" (sintetici, testi non correlati concatenati): Miracl +12.4pp, NQ +20.1pp. Sui dataset **naturali** perde su 4/4: HotpotQA −3.2, MSMARCO −1.4, ConditionalQA −3.7, Qasper −1.7 |
| Chroma Research | recall/precision/IoU token-level, 472 query, 5 domini | Il `KamradtSemanticChunker` (il semantic chunker canonico dei tutorial) sta **sotto la media** su tutte le metriche |
| arXiv:2603.06976 | 36 strategie × 6 domini × 5 embedder, nDCG@5 | Vince **Paragraph Group Chunking** (strutturale): nDCG@5 0.459 vs <0.244 del fixed-char. **Nessun** metodo semantic-breakpoint tra i vincitori per dominio |
| arXiv:2601.14123 (ECIR 2026) | NQ, SPLADE + Mistral-8B | *"sentence chunking is the most cost-effective method, matching semantic chunking up to ~5k tokens"*; *"context cliff"* oltre ~2.5k token |
| Snowflake (23k filing SEC, 3,2M chunk, 500 query gold) | Accuratezza su corpus reale | Chunking per header markdown: **+5-10pp**. Chunk da 14.400 char vs 1.800: **−10/20pp**. La leva più forte in assoluto: **iniettare metadato di documento nel chunk** |
| arXiv:2607.01852 | 13 tesi accademiche lunghe | Cluster-based semantic chunking: *"did not yield any consistent improvement"* |

Il pattern che emerge non è "il semantico è inutile", è più preciso: **quando qualcosa batte il fixed-size, è strutturale (paragrafi/heading) o adattivo sulla densità, quasi mai embedding-breakpoint.** La distinzione si perde nei riassunti che dicono genericamente "il semantico vince".

Il nostro corpus è il caso peggiore per il semantico: una nota è un documento *coerente*, l'opposto del regime "stitched" dove il semantico vince.

**Il contesto perso conta almeno quanto il punto di taglio.** Snowflake trova che il metadato di documento è la leva più forte, e che il vantaggio del chunking per header **si riduce** una volta aggiunto — sono in parte sostituti, non additivi. Anthropic (contextual retrieval) misura −35% di failure rate top-20 solo anteponendo contesto al chunk prima di embeddare.

**Cosa fanno i sistemi reali** (letto dal codice, non dai README): Reor spezza per heading e ricade su `RecursiveCharacterTextSplitter` solo per le sezioni oversize; Obsidian Smart Connections tratta ogni sezione-heading come blocco, con hash MurmurHash per blocco; Onyx impacchetta sezioni fino al limite token con `CHUNK_OVERLAP = 0` hardcoded. Nessuno usa embedding-breakpoint.

## Decisione

**Chunking strutturale, heading-first, con prefisso di contesto deterministico.**

1. **Split per heading markdown** (`#`…`######`), che diventano l'unità naturale. Una sezione più lunga del massimo ricade su split per paragrafo, e un paragrafo ancora più lungo su confine di parola. Tre livelli, dal più semantico al più brutale, mai il contrario.
2. **Ogni chunk porta il suo contesto**, anteposto al testo prima di embeddare e indicizzare: il percorso del file e il breadcrumb degli heading sotto cui sta (`note/lavoro.md › Progetti › Simpleclaim`). Deterministico, **zero chiamate LLM**. È la metà economica della contextual retrieval, e ha un secondo effetto: il reranker legge il testo del candidato, quindi il contesto migliora anche il riordinamento, non solo il vettore.
3. **Niente overlap.** L'evidenza è divisa (ECIR 2026: *"no measurable benefit and increases indexing cost"*; arXiv:2603.06976: miglioramento "modesto"), nessuno dei due trova danno nell'assenza. Con confini strutturali il taglio cade dove il documento stesso lo mette, che è il caso in cui l'overlap serve meno.
4. **Dimensione**: target ~1200 caratteri, massimo 2000. Ben sotto il "context cliff" di ~2.5k token, e sopra la soglia dove i chunk diventano troppo poveri per il reranker.

## Alternative scartate

**Semantic chunking (embedding-breakpoint).** Scartato sull'evidenza sopra: non vince su corpus coerenti, e costerebbe un embedding per frase a ogni scansione. È la richiesta esplicita dell'owner, contraddetta con motivo — se l'owner la conferma comunque, va fatta come esperimento misurato contro questa baseline, non come default.

**Late chunking (Jina).** Scartato per **kill criterion verificato**: richiede i token embedding pre-pooling, e Ollama espone solo il vettore finale su entrambi gli endpoint (`/api/embeddings` e `/v1/embeddings`). L'issue [ollama#5907](https://github.com/ollama/ollama/issues/5907) è aperta dal 24 luglio 2024 senza movimento. Servirebbe un path di inferenza Python separato — un componente nuovo, non un flag. E i guadagni misurati sono modesti e incoerenti fra modelli (verifica indipendente arXiv:2504.19754, Univ. Bologna: *"Late Chunking does not consistently outperform the Early approach"*).

**Contextual retrieval piena (contesto generato da LLM per chunk).** Rimandata, non scartata: risolve anche i riferimenti impliciti dentro il chunk, cosa che il prefisso deterministico non fa. Costo stimato $1-30 una tantum per 1000 documenti sulla lane light. Gate prima di adottarla: un delta misurato su query reali contro la baseline di questa ADR, e applicazione solo sopra una soglia di lunghezza del documento (su una nota breve il beneficio è marginale per costruzione).

**RAPTOR.** Risolve un problema diverso — sintesi multi-hop attraverso più chunk, non l'autosufficienza del singolo chunk — e condivide il profilo di costo della famiglia GraphRAG già scartata.

## Conseguenze

**Più facile**: il chunking non richiede il modello di embedding per decidere dove tagliare, quindi la scansione del vault funziona anche senza embedder configurato (recall degrada a solo-testo, come già dichiarato). Un chunk è leggibile da solo, il che serve al reranker e serve all'owner quando `muffin memory why` glielo mostra.

**Più difficile**: su prosa senza heading il vantaggio strutturale sparisce e si ricade su paragrafi — accettabile, è il baseline che l'evidenza dice essere già competitivo. Code block e liste possono ancora essere tagliati a metà: è un buco del campo intero, nessuno degli otto sistemi esaminati lo risolve.

**Da misurare** (non ora, quando esiste il golden set di 05 §3.1): se il prefisso di contesto sposta davvero il recall su query reali, e di quanto. Il numero di Snowflake è su filing SEC, non su note personali.

## Nota di processo

Questa ADR esiste perché la prima implementazione è stata scritta senza ricerca e l'owner l'ha fermata. La regola violata era già scritta (`feedback_research_before_every_choice`). Il costo del non averla seguita è stato un chunker da buttare; il costo di seguirla è stato tre scout in parallelo e un'ora. Vale la pena ricordarselo la prossima volta che sembra che una decisione sia "solo implementativa": il chunking decide cosa il recall **può** trovare, e non c'è niente di implementativo in questo.
