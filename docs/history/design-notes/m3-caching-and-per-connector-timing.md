# Caching e la divergenza per-connector: perché il timing lo decide la cache (2026-08-09)

> Nota di design, non scout: mecca­nica del prompt caching presa da fonte autoritativa (skill `claude-api`, non a memoria) e applicata alla domanda owner "system prompt prima o dopo il gateway?". Alimenta l'affinamento di ADR-0016. Input alla sintesi quando i due scout per-connector atterrano.

## La meccanica (autoritativa)

Il prompt caching è un **prefix match**: qualunque byte cambi nel prefisso invalida tutto ciò che segue. Ordine di render: **`tools` → `system` → `messages`**. Gerarchia di invalidazione:

| Cosa cambia | Invalida tools | Invalida system | Invalida messages |
|---|---|---|---|
| Definizioni dei **tool** (add/remove/reorder) | ❌ | ❌ | ❌ |
| **Modello** | ❌ | ❌ | ❌ |
| Contenuto del **system prompt** | ✅ | ❌ | ❌ |
| Contenuto dei **messaggi** | ✅ | ✅ | ❌ |

(✅ = sopravvive, ❌ = distrutto.) TTL 5 min (write 1.25×) o 1h (write 2×); minimo cacheabile model-dependent (512 sui modelli nuovi, 1024 Sonnet, di più altrove) — sotto il minimo non cachea in silenzio. Verifica: `usage.cache_read_input_tokens` a zero su richieste ripetute = un invalidatore silenzioso nel prefisso.

## La tensione che l'owner ha fiutato, risolta in una direzione

Se la divergenza per-connector (Telegram vs Discord: bottoni, card, dashboard, limiti file diversi) finisce **a monte** — cioè nel prefisso cacheabile — succede questo:

- **Set di tool diverso per connector** → i tool stanno a posizione 0 → la cache si **frammenta per-connector**, e su un processo unico (ADR-0022) che serve entrambi, ogni switch Telegram↔Discord **invalida tutto ad ogni turno**. È il costo peggiore.
- **System prompt diverso per connector** → la cache di system si frammenta per-connector (i tool sopravvivono, ma perdi identità+istruzioni condivise).

Quindi la meccanica **decide il timing** della domanda owner: la divergenza per-connector NON va nel prefisso. La forma corretta:

1. **Prefisso condiviso e connector-agnostico** — identità (dal RoT) + set di tool **uniforme** + istruzioni core, marcato `cache: 'stable'`. Una sola cache calda per tutti i connector.
2. **Specializzazione in coda** — le capability del connector (formattazione, bottoni, limiti file, "questa surface renderizza card") entrano **dopo** l'ultimo breakpoint: come blocco di contesto per-turno nei `messages`, non come system prompt diverso né come tool diverso.

In una riga: **si genera con un core cacheabile condiviso, si specializza in coda.** Questo risponde in anticipo alla domanda "prima o dopo il gateway": *dopo*, come suffisso post-cache — non un system prompt modellato dal gateway a monte.

## Conseguenza per "capability per-connector = tool o rendering?"

- Le capability del connector alimentano il **renderer** (post-generazione, ADR-0016/0023): il modello produce un intent ricco (`card`, `image`, `text`), il connector sceglie il mezzo. Il renderer è già post-cache per costruzione.
- Farne **tool condizionali** ("tool bottoni solo se Telegram") frammenterebbe il prefisso — da evitare. Se un domani servono tool surface-specifici, l'unica via cache-safe è l'escape hatch `tool_addition`/`tool_removal` (append dopo il prefisso) — ma è **Anthropic Opus-5-only + beta**, non disponibile sulla nostra lane Gemma/OpenRouter: quindi in v1 **set di tool uniforme**, e la capability del connector la porta il renderer + un blocco di contesto in coda.

## Caveat sullo stack reale

La meccanica `cache_control` esplicita è **Anthropic-specifica** (la nostra lane `callDream`/Claude): l'adapter `agent/providers/anthropic.ts` già mappa `cache: 'stable'` → `cache_control: {type:'ephemeral'}` e legge `cache_read_input_tokens`/`cache_creation_input_tokens`. La lane **MAIN è Gemma via OpenRouter**, dove il caching è **implicito/automatico** e keya comunque sul prefisso — quindi **la regola di design è identica**: prefisso stabile riusato, volatile in coda, indipendentemente dal provider. Il seam esiste già: `ChatCall.system: ContentBlock[]` col flag posizionale `cache: 'stable'`.

## Regola per l'affinamento di ADR-0016

> Il connector dichiara le proprie capability (text|image|file|card|button|limiti). Questa dichiarazione alimenta **il renderer e un blocco di contesto per-turno in coda**, mai il prefisso cacheabile (identità + tool uniformi + istruzioni core). Un turno da Telegram e uno da Discord condividono la stessa cache calda; a divergere è solo il suffisso. Set di tool uniforme in v1 (i tool surface-specifici via escape-hatch sono post-v1 e model-gated).
