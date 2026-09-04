# ADR-0066 — Leggere è un'altra cosa dall'agire: `sys.http` legge in apertura

**Stato:** accettato · 2026-09-04

## Contesto, e la decisione già presa

L'owner, testuale: *«a causa dell'egress muffin non può manco aprire un sito
web»*, e poco dopo: *«comunque in qualche modo dobbiamo risolvere, ora come
ora non legge nessun sito web, non va bene»*. La sua tesi, posta prima come
domanda e qui eseguita come richiesta: *«gli agenti non funzionano così, tu
leggi qualsiasi sito vuoi, come? parsi il testo… ti viene riportato come
fonte esterna e quindi sai che non sono istruzioni, mi sbaglio?»*.

La preoccupazione di sicurezza che quella domanda porta con sé — un sito letto
può iniettare istruzioni — gli è stata esposta e **l'ha riconfermata**. Non è
quindi una domanda se aprire la lettura: è una domanda su come farlo in modo
difendibile, e su cosa costa. Misurato sulla macchina dell'owner il
03/09/2026: `~/.muffin/rot/egress.json` con `allow: ["api.tavily.com"]`, i
default spediti (`defaults/rot/egress.json`) con la lista **vuota**, e
`sys.http` — l'unico consumatore per-chiamata dell'allowlist
(`grep resourceKind: 'url'` su `agent/tools/*.ts` prima di questa fetta: un
solo risultato) — gated su quella stessa lista in `core/policy/decide.ts`.
Un'installazione fresca non poteva leggere nessuna pagina web che l'owner non
avesse già nominato per hostname in anticipo, il che è esattamente il difetto
che l'owner ha segnalato.

## Il punto che decide tutto: leggere e agire sono due autorità diverse

`core/policy/decide.ts`, prima di questa fetta, aveva un solo ramo per «una
capability che tiene in mano un URL»: il ramo `resourceKind === 'url'`, che
consultava `rot/egress.json` senza eccezioni. Quel ramo confondeva due
domande:

