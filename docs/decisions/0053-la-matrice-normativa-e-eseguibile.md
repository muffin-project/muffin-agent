# ADR-0053 — La matrice normativa è eseguibile: il soffitto viene dalla riga di effetto

**Stato:** accettato · 2026-09-02 · decisione owner dopo la memo
`docs/evidence/decision-memo-taint-2026-09-02.md`

## Contesto

`docs/history/rebuild-2026/03-threat-model.md` §3 stampa una matrice dichiarata
**normativa**. Le sue righe sono classi di effetto — dove finiscono i byte — e
le sue colonne sono il taint del turno:

| riga | owner@host, taint ≤1 | qualunque, taint 2 | qualunque, taint 3 |
|---|---|---|---|
| Shell / filesystem host / processi | ALLOW per classe (HITL) | **ASK** | DENY |
| Reply sul canale di origine | ALLOW | ALLOW | ALLOW |
| Egress rete | allowlist; ASK fuori | read-only su allowlist, niente dati nei parametri | idem |
| Outward (mail, terzi, pubblicazione) | DRAFT | DENY | DENY |

Il kernel non eseguiva quella tabella. Decideva da due cose diverse: la classe
di rischio (`low`/`medium`/`high`) e un numero appuntato a mano su ogni
dichiarazione:

```ts
const ceiling = decl.maxTaint ?? ctx.matrix.defaultMaxTaint[decl.risk];
```

Le due cose sono divergiute in silenzio, e la deriva ha una data. Il 16/08
l'emendamento owner di ADR-0044 ha spostato la cella «taint 2» della riga
*Shell / filesystem host / processi* da DENY ad ASK — **per una capability
sola**, `sys.shell`, scrivendole addosso `maxTaint: 2`. `fs.write` e
`sys.process.kill` stanno sulla stessa riga della stessa tabella e hanno
continuato a ereditare il default di classe 1, quindi hanno continuato a
rispondere `deny` dove il documento dice `ask`.

Il costo, misurato il 02/09 sul binario vero
(`evals/acceptance/scenarios/b-parita-superfici.accept.ts`):

- `leggi dati.txt` → `scrivi esito.txt` è `taint_exceeded` su CLI, REPL e
  Telegram, e anche **dentro un turno solo**, su una sessione appena aperta e
  senza un byte di history: il taint sale alla lettura (`DISK_TIER` = 2) e il
  soffitto di chi scrive era 1;
- sull'installazione reale dell'owner, in 165 turni: zero `fs_write`, zero
  `surface.send_file`. La porta usata per scrivere era la shell.

Il difetto non è il numero. È che **due porte allo stesso sink avevano due
regole opposte, e quella chiusa era la più sicura**: `fs.write` è confinata
dallo scope, ha il checkpoint e ha `muffin undo`; la shell scrive sullo stesso
disco senza pre-immagine. La memo del 02/09 misura anche la forma opposta:
`surface.send_file` consegna nella chat già in corso (`ctx.replyChannel`, mai
un destinatario nuovo) ed era `deny` a taint 2, mentre il testo della risposta —
che la sua stessa dichiarazione chiama «same trust class» — esce da
`SurfaceRegistry.deliver` senza passare dal kernel.

## Decisione

**Il soffitto viene dalla riga di effetto, non dalla classe di rischio.**

1. `CapabilityDecl` dichiara `effect: EffectRow` — obbligatorio, non opzionale
   con un default. Una capability che non dice dove finiscono i suoi byte non
   compila. È la stessa forma che ADR-0044 ha scelto per `ToolOutcome.tier`, e
   per la stessa ragione: *un campo obbligatorio non rende il sistema più sicuro
   di un default fail-closed, rende impossibile non essersi accorti*.
