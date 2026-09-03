# Il lavoro che viene — cinque item dalla conversazione owner, 03/09/2026

Nasce da una conversazione dell'owner con Muffin lo stesso giorno di
`docs/evidence/dogfood-superfici-2026-09-03.md` e
`docs/evidence/continuita-e-provenienza-2026-09-03.md`. L'owner: *«ste cose
vanno tutte inserite nei vari docs di conseguenza cosi da non dimenticare ste
cose che dobbiamo fare … quindi aggiungiamole e diamo priorita a cio che
serve, prima finiamo cio che stiamo finendo»*. Questo file è la registrazione;
`docs/ROADMAP.md` e `docs/SECURITY.md` portano i rimandi da dove si legge
oggi.

## 1. Cinque item, nelle parole dell'owner/di Muffin

1. **Muffin scrive issue GitHub; un esecutore le esegue.** L'inquadramento è
   di Muffin stesso: scrivere una issue è un piano, non codice, ed è
   reversibile — sta dentro un confine revocabile. Ma senza poter **leggere**
   la pull request, i commenti e le review risultanti, è un pianificatore
   cieco: scrive, la cosa sparisce, e non impara mai se è stata fatta bene.
   L'item è quindi «scrivi issue **e** rileggi le loro conseguenze», mai solo
   la prima metà.
2. **La consegna, non la scrittura, è ciò che manca per il coding.** Muffin
   sa già scrivere codice, far girare i test e committare in locale — manca
   push/PR (nessun egress di rete oggi) e, in secondo piano, il parallelismo
   (subagenti). Il passo grande più economico è una skill di coding (piano →
   implementazione → test → commit → PR) più `github.com` nell'allowlist di
   egress.
3. **Confini per-task invece di un allowlist piatto.** `rot/egress.json` è
   dentro-o-fuori: non esiste un perimetro scoped a un task. È la forma
   tecnica della frase dell'owner: *«se giri nel perimetro hai governance e
   quindi puoi fare cose più liberamente»*.
4. **Esistenza fuori dal turno.** Zero job, nessun heartbeat: Muffin esiste
   solo quando viene chiamato. L'owner lo mette per primo lui stesso, perché
   blocca gli altri quattro.
5. **Sensi.** Oggi Muffin vede il vault e i messaggi. Non il calendario, non
   l'email, non i progetti a metà.

## 2. Evidenza misurata — `todos` fermi dal 27/08

Numero comunicato dal coordinatore di questa sessione dalla conversazione
owner del 03/09, **non riletto qui** (questo worktree non tocca `~/.muffin`
per vincolo di mandato — vedi CLAUDE.md del progetto): sul database vivo
dell'owner la tabella `todos` porta **sette righe ancora `pending` dal
2026-08-27** — un piano scritto e mai più risalito a galla. Non si
addolcisce: è la cifra di «esisto solo quando mi chiami», misurata invece che
supposta. `B4` (`docs/work/day1/requirements-status.md`) è READY per «il
piano è letto a ogni turno della sessione»; questa evidenza mostra il lato che
`B4` non copre — nessun turno riparte da solo a rileggerlo se nessuno scrive
alla sessione.

## 3. Correzione misurata sul codice — surface ≠ node, e la scrittura è già larga quanto la Home

Muffin aveva detto all'owner che oggi può già fare piccole slice di lavoro sul
checkout. **Su Telegram è falso**, verificato qui sul codice (non a memoria):

- `core/gateway/unit.ts:278` — il gateway supervisionato pina
  `WorkingDirectory=${home}` nella unit systemd (idem la property
  `WorkingDirectory` della plist, `core/gateway/unit.ts:376`).
- `cli/gateway.ts:602` — `runtime = buildRuntime(home)`, nessun `cwd` passato.
- `agent/runtime.ts:231` — `buildRuntime` di default prende
  `cwd = process.cwd()`.

Conseguenza: sul gateway supervisionato `process.cwd()` — e quindi
`scope.root` (`agent/runtime.ts:515`) e il `writeScope` del tool shell
(`agent/tools/shell.ts:148`) — è `~/.muffin`. Un checkout del repository fuori
da lì è fuori dallo scope di scrittura di quel turno. Da un REPL aperto dentro
il checkout la stessa richiesta funziona, perché lì `cwd` è già il checkout.
**La stessa richiesta riesce o fallisce secondo la porta da cui arriva**, e
Muffin non lo sa.