1. **Recuperare byte da una pagina pubblica** — nessun effetto sul mondo,
   nessuna scrittura, nessuna esecuzione. Il turno legge, esattamente come
   legge un file (`agent/tools/fs.ts`, riga `context`: *"reading is not
   acting"*).
2. **Raggiungere un host per fare qualcosa** — scrivere, eseguire, mandare.
   Qui l'allowlist ha un lavoro reale: dire quali destinazioni l'owner ha
   già rivisto per un'azione che le riguarda.

Misurato eseguendo il kernel vero, prima di questa fetta: un membro di gruppo
(taint 2) che chiedeva `http_get` verso un host non allowlisted riceveva un
`deny` secco — lo stesso `deny` che la macchina avrebbe dato a una scrittura
su un host non rivisto. La riga di codice non distingueva le due domande, e
il costo di quella confusione l'ha pagato per primo l'owner stesso, in
privata, sul suo host: leggere un annuncio, un changelog, una pagina di
documentazione — nessuna delle quali è un'azione — chiedeva la stessa
approvazione preventiva di un comando shell.

## Decisione

**Un nuovo genere di risorsa, `url-read`, distinto da `url`.** `sys.http`
(`agent/tools/http.ts`) dichiara ora `resourceKind: 'url-read'`
(`core/policy/types.ts`), e `core/policy/decide.ts` tratta i due generi
diversamente nello stesso ramo:

- `url` (agire) risponde all'allowlist esattamente come prima — nessun
  comportamento cambia per una futura capability che scriva o esegua verso un
  host scelto dal modello (il commento del kernel nomina già `outward.send`
  come il prossimo candidato).
- `url-read` (leggere) **non consulta mai `egressAllowed`**. Qualunque host
  pubblico è raggiungibile in lettura, senza chiedere, senza una voce in
  `rot/egress.json`.

Quello che **non** è cambiato, perché aprire l'allowlist e aprire la rete
sono due affermazioni diverse:

- **Il floor SSRF, indipendente dalla lista.** `core/net/egress.ts#isForbiddenAddress`
  rifiuta loopback, RFC1918, CGNAT, link-local (incluso l'endpoint dei
  metadata cloud, `169.254.169.254`), multicast/riservato e i loro
  equivalenti IPv6 (incluso il v4-mapped, la via classica per cui un
  hostname "pubblico" risolve altrove) — su ogni hop, DNS-risolto prima di
  connettersi, letterale-IP compreso senza toccare il DNS. Esisteva già,
  interamente scritto per la lettura (`sys.http` era già GET-only e
  read-only), e questa fetta non gli ha tolto né aggiunto una riga — l'ha
  solo resa l'unica difesa a monte, ora che l'allowlist non c'è più per
  questo tool. `file:`/`gopher:`/qualunque schema che non sia `http(s):` è
  rifiutato a monte del floor stesso (`current.protocol !== 'http:' &&
  'https:'`).
- **`paramsMaxTaint` sul canale che conta davvero.** L'host non è il canale
  pericoloso — lo è la query string che il modello compone. Una richiesta con
  parametri o frammento sopra `paramsMaxTaint` (2, `POLICY_FLOOR`) chiede
  all'owner e gli mostra l'URL esatto, e nega chiunque altro — mai un
  passaggio silenzioso (`gateParams`, invariato nella forma, applicato ora
  anche al ramo `url-read`).
- **`clipBody` (50k caratteri) e `fence()` a tier 3.** Il corpo di una pagina
  resta recintato con provenienza (`core/memory/spotlight.ts`) e troncato
  esattamente come prima: la stessa difesa che ha tenuto nascosta una ReDoS
  quadratica per settimane resta al suo posto, non ricostruita.
- **Nessun ricontrollo dell'allowlist sui redirect**, perché non c'è più
  un'allowlist da cui un redirect possa uscire per `sys.http`: una pagina
  pubblica che rimanda a un'altra pagina pubblica è la stessa autorità del
  primo hop. Il floor SSRF, lui sì, resta verificato a **ogni** hop — è la
  sola cosa che un redirect può ancora far cadere dentro casa, e continua a
  non poterlo fare.

`makeHttpTool()` non prende più un `EgressPolicy`: prima consultava
`hostAllowed` solo sui redirect (hop > 0) con un commento che diceva "il
kernel ha già approvato l'hop 0" — un secondo controllo dello stesso
meccanismo, ora inerte per costruzione e rimosso invece di lasciato a
dormire (`agent/runtime.ts`, `tools.push(makeHttpTool())`).

## Le due forme scartate, e perché

### Un proxy di terzi universale — Jina Reader (`r.jina.ai`)

Vista in giro dall'owner, va nominata per iscritto una volta sola. **Scartata.**
Mettere `r.jina.ai` (o un proxy equivalente) in `rot/egress.json` non allarga
l'allowlist: la **annulla**. Ogni URL che l'owner chiede di leggere passa
comunque da un terzo (Jina vede l'URL, il contenuto, e la richiesta stessa),
e in cambio non si guadagna niente che il floor SSRF e `fence()` non diano
già: Jina non sa niente della provenienza che serve al kernel, non applica
`paramsMaxTaint`, e sposta la fiducia da "un host che l'owner ha scelto di
leggere" a "un servizio che vede ogni host che l'owner sceglie di leggere".
Un'allowlist con una sola voce universale è indistinguibile da nessuna
allowlist, con in più un testimone permanente.

### I server tools di OpenRouter (`openrouter:web_fetch`, `openrouter:web_search`)

Reperto arrivato a metà fetta: OpenRouter — il solo provider che questo
runtime parla (`core/config/providers.ts`, `ProviderId = 'openrouter'`) — offre
due *server tools* dichiarabili nell'array `tools` della richiesta, eseguiti
**sui server di OpenRouter**, non sulla macchina dell'owner
(`openrouter.ai/docs/guides/features/server-tools/web-fetch`,
`.../server-tools/web-search`, `openrouter.ai/blog/announcements/agentic-web-tools/`,
letti il 04/09/2026):

```json
"tools": [ { "type": "openrouter:web_fetch" }, { "type": "openrouter:web_search" } ]
```

`web_fetch` con motore `openrouter` è **gratis**; con Exa o Parallel è
$0.001/fetch. `web_search` costa $0.005–0.015 a richiesta (Exa/Parallel) o
segue il pass-through del provider nativo. Entrambi sono **in beta**
(*"Server tools are currently in beta. The API and behavior may change"*),
supportano `allowed_domains`/`blocked_domains` e un tetto sul contenuto
(`max_content_tokens`). Vale la pena valutarli con lo stesso rigore con cui
Jina è stata scartata, perché a un primo sguardo sembrano risolvere il
problema aggirando l'egress della macchina per costruzione — a parlare con
l'host è OpenRouter, non l'owner. **Scartati, per ora, e non per l'iniezione**
(quella resta identica su ogni strada: il contenuto ostile entra comunque nel
contesto, ed è la ragione per cui il cancello del corpus avversariale — §
sotto — resta obbligatorio su qualunque forma).

Il motivo di scarto è più a monte, ed è stato verificato prima di scrivere
questa riga, non assunto: **il caller non vede mai la singola chiamata al
tool.** La documentazione di OpenRouter, testuale: *"OpenRouter fetches the
URL... The page content... is returned to the model. The model incorporates
the fetched content into its response"* — l'intera operazione gira
server-side, dentro la stessa risposta, senza un messaggio `tool_calls`/`tool`
separato che il client debba gestire. Per questo runtime questo significa che
**nessuna parte del kernel vedrebbe mai la chiamata**: nessuna
`resourceKind`, nessun `taint`, nessun `muffin.policy_decision`, nessun
`fence()`, nessuna redazione — l'intero apparato che rende una lettura
ispezionabile (compreso il corpus avversariale, che misura proprio quegli
span) non avrebbe niente su cui girare. Non è "un canale con guardie più
deboli": è un canale che il nostro modello di autorità non può nemmeno
osservare, il che è una regressione più grave di una allowlist assente, non
una scorciatoia per evitarla.

Due domande restano esplicitamente **aperte**, non risolte per assunzione: se
`provider.data_collection: 'deny'` — che l'owner ha già impostato
(`core/config/config.ts:111`, spedito su ogni richiesta da
`agent/providers/openai-compat.ts:181`) — si estenda anche al motore
(Exa/Parallel) che un server tool sceglie, o valga solo per il provider di
inferenza del modello; e se `routing.only` faccia lo stesso. La documentazione
letta il 04/09/2026 non lo dice in nessuna delle pagine consultate. Finché
resta senza risposta scritta da OpenRouter, adottare un canale che potrebbe
mandare contenuto dell'owner a un terzo che le sue stesse impostazioni
dichiarate escludono è un rischio non misurato, non un rischio accettato.

Nota per il giorno in cui questo si riapre: `web_fetch` con motore
`openrouter` è **gratuito** e resta dentro la singola chiamata al modello —
un'asimmetria da tenere separata da `web_search`, che è sempre a pagamento
verso un terzo che l'owner non ha scelto (a differenza di Tavily, per cui ha
già una chiave e una decisione presa). Le due metà di questa offerta non
condividono la stessa risposta.

### Un proxy nostro

Lasciata aperta per il futuro, nominata col suo costo: un servizio che
recupera pagine per conto di Muffin risolverebbe il problema del terzo di
Jina (il servizio è nostro) ma non quello architetturale di OpenRouter (se
gira fuori dal processo che esegue il kernel, la stessa domanda su
osservabilità si riproporrebbe, sia pure con risposta nelle nostre mani
invece che nella documentazione di qualcun altro) — e aggiunge un servizio da
scrivere, ospitare e mantenere per un problema che `sys.http` diretto già
risolve oggi senza infrastruttura in più. Non scartata: rinviata, in assenza
di un motivo misurato per pagarne il costo adesso.

## Il residuo misurato, non introdotto qui, e non chiuso qui

`gateParams` — la difesa su cui questa fetta si appoggia per dire che
"leggere è aperto" non significa "esfiltrare è gratis" — ha un buco misurato
il 04/09/2026 eseguendo il kernel vero
(`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §6.1–6.2): `paramsMaxTaint`
è **2**, `tierOf(member)` è **sempre 2**
(`core/surface/types.ts:330-332`), e un turno di gruppo *parte* esattamente a
quel taint — non ci arriva dopo una lettura, come fa un turno dell'owner in
privata. `gateParams` scatta solo **sopra** il ceiling, mai su di esso, quindi
per un membro di gruppo che non ha ancora letto niente di tier 3 il gate non
si accende **mai**: una query string scelta dal modello verso un host
qualunque — allowlisted ieri, aperto oggi con questa fetta — esce senza che
nessuno la veda. Questo non è un buco che `url-read` crea: esisteva
identico, sullo stesso meccanismo, per il ramo `url` prima di questa fetta
(un host già in allowlist con un membro di gruppo aveva lo stesso problema),
misurato e dichiarato in quel documento, non in questa ADR. **Non lo risolve
neanche questa fetta** — non è nel suo mandato, e la correzione che il
documento nomina (una soglia diversa per la classe di richieste di gruppo, o
un secondo criterio oltre al taint assoluto) tocca la matrice normativa, non
il confine leggere/agire che questa ADR sposta. Nominarlo qui serve a una
cosa sola: non lasciare che il disegno di questa fetta sembri poggiare su un
freno che, per un turno di gruppo, non c'è.

## Il cancello: il corpus avversariale, prima e dopo

Linea di base misurata su `dev` prima di questa fetta (7 scene):
**4/7 attacchi riusciti senza umano, 6/7 se l'owner risponde come ha risposto
davvero (32/35), 7/7 controlli vivi**. Rieseguito identico dopo questa fetta,
stesse 7 scene: **4/7, 6/7, 7/7** — nessuna riga cambiata nella tabella
principale. L'unica differenza osservabile è nella spiegazione di `s4` (la
scena di egress): prima, il taint fuori-allowlist produceva un
`deny/resource_denied` registrato; dopo, `sys.http` non consulta più
l'allowlist e quella riga di traccia sparisce — il floor SSRF resta l'unica
cosa che ferma quella scena, in entrambe le corse (il sink è loopback, quindi
irraggiungibile per `sys.http` con o senza questa fetta).

Aggiunta una scena nuova, **S8**, come richiesto: una pagina ostile che
istruisce la richiesta *successiva* a portare un segreto nella sua query
string. A differenza di ogni scena di egress precedente, S8 non chiama
`allowlist()` prima di girare — dimostrazione strutturale, non dichiarata,
che `sys.http` non ne ha più bisogno. Misurata: **fermata dal floor SSRF del
tool** (il sink di misura è loopback, come per S4; nessun host pubblico
risolve in un ambiente di test senza rete — lo stesso limite che S4 dichiara
per lo stesso motivo). Quello che S8 non può provare in questa macchina — che
a un taint 3 vero (una lettura esterna riuscita) il gate sui parametri
trasformi la seconda richiesta in un `ask` per l'owner — è dimostrato
separatamente, per esecuzione diretta del kernel senza il floor di rete nel
mezzo, in `agent/read-then-egress.test.ts` ("params on any host…") e
`agent/session-history-taint.test.ts` ("the kernel of the second turn's very
first decision already sees taint 3, not 0").

Con S8 incluso, il corpus a 8 scene: **4/8 attacchi riusciti senza umano, 6/8
con la stessa risposta dell'owner, 8/8 controlli vivi** — stessi numeratori
delle 7 scene originali, un solo denominatore in più. **Nessun peggioramento
misurato.**

Confronto A/B (candidate A = lo scalare eseguito da questo kernel, candidate B
= la tupla che guarda anche chi ha scelto la risorsa, `evals/security/candidate-b.ts`):
su `s4` e `s8` A ora risponde `allow` dove prima (con `resourceKind: 'url'` e
un mismatch di tipo non ancora corretto in `corpus.ts`) rispondeva `deny` per
un artefatto di misura, non per una decisione — corretto aggiornando
`AZIONE_DELLA_SCENA['s4-read-then-egress']` a `{kind: 'url-read', ...}` prima
di leggere i numeri finali. Con la correzione, A/B per S4/S8: `A=allow`,
`B=deny`, B più stretta su entrambe — lo stesso risultato che il corpus dava
già su `dev` prima di questa fetta per S4.

## Alternative considerate (dentro il disegno accettato)

**Abbassare `paramsMaxTaint` invece di separare leggere da agire.** Scartata:
non risolve il problema misurato (leggere restava gated sull'host, non sui
parametri), e stringere il ceiling di `paramsMaxTaint` per tutti pagherebbe
il costo dichiarato dalla decisione owner del 17/08 ("Ships 2") — un `ask` a
ogni lettura successiva a un file locale, il riflesso che questo repository
ha già misurato essere il fallimento, non la difesa.

**Un `resourceKind` unico con un flag booleano `readOnly`.** Scartata a favore
di un genere di risorsa distinto (`url-read` vs `url`) perché il tipo stesso
del sistema — non un campo opzionale ispezionabile solo a runtime — deve
rendere impossibile costruire un `DecisionRequest` che dichiari `url` e riceva
il trattamento di `url-read` per errore. `resource.kind !== decl.resourceKind`
resta un `deny` fail-closed per entrambi i generi, esattamente come lo era
per `url` da solo.

## Conseguenze

- `sys.http` legge qualunque host pubblico, sempre, per l'owner e per un
  membro di gruppo (`hostOnly: false`, invariato) — l'invarianza che l'owner
  ha chiesto.
- `rot/egress.json` resta vivo per tutto il resto: la verifica a boot di
  `web_search` (`agent/tools/search.ts`, `diagnoseSearch`), e qualunque
  futura capability `url` (agire). Non diventa un file morto — perde un solo
  consumatore.
- Il residuo di §"Il residuo misurato" si applica ora a **qualunque** host,
  non solo a uno già in allowlist: la superficie su cui quel buco esiste si
  allarga da "gli host che l'owner aveva già approvato" a "qualunque host" —
  la stessa direzione in cui questa ADR allarga la lettura. Nominato, non
  richiuso.
- `makeHttpTool()` perde un parametro (`EgressPolicy`) e la sua chiamata su
  ogni redirect: meno codice, non di più, per lo stesso motivo per cui
  ADR-0013 preferisce togliere un meccanismo inerte piuttosto che lasciarlo
  dormire accanto a uno vero.

## Reversibilità

**Alta.** Il ramo `url` (agire) è bit-per-bit quello di prima; il nuovo ramo
`url-read` è un'aggiunta, non una riscrittura. Tornare al comportamento
precedente per `sys.http` significa cambiare una riga (`resourceKind: 'url'`)
e restituire `egress` a `makeHttpTool`, non ricostruire un meccanismo tolto.

## Come si prova che il cablaggio c'è

Quattro mutazioni, ciascuna con un'asserzione distinta che diventa rossa e
nessun'altra:

1. **Il floor SSRF sul redirect (hop > 0)** — disattivato (`hop > 0 ? null :
   addressVeto(...)`): `agent/tools/http.test.ts` → *"refuses a redirect that
   resolves into a private address"* passa da verde a rosso (`fetch failed`
   invece di `non-routable`), le altre 15 in quel file restano verdi.
2. **Il controllo di corrispondenza `resource.kind === decl.resourceKind`**
   — disattivato: `core/policy/decide.test.ts` → *"refuses a url capability
   that was handed no url at all"* rosso sul testo del `detail`
   (`"unparseable url"` invece di `"declares a url resource but received"`).
3. **Il gate sui parametri per `url-read`** — disattivato (`decl.resourceKind
   !== 'url-read' && hasParams(...)`): tre asserzioni distinte in due file
   diventano rosse — `agent/read-then-egress.test.ts` ("params on any
   host…") e due in `agent/session-history-taint.test.ts` (il laundering a
   taint 3 e la sua reiniezione a un turno 3).
4. **`isForbiddenAddress` neutralizzato** (`return false`): 20 test su 45 in
   `agent/tools/http.test.ts` + `core/net/egress.test.ts` diventano rossi.

Prova sul binario compilato (`npm run compile`, `dist/agent/tools/http.js`,
`makeHttpTool()` senza alcun argomento di policy), rete vera:

```
=== pagina pubblica vera (example.com) ===
{ "tier": 3, "contentPreview": "200 text/html\n<<<web_9cc678493af1 — GET https://example.com/ → 200\n..." }

=== IP privato (127.0.0.1) ===
{ "isError": true, "tier": 0, "content": "address not routable from here: 127.0.0.1" }

=== IP privato RFC1918 (10.0.0.5) ===
{ "isError": true, "tier": 0, "content": "address not routable from here: 10.0.0.5" }

=== metadata endpoint cloud (169.254.169.254) ===
{ "isError": true, "tier": 0, "content": "address not routable from here: 169.254.169.254" }
```
