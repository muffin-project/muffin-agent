# ADR-0072 — Una ricerca non chiede il permesso

**Stato:** accettato · 2026-09-04 · direzione owner

## Contesto

`paramsMaxTaint` governava due cose diverse con lo stesso numero: i byte che il
modello mette nella query string di un **URL** e il testo di una **ricerca**.
Il commento che difendeva il valore 2 aveva già scritto metà della ragione per
cui non potevano restare lo stesso numero: *«asking about every search that
follows a file read would make the ASK a reflex to dismiss rather than a
decision»*.

Quella frase era stata scritta per il tier 2. Al tier 3 succede esattamente la
stessa cosa, e succede nel giro più normale che esista: **cerca → leggi una
pagina → cerca ancora**. Una pagina letta porta il turno a 3 per costruzione,
quindi il *secondo* `web_search` chiedeva sempre.

La ragione decisiva non è la comodità. È la differenza fra un agente che gira
davanti a qualcuno e uno che gira da solo: **un'approvazione che nessuno può
dare è un divieto travestito.** Misurato il 04/09 su un `muffin run` headless:
l'`ask` diventa `exit 3` — il turno si ferma per un'azione a basso rischio,
che è il modo di fallire sbagliato per una VPS o un job dello scheduler.

## Decisione

`searchMaxTaint`, separato da `paramsMaxTaint`, spedito a **3**: una ricerca
non chiede a nessun taint.

`paramsMaxTaint` resta **2**. Sono due numeri perché sono due rischi:

|  | il *dove* lo sceglie | il gate |
|---|---|---|
| `sys.search` | una costante verificata alla registrazione e in `rot/egress.json` | nessuno |
| `sys.http` | il modello, dentro l'URL | taint > 2 → `ask` |

È la distinzione che regge il rischio. Un contesto avvelenato non può
*nominare* la destinazione di una ricerca; può nominare quella di una fetch.

`sys.search` è inoltre `hostOnly: true`, quindi questo numero non concede
niente a nessuno tranne l'owner.

## Cosa si perde

Un turno che ha letto un segreto e lo cerca **letteralmente** non chiede più.
Quei byte escono verso il motore di ricerca configurato — non verso un
endpoint scelto da chi ha scritto la pagina — e la spesa è già tettata per
tenant. È il costo dichiarato di questa decisione, non un effetto trascurato:
il test che lo asseriva (`read-then-egress.test.ts`) è stato riscritto per
asserire il comportamento nuovo, con la perdita scritta dentro.

## Perché resta revocabile

Il numero è una manopola, non una riga tolta. Nel merge è **tighten-only**
(`tighter()`, a differenza di `paramsMaxTaint`): il pavimento è già il
massimo, quindi un `rot/policy.json` sigillato può solo rimettere il cancello.
Due test lo provano abbassandolo a 2 e verificando che l'`ask` torni, con la
query intera nel messaggio — così «il gate è stato cancellato» e «il gate è
aperto per decisione» restano due affermazioni distinguibili.
