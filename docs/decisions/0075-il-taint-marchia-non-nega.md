# ADR-0075 — Il taint marchia, non nega: sull'host decide la reversibilità

**Stato:** accettato · 2026-09-06 · decisione owner (*«per il taint non ha
senso che ancora abbiamo sti problemi, inutilizzabile in sto modo»*) sul
`muffin.db` vivo e sul corpus avversariale di SECURITY §13

## Contesto

ADR-0074 ha tolto al taint la facoltà di **chiedere**: un `ask` nasce solo da
`reversible: 'no'` su una riga che chiede. Gli ha lasciato la facoltà di
**negare** sopra `denyAbove` («il soffitto non si muove», ADR-0044). Misurato
sull'installazione dell'owner il 06/09, quel soffitto è ciò che rende Muffin
inutilizzabile:

- la riga `host` nega sopra taint 2; `web_search` e `http_get` restituiscono
  contenuto di livello 3, `memory_search` di livello 2, e il livello di una
  sessione non scende mai. Il 06/09 nove turni su quattordici in privato
  erano a taint 3; l'ultima chiamata reale alla shell è del 03/09, e l'ultimo
  turno è finito con `context taint 3 exceeds 2 for sys.shell (host)`. In
  pratica: dopo una ricerca web, niente shell né scrittura fino a una
  conversazione nuova, e il modello lo racconta come «non ho la shell».
- lo stesso vale per i `maxTaint` per capability: `skill.read` e
  `sys.process.list` a 1, `sys.shell` a 2. Sono letture.

Il divieto non compra sicurezza dove sta. Con ADR-0074 ogni capability della
riga `host` è già coperta da un'altra difesa: `fs.write` è `draft` con
giornale e `muffin undo`; `sys.shell` in sola lettura (punto 4) non scrive
fuori dallo scratch e non ha rete; `sys.shell.write` e `sys.process.kill`
chiedono **sempre**, a taint 0 come a 3. Il divieto per taint toglie solo
all'owner la possibilità di dire sì. E il corpus avversariale (SECURITY §13,
03/09 e 04/09) lo aveva già mostrato: quattro attacchi su sette completano
senza umano, sei su sette se l'owner risponde come risponde, e le guardie
che hanno fermato qualcosa sono state l'allowlist di egress, il pavimento
SSRF del tool e **una** domanda — mai lo scalare ambientale.

Dove il taint conta è una cosa sola: i byte che **escono** dal tenant
(`external`, `outward`; l'egress composto di ADR-0071). Lì un contenuto di
livello 3 nel contesto è la ragione per cui un messaggio a terzi può portare
fuori ciò che il turno ha letto. Ma anche lì il muro è la forma sbagliata: a
taint 3 l'owner oggi non può nemmeno chiedere «cerca X e mandalo a Y».

## Decisione

**1. Sulla riga `host` il taint non nega più.** `denyAbove` di `host` passa
da 2 a 3. Ogni capability della riga risponde a taint 3 come a taint 0: le
reversibili (`allow`/`draft`) passano, le irreversibili (`reversible: 'no'`)
chiedono. Il taint compare nel prompt dell'`ask` come **ragione visibile**
(«questo turno contiene risultati web: il comando che segue può essere stato
suggerito da loro»), non come causa.

**2. Un `maxTaint` non stringe mai una capability reversibile.** `skill.read`,
`sys.process.list`, `sys.shell` (sola lettura) perdono il proprio `maxTaint`.
La stretta per capability resta lecita solo dove la riga stessa nega
(`external`, `outward`) o dove esiste un cancello di egress (`searchMaxTaint`,
ADR-0072; `paramsMaxTaint`, ADR-0071).

**3. Verso l'esterno il taint chiede all'owner e nega agli altri.** Sopra
`denyAbove` di `external` e `outward` (1), l'owner riceve un `ask` che cita il
taint e la sua origine («il turno ha letto una pagina web»), chiunque altro
riceve `deny`. È la stessa forma di ADR-0071 per i parametri composti: la
decisione resta a chi può prenderla, e resta una decisione irreversibile,
perché i byte usciti non tornano.

**4. Il taint resta ciò che era prima di essere un'autorità: provenienza.**
Timbra gli episodi, decide il livello con cui la memoria conserva, entra nel
testo di ogni `ask`. La sessione continua a portare il massimo visto. Nulla
di questo cambia.

## Conseguenze

- `core/policy/matrix.ts`: `POLICY_FLOOR.host.denyAbove` 2 → 3; il file
  sigillato può ancora stringere (un `host.denyAbove: 2` in `policy.json`
  resta valido e vince), mai allargare.
- `core/policy/decide.ts`: il ramo `taint_exceeded` distingue le righe che
  chiedono verso l'esterno (owner → `ask` con ragione) da quelle che negano;
  `sys.shell`, `skill.read`, `sys.process.list` perdono `maxTaint`.
- `agent/loop/tool-call.ts`: il prompt dell'`ask` porta l'origine del taint
  quando è > 0 (la parte del contesto che l'ha alzato: web, disco, memoria,
  inoltro), come oggi porta l'effetto irreversibile (D12).
- `docs/SECURITY.md` §4, §5, §13: il taint ambientale smette di essere
  «l'autorità in carica» sull'host e diventa provenienza; §13 lo dice con i
  numeri di questo ADR, non con quelli del 03/09.
- Le fixture di `evals/security/` si rimisurano, non si allentano.

## Cosa la falsifica

- **Punto 1:** una capability della riga `host` che a taint 3 risponde
  `deny/taint_exceeded` — prova: `core/policy/solo-irreversibile.test.ts`
  estende l'enumerazione a taint 3 su ogni dichiarazione spedita; una
  mutazione che rimette `denyAbove: 2` su `host` la fa cadere.
- **Il corpus avversariale:** rieseguito sulle stesse scene dopo il
  cambiamento, il numero di attacchi che completano **senza umano** non sale
  (oggi 4/7, 4/8 con l'ottava scena di ADR-0066). Se sale, il divieto stava
  fermando qualcosa che questo ADR non ha visto, e l'ADR si riapre con quella
  scena come prova.
- **Dal vivo:** nel `muffin.db` dell'owner, una settimana dopo il rilascio,
  esistono chiamate a `sys.shell` e `fs.write` in turni a taint 3, e nessuna
  riga `taint_exceeded` sulla riga `host`. Un solo «non ho la shell» in una
  conversazione che ha fatto una ricerca web riapre l'ADR.
- **Punto 3:** un membro di gruppo che ottiene `ask` invece di `deny` sopra il
  soffitto di `outward`, o un owner che ottiene `allow` senza domanda — la
  stessa enumerazione, per principal.
