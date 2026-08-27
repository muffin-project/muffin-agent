# Installer, init, update e i comandi fondamentali — cosa fanno i peer, cosa facciamo noi

**Data:** 2026-08-27 · **Richiesta owner:** «perché `muffin init` funziona così?
ma poi che naming di chiave stiamo usando, mica fa capire — anche qua serve un
po' di peer review, per installer, init, update, e vari comandi utili e
necessari/fondamentali»

---

## 0. Qualità delle prove

Come in `gateway-e-client-2026-08-27.md`: si conclude da **listing di directory**
(`gh api …/contents`, positivi) e da citazioni datate, mai dalla ricerca codice
di GitHub, che su questi repo è inaffidabile.

**Limite di questa passata, dichiarato:** l'API dei contents ha cominciato a
rispondere `429` a metà lavoro. Il listing di `crates/goose-cli/src/commands` è
completo; quello di `hermes_cli/` è **parziale** — arriva in ordine alfabetico
fino a `auth.py` e lì si ferma, quindi tutto ciò che dico su Hermes qui vale per
i moduli che iniziano per `_`, `a`, e per la struttura di primo livello già
verificata nel documento sul gateway. Non ho visto Codex e Letta da questo
angolo. **Va ripreso**, e questa riga è il segnaposto.

## 1. I comandi, affiancati

`crates/goose-cli/src/commands/` (listing completo, 2026-08-27):

```
configure  doctor  gateway  info  plugin  recipe  review  roam  schedule
session  skills  term  update
```

Il nostro `muffin` (da `cli/main.ts`):

```
init  config  doctor  backup  undo  restore  update  surface  gateway
memory  jobs  secret  vault  trace  prompt  mcp  model  search  run  repl
```

Le sovrapposizioni sono più di quanto ci si aspetti da progetti con scopi
diversi: `doctor`, `gateway`, `update`, `schedule`/`jobs`, `skills`,
`session`/`repl`. È un vocabolario che si sta stabilizzando da solo, e su cui
non stiamo divergendo.

### La differenza che conta: `configure` contro `config`

Goose ha **`goose configure`**: interattivo, ti porta dentro provider, modello ed
estensioni. Noi abbiamo `muffin config`, che è **read-only per decisione
esplicita** (ADR-0036, e il docstring di `cli/config.ts` lo dice: *«read-only, on
purpose … senza costruire una write surface che qualcosa deve guardare»*).

La decisione era giusta quando è stata presa e resta difendibile: una superficie
di scrittura generica su ogni manopola è una superficie da sorvegliare, e i
tetti stanno nel sigillo proprio per non doverla sorvegliare. Ma la conseguenza
si è accumulata: **cambiare qualcosa significava editare un JSON a mano**, e
quello è il difetto che l'owner ha incontrato tre volte in una sera (il modello,
la ricerca, il fallback dell'embedder).

Oggi la copertura per verbo è disomogenea, ed è disomogenea per accumulo e non
per decisione:

| manopola | comando |
|---|---|
| modelli main/light/embed | `muffin model` (27/08) |
| ricerca web | `muffin search` (27/08) |
| surface | `muffin surface enable` |
| ragionamento | `/think`, `config.json` §thinking (27/08) |
| **fallback embedder** | **solo a mano** |
| **provider / baseUrl** | **solo a mano, o `init --force`** |
| **traces.retentionDays** | **solo a mano** |

La domanda da decidere — e non è «facciamo `muffin configure`» — è: *quali
manopole meritano un verbo, e quali restano un file che si edita?* ADR-0036 dà
già il criterio (ciò che è nel sigillo si tocca dal terminale, il resto Muffin
può scriverlo); manca l'applicazione riga per riga.

### `info`, che noi non abbiamo e in parte non ci serve

`goose info` risponde a «cosa sono, dove stanno i miei file». Da noi la risposta
è spalmata fra `doctor` (stato) e `config` (manopole e provenienza). Non è un
buco: è la stessa informazione, divisa per **domanda** invece che per comando. Da
non aggiungere per simmetria.

## 2. Hermes tratta i guasti dell'installer come codice di prima classe

Dal listing parziale di `hermes_cli/`:

```
_early_recovery.py   _install_repair.py   _scan_venv_blockers.py   _startup_fast.py
```

Quattro moduli, e nessuno dei quattro *fa* qualcosa per l'utente: esistono
perché l'installazione **si rompe**, e perché rompersi in un modo che nessuno
ripara è la cosa che gli è costata. Il nostro `install.sh` sono 145 righe con
`say()` e `die()`, e niente che ripari.

Non è un invito a scrivere quattro moduli. È il commento su cosa è successo oggi:
**le release si annidavano da tre aggiornamenti e nessuno se ne era accorto**,
perché nulla guardava la forma dell'installazione dopo un update — è saltato
fuori solo perché `doctor` ha stampato un `cp` con tre `.releases` dentro, e
perché un umano l'ha letto. Il rimedio non è un modulo di riparazione: è che il
percorso di update abbia una **verifica di forma** dopo il flip.

