# Il design delle tool call: noi contro la prassi, 26/08/2026

Nasce da una domanda dell'owner — *«usiamo best practice come agentic pattern?
per esempio, che design usiamo per le tool call?»* — e da una regola sua: sugli
agenti ci si aggiorna a **oggi**, non a memoria. Quindi le fonti sono state
lette il 26/08/2026 e sono datate qui sotto; quando saranno vecchie, questo
documento va riletto prima di essere citato.

Il nostro lato è stato verificato nel codice a HEAD, non ricordato.

## Le fonti, con le date

- Anthropic, *Writing effective tools for AI agents* — 11/09/2025 (~12 mesi).
- Anthropic, *Introducing advanced tool use* — 24/11/2025. Tool Search Tool,
  Programmatic Tool Calling, Tool Use Examples: **beta pubblica**, header
  `advanced-tool-use-2025-11-20`. Soglia `defer_loading`: ~10K token di
  definizioni.
- Anthropic, *Code execution with MCP* — 04/11/2025 (la fonte stessa dice che
  «introduces its own complexity»: sandboxing e isolamento).
- MCP, spec 2025-06-18 (`structuredContent`/`outputSchema`) e 2026-07-28
  (estende `outputSchema`; **deprecia Sampling, Roots e Logging**, finestra 12
  mesi; sostituisce `elicitation/create` con Multi Round-Trip Requests).
- MCP blog, *Tool Annotations as Risk Vocabulary* — 16/03/2026.
- Simon Willison, *The lethal trifecta* — 16/06/2025 (>12 mesi).

Non verificati alla fonte primaria, quindi da trattare come indizi: il dato
Datadog 2026 sul 69% di token di input spesi in system prompt e definizioni; la
regola «oltre 15-20 tool serve retrieval vettoriale», che circola in fonti
secondarie ma non compare in Anthropic né in MCP.

## Dove siamo avanti alla prescrizione

**L'idempotenza non la dichiariamo, la teniamo.** MCP definisce
`readOnlyHint`/`destructiveHint`/`idempotentHint`, e il proprio blog del
16/03/2026 avverte che sono **segnali informativi, non garanzie enforceable**;
trattarli come contratto di sicurezza è un anti-pattern riconosciuto. Da noi
c'è una riga di intento prima dell'effetto e un campo `rerunnable` che decide
cosa si può ripetere dopo un crash, con i tre stati distinti «non fatto / fatto
/ forse fatto» (`agent/loop.ts`, `core/policy/types.ts`).

**I permessi stanno nell'host, non nei metadata del tool.** Ogni chiamata passa
dal kernel, che decide su una *risorsa* estratta dagli argomenti (path, url) e
non sul nome del tool. Il commento in `agent/loop.ts` racconta il guasto che
l'ha imposto: `url` non veniva estratto, il ramo egress non scattava mai, e una
allowlist vuota permetteva ogni host pubblico.

**La «lethal trifecta» è il nostro impianto.** Dati privati + contenuto non
fidato + comunicazione esterna: è taint→egress, e quando il taint sale l'uscita
si chiude. Il campo `tier` su ogni risultato è **obbligatorio** proprio perché
"non aver risposto" veniva letto come "pulito".

**Errori come dati, non come eccezioni.** `is_error: true` sul `tool_result` è
la prescrizione API, ed è quello che facciamo — anche per le chiamate rifiutate
dal tetto per turno, perché un buco nel batch è un errore di protocollo. Il tool
inesistente riceve la lista degli **esposti**, non l'inventario intero.

## I quattro scarti, in ordine di costo

1. **Il confine degli argomenti non esiste.** Lo `inputSchema` che dichiariamo
   al modello non valida niente: gli unici consumatori sono i due adapter che
   lo spediscono al provider (`agent/providers/anthropic.ts`,
   `openai-compat.ts`). La validazione vera è dentro ogni handler e non è
   uniforme: 7 tool su 14 usano zod, `wait` valida a mano bene, `fs_*` /
   `document_read` / `memory_search` fanno un cast — `String((args as
   {path:string}).path)` legge il file `"undefined"` invece di dire che manca
   un parametro obbligatorio. La prassi vuole errori che **nominino le
   alternative valide** («Available fields: …»). Peggio del buco: il commento
   su `agent/providers/types.ts` promette *«Validated before the kernel ever
   sees the arguments»*, e non è vero. Vale una slice: un confine unico che
   valida contro lo schema dichiarato, e il commento che smette di mentire.
2. **Nessuna manopola di verbosità, nessuna paginazione.** Anthropic ha
   misurato un `response_format` `detailed|concise`: 206 contro 72 token a
   parità di contenuto; Claude Code limita le risposte tool a 25.000 token per
   spingere verso ricerche piccole e mirate. Noi abbiamo tetti (30k shell, 50k
   http, 2MB fs, 200 righe process) ma sono proprietà **di ogni tool**, non del
   confine: un tool nuovo può restituire testo illimitato e nulla lo ferma.
3. **`structuredContent` di MCP lo buttiamo.** Esiste dal 18/06/2025, allargato
   il 28/07/2026. `core/mcp/connect.ts` legge solo le parti `text` di
   `result.content` e trasforma il resto in segnaposto `[image content]`.
4. **Descrizioni a due velocità.** La prassi dice che affinarle è tra le leve
   più efficaci *misurate* — «come le spiegheresti a un neoassunto».
   `shell_run` è così (confinamento, `cwd` che non persiste, come tronca, cosa
   fare se la sandbox blocca); `fs_read` è una riga senza limiti né errori.

## Cosa NON adottare, e perché

Tool Search, Programmatic Tool Calling e le deferred tool definitions servono
quando le definizioni superano i ~10K token (Claude Code marca `defer_loading`
oltre quella soglia). Con 14 tool e un tetto di 10/24 esposti per profilo non
abbiamo quel problema: adottarli ora è over-engineering, ed è beta.

## Cosa è stato controllato e non ci riguarda

La deprecazione MCP del 28/07/2026 (Sampling, Roots, Logging) e la sostituzione
di `elicitation/create`: non implementiamo nessuna delle quattro cose. La
paginazione con cursor su `listTools` c'è già (`core/mcp/connect.ts`).
