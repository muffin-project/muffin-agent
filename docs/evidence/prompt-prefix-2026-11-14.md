# Prefisso del prompt — 14 novembre 2026

Decisione che questa nota è stata scritta per cambiare: ADR-0107. Non è
architettura corrente per il solo fatto di essere più nuova. La misura è sui
default spediti di questo checkout, stimatore `ceil(caratteri / 4)`, lo stesso
di `muffin prompt show`. Non è un tokenizer di modello.

## Misura

Home sintetica con i file di `defaults/`, prima del taglio:

| blocco | caratteri | token stimati |
|---|---:|---:|
| persona | 4927 | 1232 |
| identity | 4895 | 1224 |
| voice | 10466 | 2617 |
| skills | 742 | 186 |
| work-rules | 2324 | 581 |
| **prefisso owner** | **23362** | **5841** |
| prefisso gruppo | 14386 | 3597 |

L'audit di un saluto reale (~8,7–9k, carattere ~5,5k di cui voice ~2,9k, 61%
del primo passaggio, una sola cache breakpoint, hit 0) non è riprodotto qui
token per token: il tokenizer e i tool della richiesta non sono questo
stimatore. Voice 2617 contro ~2,9k e il totale dei tre file 5073 contro ~5,5k
sono lo stesso difetto. Il prefisso spedito è già sopra 4000 prima dei tool.

Dopo il taglio, stessa stima, home di `muffin init` (il test
`agent/context/prefix-budget.test.ts` stampa il dettaglio):

| blocco | caratteri | token stimati | tetto |
|---|---:|---:|---:|
| identity | 3365 | 842 | 1000 |
| skills | 895 | 224 | 400 |
| work-rules | 2324 | 581 | 1200 |
| **prefisso owner** | | **~1647** | **4000** |

Dopo le regole prese dalla storia (14/11, stesso stimatore, home di init):
identity 3365 caratteri / ~842 token (tetto 1000), skills ~224, work-rules ~581,
prefisso owner ~1647 (tetto 4000). Gruppo ~1391. Minimal ~849.

## Peer

- Hermes: un `SOUL.md`, tetto caratteri con avviso, scan anti-injection sui
  file di contesto, quattro breakpoint (prompt fisso + ultimi tre messaggi).
  Lo scan non è in questa slice: non c'è una misura muffin che lo chieda.
- OpenClaw: budget per file e totale, modo `minimal`/`none` per subagent e
  harness.
- Anthropic / OpenRouter: al massimo quattro `cache_control` per richiesta.

## Tabella

```text
measured Muffin failure / desired capability
  Prefisso di un saluto dominato da tre copie dello stesso carattere;
  un solo breakpoint; cache hit 0. Registro e etichetta di gruppo sono
  comportamento, non esempi.

current mechanism and invariant
  buildSystemPromptBlocks concatena persona, identity sigillata, voice,
  catalogo, WORK_RULES. Il gruppo riceve GROUP_PERSONA + voice intera,
  mai identity. Il loop marca solo il system. I job usano runTurn e quindi
  il prefisso owner. Estrazione/giudice/rerank hanno già un prompt di compito.

candidate A: smallest local fix
  Accorciare i tre file e aggiungere tetti. I tre registri restano e
  ricrescono. Scartato.

candidate B: peer-inspired alternative
  Un identity sigillato di invarianti, esempi in una skill e nei probe,
  etichetta di gruppo in GROUP_PERSONA, tetti, modo minimal, quattro
  breakpoint. Scelto.

candidate C: remove/simplify
  Una riga «sei Muffin» e basta. Falsificato: il registro (lavoro / scherzo /
  momento emotivo) e i pavimenti della stanza sono prodotto, e i probe li
  misurano.

evidence for each
  Misura sopra. Peer: Hermes SOUL + 4 breakpoint; OpenClaw minimal.
  Il commento in assemble.ts: una frase solo in voice.md è l'unica copia
  del gruppo. Quei pavimenti sono stati spostati in GROUP_PERSONA, non
  nella skill.

counter-evidence / known failure modes
  L'orologio («Questo turno») sta prima del messaggio corrente e cambia
  a ogni turno. Un marcatore lì, o dopo, non viene mai riletto: i
  marcatori stanno sul sistema e sulla storia stabile prima dell'orologio.
  Una home esistente tiene identity.md lungo finché non risigilla.

security/privacy/durability consequences
  Il patto non va al gruppo. L'etichetta di gruppo non è un file che
  l'owner spegne. Il modo minimal non porta il patto ai job. Nessuna
  migrazione del testo privato dell'owner.

eval or observation that would falsify the chosen option
  Prefisso owner > 4000 o identity > 1000 sullo stimatore del repo.
  Probe register-switch-to-banter, register-switch-to-work,
  register-emotional-attunement rossi a parità di regola nel patto.
  Una riga di GROUP_PERSONA elencata in ADR-0107 assente dal prompt di gruppo.
  Cinque cache_control, o un 400 da un endpoint che non li capisce.

chosen claim and why
  B. È il taglio che toglie le tre copie senza togliere il registro né
  l'etichetta di stanza. A non chiude il difetto. C chiude il prodotto.
```
