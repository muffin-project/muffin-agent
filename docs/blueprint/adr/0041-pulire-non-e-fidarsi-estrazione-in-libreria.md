# ADR-0041 — Pulire non è fidarsi: l'estrazione locale entra come libreria, non sottoprocesso né servizio

**Stato:** accettato · 2026-08-14 · chiude M5-bis gap A (`04-roadmap.md` §"Dal
confronto con la consulenza esterna")

**Contesto.** `agent/tools/http.ts:130` restituiva il corpo grezzo di ogni
risposta — HTML compreso — e `clipBody` (`:169`) tagliava solo sopra 50.000
caratteri, testa 40k + coda 10k: sotto quella soglia (la maggioranza delle pagine
misurate) l'HTML intero raggiungeva il modello, tag e script compresi.
`research/recupero-dal-web.md` (2026-08-14) ha misurato il buco su quattro pagine
vere — 9.700-17.000 token per pagina, quasi tutto markup — e ha già scelto la
direzione: estrazione locale davanti a `clipBody`, mai un servizio terzo
(Firecrawl/Jina leggerebbero la pagina al posto nostro — scartati in
`04-roadmap.md` prima di questa ADR). Restava aperto solo *come* entra
l'estrazione nel processo, ed è il primo parser HTML a farlo: vale scriverlo una
volta.

**Decisione.** `agent/tools/extract.ts`, nuovo modulo, davanti a `clipBody` in
`agent/tools/http.ts`. `defuddle` (`import { Defuddle } from 'defuddle/node'`) su
`linkedom` come motore DOM — libreria, importata nel processo dell'agente, mai un
sottoprocesso e mai un servizio.

*Non un sottoprocesso*: girare `curl … | npx defuddle parse` nel sandbox
scambierebbe una dipendenza dichiarata e pinnata con un pacchetto scaricato dalla
rete a ogni chiamata (`npx` senza provisioning) — esattamente ciò che
`.claude/hooks/guard-new-dep.mjs` esiste per impedire nel repo principale,
ricreato senza guardia, a runtime, ogni volta (`recupero-dal-web.md`
§"Il terminale, argomentato e non assunto"). *Non un servizio*: già deciso.
*Non "più `clipBody`"*: nessuna euristica testa+coda distingue `<nav>` da
`<article>`; serve un albero DOM.

L'invariante che questa ADR non tocca, e che il titolo nomina: **pulire non è
fidarsi**. Il testo estratto resta `tier: 3`, resta dentro lo stesso `fence()` che
avvolgeva il corpo grezzo; `sys.http` non cambia dichiarazione, l'allowlist di
egress, il ricontrollo per-hop dei redirect e il veto SSRF non sono toccati.
Cambia solo quanto testo entra nel recinto — e `clipBody` resta, invariato, la
rete finale: da quasi sempre attiva a quasi sempre inerte.

Due guardie, ciascuna testata con una fixture che la fa scattare. **Il gate sul
`content-type`**: l'estrattore gira solo su `text/html`/`application/xhtml+xml`;
un corpo JSON, CSV o testo puro attraversa `clipBody` byte-identico — passare un
body JSON in un parser di articoli sarebbe una regressione peggiore di quella che
questa ADR chiude. **L'estrazione non può mai far fallire il fetch**: Defuddle che
lancia, che non trova nulla, o che restituisce qualcosa di implausibilmente
piccolo (soglia 300 caratteri, sopra un input di almeno 2.000) ricade sul corpo
grezzo. La soglia non è arbitraria: 217 caratteri di banner-cookie estratti al
posto dell'articolo da una pagina di 1,3M è il fallimento che `recupero-dal-web.md`
ha misurato — con Readability, non Defuddle, ma la forma del fallimento è quella
che la soglia sorveglia, indipendentemente da quale estrattore la produca.

**La correzione che la ricerca non aveva, verificata qui prima di installare, non
assunta.** `recupero-dal-web.md` misurava `linkedom` + `defuddle --omit=optional`
a 19 pacchetti / 9,8 MB, sulla premessa che `turndown` — l'unica dipendenza
richiesta per `{markdown: true}` — restasse fuori. Falso: letto ed eseguito il
`dist/` installato, `defuddle/node` (il punto d'ingresso che questo progetto usa)
richiede `./markdown` a livello di **modulo**, non dentro la funzione che legge
l'opzione; `markdown.js` richiede `turndown` allo stesso livello. L'import fallisce
sotto `--omit=optional` con `Cannot find module 'turndown'`, indipendentemente dal
valore di `markdown` — persino `{markdown: false}` fallirebbe allo stesso modo,
perché il fallimento è all'import, non alla chiamata. `mathml-to-latex` fallisce
per una strada indipendente: `elements/math.js` reindirizza sempre a
`math.full.js`, che lo richiede a livello di modulo, a dispetto di quanto la
distinzione "core bundle / full bundle" del proprio README lascia intendere. Solo
`temml` è davvero opzionale — il suo unico require vive dentro un `try`/`catch`,
mai a livello di modulo, verificato eseguendo l'import con `temml` assente e
gli altri tre presenti: riesce.

Footprint reale, stesso metodo della ricerca (installazione isolata, cancellata
dopo la misura): **20 pacchetti / 20 MB**, non 19/9,8 MB. `@mixmark-io/domino` — il
secondo motore DOM indipendente che la ricerca pensava di evitare scegliendo
Defuddle — **è presente comunque**, 8,8 MB, perché lo porta `turndown` e
`turndown` non è evitabile. La correzione è appesa a `recupero-dal-web.md`
(§"Addendum … the optionalDependencies premise does not hold"), mai riscritta in
loco (`docs/PRACTICES.md` §13.3). Non cambia la scelta fra Markdown e testo
semplice a favore del secondo: dato che `turndown`/`domino` si pagano comunque
all'import, il Markdown è gratuito sopra quel costo e più leggibile per il modello
di un taglio ingenuo dei tag. `{markdown: true}` resta.

Gap A si chiude quindi a **13 dipendenze runtime, non 11**: `defuddle`,
`linkedom`, `turndown`, `mathml-to-latex` tutte dichiarate esplicitamente in
`package.json`, non lasciate come installazioni transitive non dichiarate — un
pacchetto che il codice richiede davvero all'import non è, in nessun senso che
conti qui, opzionale.

**Alternative scartate.** *Sottoprocesso* e *servizio terzo*: sopra, §Decisione.
*`@mozilla/readability`*: misurata nella stessa ricerca sulle stesse quattro
pagine — su una (documentazione Anthropic, resa server-side) ha estratto il
banner dei cookie invece dell'articolo; Defuddle ha recuperato il contenuto
corretto sulla stessa pagina, e la propria documentazione dichiara un sistema di
rilevazione multi-passata costruito apposta per quel fallimento. *`jsdom` al posto
di `linkedom`*: 26 MB contro 6,6 MB per lo stesso ruolo, nessun vantaggio misurato
che giustifichi la differenza. *Contenuto HTML di Defuddle spogliato a mano invece
di `{markdown: true}}`*: non riduce la dipendenza (l'import richiede `turndown`
comunque, sopra) e produce un risultato peggiore per il modello — scartata una
volta appurato che il risparmio non esiste.

**Conseguenze.** Più facile: `clipBody` ora quasi sempre inerte; la maggioranza
delle pagine passa da HTML grezzo intero (sotto i 50k caratteri, oggi mai
troncato) a poche migliaia di token di contenuto vero — misurato su due pagine
reali, −26,7% e −74,4% contro ciò che `http_get` restituisce oggi (numeri e
metodo in `04-roadmap.md` §M5-bis gap A e in `recupero-dal-web.md`). Più
difficile: il repo passa da 9 a 13 dipendenze runtime in un progetto che le conta
e le sorveglia una per una (`.claude/hooks/guard-new-dep.mjs`); un bug di parsing
in una delle quattro, o nel loro albero transitivo, ora sta fra ogni fetch HTML e
il modello — mitigato, non eliminato, dalle due guardie sopra.

**Reversibilità.** Alta: `agent/tools/extract.ts` è l'unico chiamante di
`defuddle`/`linkedom`; toglierlo ripristina esattamente il comportamento
pre-ADR, perché un `extractFn` che ritorna sempre `null` è già il percorso di
fallback testato — il corpo grezzo torna a `clipBody` invariato. Segnali che era
sbagliata: un bug di parsing di Defuddle che raggiunge il modello nonostante le
due guardie (dovrebbe essere impossibile per costruzione — se succede, una delle
due ha un buco, non solo Defuddle); oppure una quota rilevante delle pagine che
l'owner fa recuperare risultasse renderizzata lato client senza equivalente
server-side — nessun estrattore DOM-based risolverebbe quel caso, e la domanda
diventerebbe "serve un fetch con rendering", già nominata come fuori scope in
`recupero-dal-web.md`.
