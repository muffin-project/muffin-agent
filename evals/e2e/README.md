# Corsia E2E reale

## Runner CLI isolato (G0)

`npm run e2e:real:preflight` compila e avvia la CLI compilata in una nuova Home
temporanea, isola `HOME`, `MUFFIN_HOME`, `MUFFIN_WORKSPACE`, le directory XDG e
`TMPDIR`, inizializza DB/Root of Trust e verifica il sandbox con la stessa env
isolata. Avvia il gateway compilato in foreground, verifica il PID sul socket
di controllo e lo ferma a fine prova. I turni partono dalla CLI sullo stesso
gateway. Il preflight non richiede una chiave e non chiama il modello: interroga il
catalogo pubblico OpenRouter senza autenticazione e verifica identità, supporto
tool, contesto e prezzi zero. Produce `report.json` con SHA del commit, lockfile
e stato delle sorgenti runtime; exit 0 indica PASS, 1 FAIL, 2 BLOCKED. Ogni
invocazione crea un root distinto e conserva le prove. Per rimuoverlo usa
`node evals/e2e/real-agent.mjs --clean <root-esatto>`.

Il percorso predefinito usa OpenRouter Free. Il modello predefinito è
`google/gemma-4-31b-it:free`; `--model` accetta solo un ID `:free` presente nel
catalogo corrente (oppure `openrouter/free` se il catalogo descrive quella route
con tool e prezzi zero). Un run reale richiede una chiave esplicita in un file
privato `0600`, regolare, senza symlink e fuori dal repository:

```bash
npm run e2e:real -- --api-key-file ~/.local/state/muffin/e2e/openrouter-key
npm run e2e:real -- --model google/gemma-4-31b-it:free --api-key-file ~/.local/state/muffin/e2e/openrouter-key
```

Convenzione locale (non nel repository, mai in `/tmp` che non sopravvive al
reboot e accumula detriti dei test): il file vive in
`~/.local/state/muffin/e2e/openrouter-key`, `0600`. Le Home temporanee dei run
restano invece usa-e-getta sotto `/tmp` per i limiti sui socket Unix.

Non vengono lette chiavi dall’ambiente o dall’installazione personale. La chiave
entra nella Home temporanea tramite stdin della CLI, passa al proxy solo
nell’header Authorization e viene esclusa dai report e dai log. Il proxy usa
solo `https://openrouter.ai/api/v1`, inoltra body e streaming senza modificarli,
e rifiuta model ID diversi, modelli pagati o routing/fallback espliciti prima di
inoltrare la richiesta. Registra schemi, byte, hash, model servito, first-byte/end
latency, usage, costo/cache/ragionamento quando forniti (altrimenti `unknown`).
Il budget condiviso è 10 richieste, 180 s, 4.096 token output per richiesta secondo la CLI,
40.960 totali e 400 kB / 100.000 token di input come limite separato. Ollama è riservato agli
embedding, non al provider LLM di questa prova. Due risposte upstream 429
consecutive o un 401/402/403 fermano la sola CLI del run e classificano la prova
come BLOCKED; un 404 mantiene il retry canonico e due 404 consecutivi bloccano la
corsa. Il body di errore OpenRouter è registrato con metadati redatti. Quando
un limite locale o una validazione del runner rifiuta una richiesta, il runner
ferma subito la propria CLI: se almeno una completion è arrivata al provider,
la prova è FAIL con il motivo `runner_budget` o `runner_validation` e conserva i
controlli positivi parziali; altrimenti è NOT_RUN. Il conteggio non inoltra mai
l’undicesima richiesta. Questi limiti locali non sono classificati come rate limit
del provider, e una risposta upstream che segnala indisponibilità resta BLOCKED.
La scena negativa parte solo con almeno 3 richieste e 30 s residui; una scena
positiva da 7 chiamate lascia quindi spazio alla prova di authority.

La scena positiva usa due note sintetiche e richiede il documento della decisione
condivisa. PASS richiede `fs_write` assente dal primo schema, `capability_search`
selezionato dal modello, schema `fs_write` arrivato dopo la discovery, effetto
autorizzato nella DB e verifica indipendente del file. La scena negativa PASS
richiede una chiamata `fs_write` selezionata dal modello sul sentinel esterno,
uno span correlato e la decisione `fs.write`: DENY con codice, oppure DRAFT
con rifiuto tipizzato `outside_scope` durante la risoluzione del percorso.
Richiede inoltre zero intenti DB per quella chiamata e hash del sentinel
immutato. Un errore generico di snapshot, il rifiuto narrato dal modello o
l'assenza di modifiche da soli non certificano il rifiuto del perimetro.
CLI senza approvazione umana termina BLOCKED: il runner non approva ASK.

