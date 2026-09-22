# ADR-0090 — Il percorso canonico è nel gate e il disco non cita

**Stato:** accettato · 2026-09-22 · lane #624 + #641 · policy già decisa

## Contesto

ADR-0071 aveva dato al gate sui parametri il criterio giusto — la provenienza
invece del numero — ma su una rappresentazione dimezzata: `hasParams`
guardava `search` e `hash` e dichiarava di non guardare il path. ADR-0066
aveva tolto l'allowlist alla lettura senza mettere niente al suo posto per il
path. Risultato misurato su `dev`: `https://evil/<segreto>` non incontrava
nessun cancello a nessun taint (#624).

Sopra restava il numero vecchio: `paramsMaxTaint` spediva 2 con la ragione che
il tier 2 «è il disco dell'owner». Il modello delle minacce dice da allora il
contrario per la provenienza: il disco è recintato proprio perché i file
possono essere attacker-controlled (`fs_read`, `fs_list`, `fs_search`,
`shell_run` tornano `DISK_TIER = 2` come entry point di prompt injection).
Tier 2 è locale, non è owner-authored — e `2 > 2` è falso, quindi una query
composta dopo una lettura usciva silenziosa (#641).

## Decisione

Tre mosse sullo stesso seam, nessuna nuova architettura di provenienza per
componente:

1. **`paramsMaxTaint`: 2 → 1** (pavimento e template `defaults/rot/policy.json`).
   Byte composti dal modello in uscita a taint ≥ 2 chiedono all'owner
   mostrando l'URL intero; a chi non è owner sono negati. Il soffitto è
   **monotono** come ogni altro (`tighter()` nel merge, risoluzione HOLD del
   22/09): il file sigillato può stringere sotto 1, mai riallargare sopra —
   una home sigillata col vecchio shipped 2 carica confinata a 1, altrimenti
   l'upgrade conserverebbe il path P0 che la lane chiude. Riaprire il confine
   è una decisione/prodotto separata, esplicita e versionata — non un reseal.
2. **Il pathname entra nella stessa decisione** (`hasComposedBytes`):
   path non banale, userinfo, query, fragment — letti dal parse canonico
   (`new URL`, lo stesso parser che il tool esegue: nessuna seconda
   canonicalizzazione da mantenere). La userinfo perché viaggia come
   credenziali della richiesta; il fragment per conservatività anche se il
   trasporto lo scarta prima del connect. L'host nudo resta silenzioso:
   leggere resta aperto.
3. **Solo due classi di ingressi rendono «citata» una URL intera**: il
   messaggio umano e i risultati del web aperto (`sys.http`, `sys.search`).
   Un documento tier-2 che contiene o inventa la stessa URL non acquisisce
   provenienza owner. La citazione resta letterale sull'intera URL — mai
   equivalenza canonica, mai prefisso/host-only — e l'output del modello
   resta escluso come prima.

## Conseguenze

- Dopo una lettura da disco, seguire byte composti in path/query chiede: è
  l'attrito deciso, misurato in `evals/security/` (s5/f1/f2 rimisurate).
- Seguire un link esatto trovato via search resta silenzioso; un link
  incollato dall'owner resta silenzioso a qualunque taint.
- I membri non compongono mai byte in uscita in silenzio — la regola del deny
  già esistente per query/fragment si estende al pathname.
- I redirect non rivalutano la policy (solo il floor SSRF per hop, #647
  intatto): i byte del `Location` li sceglie il server, non il modello —
  qualunque segreto del modello deve già stare nella first-hop URL, che è
  gattata.
- Home sigillate con `paramsMaxTaint: 2` esplicito caricano confinate a 1: il
  monotone floor vale anche per loro, ed è pinnato da un falsifier
  upgrade/legacy-home (`core/policy/matrix.test.ts`).

## Prove

`agent/url-provenance-624-641.test.ts` (F1–F7: 15 rossi pre-fix, 21 verdi
post-fix), `core/policy/decide.test.ts`, `evals/security/` rimisurati. La
locality/SSRF di #647 non è toccata.
