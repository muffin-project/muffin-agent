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

Su un'installazione viva, **quasi niente**: la chiave del modello e la tua user
id Telegram Muffin le ha già, e chiederle di nuovo sarebbe la stessa porta
aperta due volte. Le legge da `provider.apiKeyRef` e da
`surfaces.telegram.ownerUserId`. Niente `.env`.

Resta una cosa sola, e solo se il gateway installato è vivo: **il bot**. Due
processi che fanno `getUpdates` sullo stesso token non convivono, Telegram
risponde 409 a uno dei due, e il filo registrerebbe un fallimento che sembra un
difetto del prodotto. Due strade, entrambe legittime:

```bash
muffin gateway stop            # riusa il bot di prova installato; a fine corsa: muffin gateway start
muffin secret set e2e_telegram_token   # oppure un bot dedicato (BotFather), e il gateway resta su
```

Lo script si ferma **prima** di partire se il conflitto c'è, e dice quale dei
due comandi risolve. L'ambiente resta e vince su tutto, perché una corsa deve
poter puntare a un account diverso da quello installato senza toccare la
config:

| variabile | ha la meglio su |
|---|---|
| `LLM_API_KEY` (o `OPENROUTER_API_KEY`) | `provider.apiKeyRef` |
| `MUFFIN_E2E_TELEGRAM_TOKEN` | `secret://e2e_telegram_token`, poi `secret://telegram_token` |
| `MUFFIN_E2E_OWNER_ID` | `surfaces.telegram.ownerUserId` |

La scelta è una funzione pura in `credenziali.ts`, con il suo test: là dentro
sarebbe stata leggibile e mai falsificabile, ed è esattamente dove aveva già
sbagliato.

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