**Lo scope oggi è già largo quanto l'intera Home, non solo quanto basta.**
`core/rot/guards.ts` (`mandatoryGuards`) nega in scrittura solo `rot/`,
`config.json`, le due directory dei segreti, `.git/hooks` e i dotfile di
shell. `core/config/config.ts:295-330` mostra che `muffin.db` (`paths().db`),
`sessions/`, `.rot-anchor` (fuori da `rot/` per disegno — commento in
`core/rot/verify.ts:49`, *«Lives outside the RoT directory: an anchor inside
what it anchors is decoration»*) e `voice.md` (`paths().voice`) vivono tutti
**fuori** da quella lista di deny. Un comando shell in un turno può scriverli
tutti oggi, perché `scope.root` è la Home intera. Questo è lavoro già in
corso altrove (lo stato osservato di Git/PR lo possiede, non questo file); è
anche un prerequisito per l'idea del Node — allargare *dove* il lavoro può
girare mentre lo scope di scrittura è già così largo, allargherebbe il
raggio prima di stringere il confine.

## 4. La correzione che riformula tutto — surface vs node

La risposta dell'owner è la frase che governa questo punto, e resta una
**domanda di progettazione aperta**, non una direzione decisa:

> **la capability non deve dipendere dalla surface, ma da dove vive Muffin —
> il nodo.** «anche se sta in una vps, e io scrivo da telegram, e il nodo del
> macbook sta acceso, deve poter lavorare su quei file».

Il repository oggi confonde due significati diversi di «superficie»: **da
dove arriva un messaggio** e **dove il lavoro esegue**. Separarli introduce la
nozione di un **nodo** di esecuzione distinto da una **surface** di ingresso —
e con essa una domanda di sicurezza che va posta nello stesso respiro, non
rimandata: un messaggio forwardato a taint 2 arrivato su Telegram potrebbe,
sotto quella separazione, raggiungere il filesystem di un laptop. Il confine
va progettato prima della capability — l'owner l'ha detto lui stesso:
«ovviamente tutto questo va gestito bene e specialmente in modo sicuro, quindi
approcciamo tutte queste cose con il nostro modo di lavorare» — cioè
`docs/RESEARCH.md` prima dell'implementazione.

Questa domanda interagisce con due ADR esistenti, senza contraddirle:

- **ADR-0021** si è già dovuta correggere una volta (§revisione 2026-09-03)
  per essersi contraddetta fra «il canale non è parte dell'identità» e «il
  modello di sessione è `(tenant, surface, thread)»: la stessa classe di
  errore — confondere un indirizzo di consegna/esecuzione con un'identità —
  è il rischio qui, sull'asse dell'esecuzione invece che su quello della
  conversazione.
- **ADR-0056** lega `sessionKey` a `identify()`, indipendentemente dalla
  porta: è una decisione sull'identità della **conversazione**, non su dove
  una capability **esegue**. Un futuro ADR sul nodo deve tenere le due
  affermazioni distinte, non farne una la stessa cosa.

**ADR-0050** aveva già separato Node e Surface **sulla carta** (§3): questa
sezione mostra che il runtime non li separa ancora, e nomina la causa concreta
(§3 sopra), non solo l'assenza architetturale già scritta in
`docs/SECURITY.md` §13 («Il protocollo Node non esiste nel runtime corrente»).

## 5. Dove atterra ciascun punto

- §2 (evidenza `todos`) → `docs/ROADMAP.md`, nuova sezione sotto *MVP /
  trusted alpha*, in relazione a B4/B7/B9 esistenti.
- §3-§4 (surface ≠ node) → `docs/ROADMAP.md` “First Mac capability Node”
  (estesa) e `docs/SECURITY.md` §13 (nuovo punto, boundary nominato senza
  deciderlo).
- I cinque item (§1) → `docs/ROADMAP.md`, cinque nuove sottosezioni sotto
  *MVP / trusted alpha*, ordinate e giustificate lì.