2. `PolicyMatrix.rows` porta le colonne della matrice come due soglie per riga:
   `askAbove` (sopra cui nulla su questa riga può restare non presidiato) e
   `denyAbove` (sopra cui la riga è irraggiungibile). `ROW_FLOOR` in
   `core/policy/matrix.ts` è la trascrizione della tabella stampata, riga per
   riga, con la citazione accanto.
3. `decide.ts` calcola `ceiling = min(row.denyAbove, decl.maxTaint ?? 3)` e,
   dopo lo switch sul rischio, alza a `ask` qualunque `allow`/`draft` sopra
   `askAbove`. Le due soglie insieme sono la cella: «raggiungibile» e «mai in
   silenzio» sono affermazioni diverse, e un soffitto da solo può esprimere
   soltanto la prima — senza la seconda un `draft`, che esegue senza chiedere,
   soddisfa il soffitto e contraddice la tabella.
4. `maxTaint` sulla dichiarazione sopravvive come **sola stretta**. Era il knob
   che ha prodotto la deriva; ora un valore più largo della riga è inerte, e
   `core/policy/effect-rows.test.ts` lo rifiuta a voce alta invece di lasciarlo
   leggere come una decisione presa da qualcuno.
5. Il file sigillato può stringere una riga e mai allargarla, esattamente come
   già faceva con `defaultMaxTaint` (`tighterRows`). Una riga che il codice non
   conosce viene ignorata: un file sigillato non si inventa un vocabolario che
   il kernel non ha rivisto.

Le righe, e la loro fonte:

| riga | cosa ci sta | soglie | fonte |
|---|---|---|---|
| `context` | letture: fs, memoria, skill, documenti, process list, inspect, todo, wait | 3 · 3 | «leggere non è agire», ADR-0044 |
| `host` | `fs.write`, `sys.shell`, `sys.process.kill` | 1 · 2 | riga *Shell / filesystem host / processi* |
| `reply` | `surface.send_file` | 3 · 3 | riga *Reply sul canale di origine* |
| `egress` | `sys.http`, `sys.search` | 3 · 3 | riga *Egress rete*: le colonne sono dell'allowlist e di `paramsMaxTaint` |
| `memory` | scrittura di memoria (ancora senza capability, vedi sotto) | 3 · 3 | riga *Scrittura memoria* |
| `external` | `mcp.<server>` | 1 · 1 | non stampata: MCP sta in prosa (`SECURITY.md` §10). Tiene il numero di oggi |
| `outward` | nessuna capability oggi | 0 · 1 | riga *Outward* |
| `config` | nessuna capability oggi | 0 · 1 | riga *Scrittura config/voice* |
| `rot` | nessuna: `neverAtRuntime` rifiuta prima | 0 · mai | riga *Root of Trust* |

### Le tre celle che cambiano, per nome

Ogni altra capability risponde esattamente come prima, e il test lo verifica
cella per cella.

| capability | prima, a taint 2 | ora | perché |
|---|---|---|---|
| `fs.write` | `deny` | `ask` | la sua riga dice ASK; era l'unica porta al disco con il journal, ed era l'unica chiusa |
| `sys.process.kill` | `deny` | `ask` | stessa riga, stessa cella, stessa trascrizione mancata |
| `surface.send_file` | `deny` | `allow` | consegna sul canale di origine, non a un destinatario nuovo: riga *Reply*, ALLOW a ogni colonna |

`surface.send_file` a taint 3 diventa raggiungibile, ed è la conseguenza da
dichiarare: una pagina avvelenata può far arrivare all'owner un allegato che non
ha chiesto. Va nella stessa chat dove il testo della risposta — che può già
ricopiare il contenuto di quel file — arriva senza nessun gate. Il rischio è la
visibilità di un file all'owner, non un'esfiltrazione: la riga *Outward*, quella
dei destinatari nuovi, resta DENY a taint 2 e 3.

## Alternative scartate