È disponibile anche `--run --chatgpt-root <root-sintetico>`: riusa in posizione
una Home di prova già autorizzata, privata e marcata, senza copiare credenziali.
Il root deve essere canonico sotto `/private/tmp`, avere il marker sintetico
con scope `chatgpt.tokens.use.direct` e non avere socket gateway. Provider e
modelli main/light devono essere fissati alla route ChatGPT e `gpt-6.1-sol`;
`--model` diverso viene rifiutato. La Home inizializzata con `muffin init` deve
avere solo la CLI attiva e nessun MCP, job o turno pendente. Usa l'embedder locale
predefinito e lascia assenti le configurazioni di search e judgment. Il runner
crea workspace e sessioni unici,
aggiunge un solo profilo temporaneo per esercitare discovery e lo rimuove,
verificando gli hash originali di config e profili. Usa gli stessi oracoli e
osserva gli schemi e le chiamate reali Responses, senza registrare prompt,
header di autorizzazione o token. Il budget condiviso è 10 richieste / 180 s,
inclusa una risposta già in corso. Un 429 blocca ulteriori richieste ChatGPT
della prova. Nessun fallback a provider API. La route
ChatGPT non supporta `max_output_tokens`: il report dichiara il limite remoto
di output NOT_ENFORCED e mantiene il limite locale di tempo.

## Runner Telegram con bot di prova

Accanto all'accettazione finta (`evals/acceptance/`, provider finto e Bot API
finto, deterministica, in CI) esiste questa corsia: **modello vero, Bot API
vera, un umano al telefono**. Nasce il 03/09/2026 da una richiesta esplicita
dell'owner — «vorrei test end to end VERI, non finti» — dopo che B11 e B13,
verdi sul finto, si sono rivelati rotti a occhio
(`docs/evidence/dogfood-superfici-2026-09-03.md` §5.4).

Non gira in CI e non può: costa denaro, ha bisogno di un telefono e di un bot
di prova. Gira **in locale**, quando una riga user-facing dell'inventario
DAY-1 chiede la prova reale, e il suo verde si scrive nella riga con la data.

### Cosa serve

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
npx tsx evals/e2e/telegram.ts --group --keep
```

Il gateway di prova gira in foreground con Home e workspace nuovi; `--home`
accetta un percorso di scratch che non esiste ancora. Non avviare due runner con
lo stesso token. Per `--group`, aggiungi il bot a un gruppo di prova in cui
riceve il messaggio con la sua menzione. Per la scena Stop nativo usa un client
Telegram che mostra il pulsante sulla bozza.

### Come misura

Un proxy locale sta fra il gateway (`surface enable telegram --api-base`) e
`api.telegram.org`, e registra ogni chiamata e ogni update in `wire.jsonl`,
con il token redatto. Lo script dice cosa mandare al bot e verifica le consegne
riuscite, sia rich sia nel formato testuale, con il limite legacy applicato al
testo. Sul telefono, osserva l'anteprima e il passaggio alla risposta finale.

1. **Risultato in DM (B11/B13).** Il bot legge due file sintetici e risponde
   con il totale in un solo messaggio definitivo. Prima mostra una bozza
   effimera utile (stato o risposta in arrivo), con lo stesso `draft_id` e Stop
   nativo, senza buchi oltre la durata della bozza se il turno si prolunga.
   Né bozza né risposta mostrano i passi ordinari o un blocco «Processo».
   Questa scena verifica una risposta testuale; non richiede un allegato.
2. **Approvazione manuale (D12).** La domanda mostra integralmente il prompt
   di approvazione, la descrizione e il comando di scrittura nello scratch, con
   «Consenti» e «Rifiuta». Il runner legge il registro durevole in sola
   lettura: prima verifica che il turno sia sospeso e il file non esista, poi
   chiede all'owner di controllare e premere «Consenti», senza reinviare la
   richiesta. Verifica la conferma del click, il consumo della decisione,
   la scrittura del file e il risultato sulla stessa bolla senza tastiera.
   Il risultato può contenere una ricevuta «Approvazioni», senza lo storico
   degli strumenti. Il giro verifica la ripresa dalla barriera registrata,
   senza riavviare il gateway.
3. **Coda (B2).** Quando appare la bozza del primo turno, invia un secondo
   messaggio: «in coda» risponde al secondo prima che arrivino le due risposte,
   ciascuna al messaggio giusto, nell'ordine.
4. **Stop (B2).** Su due turni distinti, premi Stop sulla bozza e poi prova
   `/stop`. Il primo produce `stopped_message_generation` per quella bozza e
   «Interrotto.»; il secondo risponde anche «fermato» al comando.
5. **Gruppo o topic (`--group`).** Su una richiesta indirizzata al bot,
   `sendChatAction(typing)` nello stesso gruppo o topic precede l'unica risposta.
   Nessuna bozza e nessuna bolla dei passi.

`--keep` tiene lo scratch (Home, workspace, `wire.jsonl`) anche a verde.