## 3. I difetti trovati guardando noi, non loro

### 3.1 Le release si annidavano — chiuso oggi (#199)

`findCheckoutRoot` chiedeva `rev-parse --show-toplevel`, che risponde col
worktree *corrente*; una release è un worktree collegato. Dettagli nel commit.
Vale qui come esempio della §2: nessuna verifica di forma dopo il flip.

### 3.2 `muffin init` rifiuta il comando, non la sorgente — **chiuso il 27/08 (#201)**

`cli/main.ts` esce **78** quando `MUFFIN_API_KEY` è nell'ambiente. La guardia è
giusta e la decisione è dell'owner (18/08): l'environment è un vettore generico e
un segreto non ci passa, fail-closed, e il messaggio non stampa nemmeno la
lunghezza.

Il **posto** è sbagliato. Misurato sull'installazione dell'owner il 27/08: la
chiave era già registrata e valida (`doctor`: `✓ api key secret://provider_api_key
(persistent), 73 chars`), la variabile d'ambiente era un residuo che non
c'entrava con l'operazione richiesta, e `init` si è rifiutato di fare qualunque
cosa.

La forma giusta è rifiutare **quella sorgente**, non il comando: se il keystore
ha già una chiave, dirlo e proseguire — «ce l'hai già, togli la variabile e ruota
se è stata esposta» — invece di uscire. Fail-closed sulla sorgente, non
fail-closed sul comando.

### 3.3 `provider_api_key` non nomina il provider — **chiuso il 27/08 (#207)**

Il nome non dice quale provider, e con un catalogo di provider in albero
(`core/config/providers.ts`, 27/08) diventa attivamente sbagliato il giorno che
ce ne sono due: la stessa installazione avrebbe due chiavi e un nome solo per
descriverle.

Il nome dovrebbe venire dal catalogo — `openrouter_api_key` — esattamente come
`muffin search` prende `tavily_api_key` da `SEARCH_PROVIDERS[id].secretName`.

**Non è un rename secco.** `config.json` §`provider.apiKeyRef` punta al nome
vecchio su ogni installazione esistente, e cambiarlo senza migrazione spegne
l'installazione. La forma: si scrive il nome nuovo, si legge il vecchio finché
esiste, e `doctor` dice che c'è una copia col nome vecchio da cancellare — che è
già il meccanismo che `cmdSecret` usa per le copie in ombra.

## 4. Cosa proporrei, in ordine

1. **Verifica di forma dopo il flip di `update`.** Il difetto di §3.1 è durato
   tre aggiornamenti perché niente guardava. Un passo che dopo lo scambio
   controlla che il launcher punti dentro `<checkout>/.releases/<sha>/` e non più
   in fondo, e arrossa se no. — **aperto.**
2. ~~Spostare la guardia di `init` dalla porta del comando alla sorgente~~ —
   **fatto** (#201): con una chiave già registrata `init` prosegue, avverte, e
   non guarda la variabile.
3. ~~Il rename della chiave con la migrazione~~ — **fatto** (#207): il nome
   viene dal catalogo, si cerca sotto entrambi nell'ordine, e il riferimento
   scritto in config è quello del nome davvero trovato.
4. **Decidere riga per riga quali manopole meritano un verbo** (§1). Non
   `muffin configure`: il criterio di ADR-0036 applicato alla tabella, con le
   caselle vuote riempite o dichiarate volutamente vuote. — **parziale**: hanno
   preso un verbo `model` (main/light/embed), `search`, `think`/`debug` a caldo,
   e `adopt` (#205) per i file di `defaults/`, che era un rimedio stampato e
   mai eseguito. Restano senza: il fallback dell'embedder, `provider.baseUrl`,
   `traces.retentionDays`.
5. **Riprendere questa passata** dove il `429` l'ha interrotta: `hermes_cli`
   oltre `auth.py`, l'`install.sh` di Codex, e come Letta fa il primo avvio. —
   **aperto.**

## Fonti

| Cosa | Dove | Fetch | Tipo |
|---|---|---|---|
| Comandi di Goose | `gh api repos/block/goose/contents/crates/goose-cli/src/commands` | 2026-08-27 | listing completo |
| Struttura di Hermes | `gh api repos/nousresearch/hermes-agent/contents{,/hermes_cli}` | 2026-08-27 | listing **parziale** (429) |
| Nostro elenco comandi | `cli/main.ts` §usage | 2026-08-27 | codice |
| `config` read-only | `cli/config.ts` docstring, ADR-0036 | — | codice + ADR |
| Guardia `MUFFIN_API_KEY` | `cli/main.ts` | 2026-08-27 | codice |
| Stato dell'installazione dell'owner | `muffin doctor`, `readlink ~/.local/bin/muffin` | 2026-08-27 | macchina reale |
