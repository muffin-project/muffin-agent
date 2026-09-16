# ADR-0082 — Lo stallo senza tool-call si recupera al filo, una volta sola

**Stato:** accettato · 2026-09-16 · evidenza: `muffin.db`/`traces` 15–16/09/2026 (turni `486eb3de`, `a0569c6a`), ricerca Gemma 4 / OpenRouter / peer 16/09/2026.

## Contesto

Il 16/09 il main è passato a `google/gemma-4-31b-it`. Dalle righe `turns`: 9
turni, tutti `answered`, ma quasi tutti a `iterations: 1, toolCallsMade: 0`,
`stop_reason: end`. Il caso `486eb3de` ("procedi", task che richiedeva
`fs_write`) mostra due `chat_call` da **0/0 token in ~30s** (`failure:
'empty'`, nudge) e una risposta finale che dichiara il file salvato senza aver
chiamato nulla. Il completion gate non scatta: scatta solo se la risposta
**nomina** un tool (`agent/completion.ts`), e Gemma narra senza nominare.

Il giorno prima, con `qwen/qwen3.8-27b`, lo stesso impianto mostrava il
sintomo opposto: `iterations` fino a 13, `recoveriesUsed` fino a 4, turni
`error` per `failure: 'empty'` — il modello lavorava ma inciampava spesso.

La ricerca esterna chiude il cerchio: è un modo di guasto noto del serving,
non un capriccio di un modello. Su Gemma 4 via vLLM, `tool_choice="required"`
non è enforced e torna `finish_reason: tool_calls` + `tool_calls: []` + prosa
(vLLM #53363); su Qwen 3 il parser ragionamento/contento ingoia le call
lasciandole nello stream di reasoning (vLLM #39056). OpenRouter normalizza
`finish_reason` ma il supporto a `tools` è **per-endpoint, non per-modello**,
con downgrade silenzioso a testo su alcune rotte Gemma. E il nostro adapter
(`openai-compat.ts`, `mapStopReason`) mappava `tool_calls` → `tool_use`
**anche con zero call parsate**: lo stallo diventava una risposta.

## Decisione

Nessun harness per famiglia (`if (model === ...)` nel loop resta vietato:
`agent/profiles/profile.ts`). Tre mosse, tutte dentro i confini esistenti:

1. **Assert di inconsistenza nell'adapter** (`openai-compat.ts`,
   `toChatResult`): `finish_reason: tool_calls` + zero call parsate lancia
   `ProviderError(source: 'output')`, che entra nella cascade del profilo —
   non è trasporto, quindi niente backoff.
2. **Nuovo rung `requireTool`**, ultimo della cascade `consumer-local`
   (dopo `strictJson`): il messaggio chiede una call o una riga di rifiuto;
   il loop arma `tool_choice: required` **per un solo tentativo**, poi torna
   ad `auto` (`TurnRun.requireToolOnce`, effimero — un resume che lo perde
   degrada a un tentativo `auto`, che è sicuro).
3. **`ChatCall.toolChoice` si allarga ad `'required'`**: openai-compat lo
   manda come `required`, Anthropic come `{type:'any'}`. Il default resta
   `auto` ovunque.

Questo rovescia parzialmente la nota di `recovery.ts` sullo `strictJson`,
che rifiutava il flag al filo perché il tipo non lo portava e gli adapter lo
avrebbero degradato in silenzio. Entrambe le premesse sono cadute (tipo
esteso, mapping esplicito, rung ultimo dopo correzioni gentili): il rovescio
è registrato qui, il testo vecchio resta a futura memoria.

## Alternative considerate

- **Harness per famiglia** (prompt/flag diversi per Gemma/Qwen/Claude nel
  loop): respinta — è il meccanismo che esiste, ha i test, e non è sul
  percorso di produzione per il modello dopo. La variabilità vive nei profili
  (dati) e negli adapter (dialetti del filo), mai in rami del loop.
- **Parser testuale di fallback** (cercare `<tool_call>`/`{"name":` in
  reasoning+content prima di dichiarare done): differito — utile, ma copre il
  caso in cui il serving ingoia la call; prima si chiude il caso misurato
  (stop inconsistente + vuoti), con i suoi test rossi.
- **`required` sempre al primo giro dei task tool-demanding**: respinto —
  fabbrica un'azione che il modello non ha scelto (la stessa disonestà che
  `completion.ts` rifiuta) e rompe le risposte brevi legittime, che su Gemma
  sono la maggioranza dei turni odierni.
- **Cambiare `sampling: deterministic` (temperature 0) per Gemma**: non in
  questa slice — #498 vieta di fissare default di reasoning/sampling senza
  misura A/B, e la temperatura canonica Gemma (1.0 / 0.3–0.5) va misurata
  contro task success e tool selection prima di toccarla.

## Cosa può smentire la scelta

- Un provider che 400 su `tool_choice: required` (endpoint XML-only
  pre-v0.21): il rung diventa un `error` con ragione tipizzata — va
  pin-nato il provider (`require_parameters`), non tolto il rung.
- `requireTool` che scatta su turni di sola conversazione: la cascade lo
  raggiunge solo dopo 4 fallimenti, ma se le tracce mostrano `required` su
  "buongiorno", il rung va condizionato (es. solo dopo `malformed`/stallo
  misurato), non allargato.
- Il fallback parser (sopra) che chiude più stalli di `required` a parità di
  turni: diventa il rung prima di questo.

## Complementi (non in questa slice)

#523 (probe di capability a runtime: `configured != working`), #498
(normalizzazione reasoning + misura Qwen), #497 (governor: distinguere
silenzio-pre-attività da stallo-post-attività — i vuoti 0-token/30s di oggi
sono il suo caso), #496 (retry ownership SDK vs loop).