**Spostare `maxTaint` di `fs.write` da 1 a 2.** Ripara la giornata e conferma la
forma che ha causato il guasto: sarebbe la terza eccezione scritta a mano nello
stesso posto, dopo quella della shell. `runtime-foundations-challenge-2026-08-29.md`
lo aveva già nominato — *"pressure to widen ceilings creates a cycle of
exceptions"*. Un knob per capability non è una policy, è il posto dove la policy
smette di essere verificabile.

**Abbassare il tier della lettura.** ADR-0044 lo ha già scartato con una misura:
il filesystem non ha provenienza, e a taint 1 un host fuori allowlist tornerebbe
`ask`. La catena si chiude a 2 e da nessuna parte sotto.

**Aspettare l'eval comparativo prima di toccare qualunque cosa.** È la scelta
che la memo del 02/09 raccomandava, e sbagliava di bersaglio: l'eval decide se
il *taint ambientale* sia il segnale giusto — cioè le colonne. Questa ADR non
tocca le colonne, esegue le righe, e la riga sopravvive a qualunque risposta
l'eval dia, perché dove finiscono i byte conta in ogni architettura. Congelare
un prodotto rotto per un esperimento su un'altra domanda non è prudenza.

**Mettere le righe nel file sigillato invece che nella dichiarazione.** Le due
non sono lo stesso dominio di fiducia (`matrix.ts`): una dichiarazione è un
commit rivisto, il file è una scrittura più un `reseal`. La riga *di una
capability* è una proprietà della capability e va rivista con essa; le *soglie*
di una riga sono policy e stanno nel file, dove possono solo stringere.

## Conseguenze

- `defaultMaxTaint` non è più il soffitto. Resta nel tipo e nel file sigillato,
  continua a essere letto, unito e mostrato da `doctor`, e non decide più nulla.
  **Il residuo, dichiarato:** un owner che avesse *stretto* una classe in un
  `policy.json` risigillato perde quella stretta senza che nessuno glielo dica.
  Sull'unica installazione esistente il file è quello di serie, quindi non si
  perde niente; una stretta futura si scrive come riga, che è il vocabolario
  rivisto. Toglierlo del tutto è un lavoro a parte: settantadue riferimenti fra
  `doctor`, l'inventario e i test.
- Nessun `reseal` è necessario: un file `schemaVersion: 1` senza `rows` eredita
  il pavimento, quindi `muffin update` basta.
- **Due strade restano fuori dal kernel** e la tabella lo rende visibile: il
  testo della risposta e la scrittura di un episodio di memoria non hanno una
  capability, quindi le righe `reply` e `memory` sono in parte vuote. Portarle
  dentro è la slice successiva; qui cambierebbe cosa è osservabile, non cosa è
  permesso, e mescolarla a questa nasconderebbe le tre celle sopra.
- La domanda aperta di `docs/SECURITY.md` §13 resta aperta e non è indebolita:
  se l'eval mostra che il taint ambientale non paga la sua complessità, le
  colonne cambiano e queste righe restano.

## Come si falsifica

`core/policy/effect-rows.test.ts` asserisce ogni cella di ogni dichiarazione
spedita contro la tabella stampata. Va rosso se qualcuno sposta una riga nel
documento senza spostarla nel codice, se una dichiarazione appunta un `maxTaint`
che contraddice la sua riga, o se una capability nuova arriva senza riga.
`evals/acceptance/scenarios/b-parita-superfici.accept.ts` tiene la misura sul
binario: il giro `leggi → scrivi` deve restare identico su tutte le superfici.

Il segnale che questa decisione è sbagliata sarebbe un ASK che l'owner impara a
schiacciare senza leggerlo. La riga `host` a taint 2 è un ASK per costruzione,
ed è esattamente il fallimento che ADR-0044 §revisione nominava per la shell: se
diventa un riflesso, la riparazione non è tornare al `deny`, è che la richiesta
mostri cosa sta approvando — il gap che quella revisione ha già dichiarato.
