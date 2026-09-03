# La corsia end-to-end reale

Accanto all'accettazione finta (`evals/acceptance/`, provider finto e Bot API
finto, deterministica, in CI) esiste questa corsia: **modello vero, Bot API
vera, un umano al telefono**. Nasce il 03/09/2026 da una richiesta esplicita
dell'owner — «vorrei test end to end VERI, non finti» — dopo che B11 e B13,
verdi sul finto, si sono rivelati rotti a occhio
(`docs/evidence/dogfood-superfici-2026-09-03.md` §5.4).

Non gira in CI e non può: costa denaro, ha bisogno di un telefono e di un bot
di prova. Gira **in locale**, quando una riga user-facing dell'inventario
DAY-1 chiede la prova reale, e il suo verde si scrive nella riga con la data.

## Cosa serve

Tutto dall'ambiente, mai da argv, mai stampato:

| variabile | cosa |
|---|---|
| `LLM_API_KEY` (o `OPENROUTER_API_KEY`) | la chiave del modello |
| `MUFFIN_E2E_TELEGRAM_TOKEN` | il token di un bot **di prova** (BotFather) — non quello installato, che sta già facendo `getUpdates` e risponderebbe 409 |
| `MUFFIN_E2E_OWNER_ID` | la tua user id Telegram |

```bash
npx tsx evals/e2e/telegram.ts
npx tsx evals/e2e/telegram.ts --model qwen/qwen3.6-27b --keep
```

## Come misura

Un proxy locale sta fra il gateway (`surface enable telegram --api-base`) e
`api.telegram.org`, e registra ogni chiamata e ogni update in `wire.jsonl`,
con il token redatto. Le asserzioni sono sul filo: quante scritture, in che
ordine, con che testo, e cosa **non** c'è (un `deleteMessage`, un messaggio
oltre 4096). Lo script dice cosa mandare al bot, aspetta il filo, e stampa
✓/✗ con il dettaglio. Tre passi:

1. **trascrizione** (B11/B13/D12): i passi restano in un messaggio vero,
   niente cancellato, niente oltre il limite, l'ASK con il comando intero e la
   frase del modello, la risposta come messaggio a parte dopo l'ultima edit;
2. **coda** (B2): un secondo messaggio a turno vivo è confermato «in coda»
   prima della prima risposta, e risposto dopo;
3. **`/stop`** (B2): «fermato» e poi «Interrotto.».

Il ritmo lo dai tu; il verdetto lo dà il filo. `--keep` tiene lo scratch
(home, workspace, `wire.jsonl`) anche a verde.
