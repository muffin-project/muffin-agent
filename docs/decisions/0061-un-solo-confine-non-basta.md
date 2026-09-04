# ADR-0061 — Un solo confine non basta: la redazione vale su ogni sink, o su nessuno

**Stato:** proposto · 2026-09-04 · esegue la raccomandazione di
`docs/evidence/i-sink-scoperti-2026-09-04.md` §6

> **Proposto, non accettato.** Nessuna riga di codice cambia con questo
> documento. È il posto che `docs/evidence/README.md` indica per la metà
> *in avanti* di una ricerca — *«whatever stays live in a proposal has a current
> owner — an ADR»* — e diventa `accettato` solo con una decisione dell'owner,
> nello stesso commit che implementa. Se l'owner decide di no, questo file
> diventa lineage in `docs/history/design-notes/` e la ricerca resta come
> evidence.

## Contesto

Il punto 4 del percorso critico ha misurato dove le guardie non ci sono
(`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md`): quattro attacchi
su sette riescono senza nessun umano, e tre scene — `s3`, `s6`, `s7` — non
incontrano nessuna guardia. Il punto **4-bis** chiedeva, per ciascuna, se esista
un fatto che il codice possa decidere da solo, senza il modello e senza l'owner.

La ricerca del 04/09 ne ha trovato uno, e non ha dovuto inventarlo.

ADR-0048 ha stabilito che un valore che *assomiglia* a una credenziale va
redatto — classe 3, difesa in profondità, mai spacciata per garanzia. Ha scritto
il riconoscitore (`core/tracing/redact.ts`), l'ha misurato contro un corpus di
falsi positivi plausibili, e l'ha applicato in **un solo punto**, dichiarandolo
per iscritto:

> **Un solo punto di applicazione**: `agent/loop.ts`, dentro `runTool()`, sia sul
> ramo di successo sia sul catch, prima che `outcome.content`/`detail` tocchino
> una qualunque delle tre strutture che sopravvivono al turno.

Quella frase era giusta per il problema che ADR-0048 stava risolvendo — i
risultati dei tool — e la sua dimostrazione di sufficienza è corretta e
riverificata. Il difetto è che `docs/SECURITY.md` §8 elenca **sette** confini che
un valore segreto non deve attraversare, e il codice ne copre due.

Misurato il 04/09 su `dev` `09ac978`, con sonde sul binario vero:

- una `sk-ant-…`, una `ghp_…`, un token Telegram, un `"token": "…"` e una chiave
  PEM in un file letto da `fs_read` **non arrivano nemmeno al modello**: la
  chiamata a `redactText` (`agent/loop.ts:3428`) tiene, cinque forme su cinque;
- la stessa chiave **digitata dall'owner** arriva al modello intatta e finisce in
  `episodes.content` (`agent/loop.ts:1638`) e nella sessione JSONL
  (`agent/loop.ts:1761`);
- la stessa chiave **nel testo del modello** esce dalla risposta ed entra in
  `episodes.content` (`agent/loop.ts:2186`);
- la stessa chiave in `persona.md` arriva al modello dentro il system prompt
  (`cli/prompt-show.ts:60` redige solo per *mostrare* il prompt, non per
  costruirlo);
- il prompt d'approvazione è costruito verbatim da `core/policy/decide.ts:314` e
  scritto verbatim da `core/approvals/store.ts:125`.

E il residuo che ADR-0048 si era scritto —

> **Segreti incollati a mano dall'owner in chat.** Classe 3: il detector li
> intercetta se assomigliano a una forma nota, non li garantisce.

— su HEAD non regge: il detector non li intercetta, perché su quel confine non
viene chiamato. La frase prometteva una copertura che il cablaggio non dà. È il
pattern che `AGENTS.md` nomina per primo — *un meccanismo che esiste non prova
che la produzione lo raggiunga* — applicato a se stesso, in un ADR che quel
pattern lo citava.

## Decisione

**La redazione di classe 3 si applica a ogni confine di scrittura che sopravvive
al turno o esce dal processo, non a uno.**

Concretamente, `redactText` viene chiamato — oltre che dove già lo è — su:

| confine | `file:riga` | che cosa attraversa |
|---|---|---|
| il testo della risposta | `agent/loop.ts:2730` (`finish`) | le sei strade di consegna |
| l'episodio dell'owner | `agent/loop.ts:1638` | `episodes.content` |
| l'episodio dell'agente | `agent/loop.ts:2186` | `episodes.content` |
| la sessione, lato owner | `agent/loop.ts:1761` | la sessione JSONL |
| la sessione, lato agente | `agent/loop.ts:2163` | la sessione JSONL |
| il prompt d'approvazione | `core/approvals/store.ts:125` | `approvals.prompt`, lo schermo |

`finish()` è scelto come punto per la risposta con **la stessa argomentazione di
sufficienza** che ADR-0048 fa per la 3428, non per analogia: è l'unico produttore
di `TurnResult.text` (11 chiamate, misurate), e tutti e sei i consumatori —
`cli/run.ts:104`, `agent/turn-lane.ts:165`, `core/scheduler/scheduler.ts:498`,
`core/scheduler/commitments.ts:462`, `cli/observe.ts:69` e `:245`,
`cli/gateway.ts:668` — leggono quel campo senza trasformarlo. Redigere una volta
a monte li copre tutti; redigere ai sei siti sarebbe la stessa regola scritta sei
volte, che è la forma che questo repository ha già pagato.

### Perché non è «una conferma in più»

Non lo è, ed è il vincolo che il punto 4-bis pone per primo. Questa decisione non
aggiunge **nessuna** domanda all'owner, non cambia nessun verdetto del kernel,
non muove nessuna riga di `ROW_FLOOR` e non tocca `surface.reply` né
`memory.write`. Le due porte restano `ALLOW` a ogni taint, per la decisione che
ADR-0055 ha registrato. Cambia solo che cosa passa attraverso.

Il numero che lo giustifica è misurato sui dati veri dell'owner, non congetturato:
`redactText` eseguito su **458 episodi, 170.056 caratteri, 221 turni e 79
approvazioni** dell'installazione reale tocca **zero righe**. Il costo di utility
osservabile oggi è nullo.

### Che cosa questa decisione NON afferma

Detto qui e non in fondo, perché il modo in cui ADR-0048 si è rotto è che una
frase di copertura è stata letta più larga di com'era.

- **Non è una difesa contro l'iniezione.** Un'istruzione piantata non ha una
  forma riconoscibile a vista, e §5.2 della ricerca dichiara che un floor
  deterministico per l'*obbedienza* del modello non è stato trovato e
  probabilmente non esiste senza cambiare la forma dell'agente.
- **Non chiude `s3`.** Il riflesso d'approvazione — 67 sì su 76 nella cella
  `sys.shell` a taint 2, con un terzo dei sì sotto i 5 secondi e nessun no sopra
  di essi — non è un esito che il codice possa rendere impossibile: l'esito *è*
  l'owner che decide.
- **Non promuove la classe 3 a garanzia.** Una credenziale in una forma non
  elencata passa, esattamente come oggi. La garanzia strutturale resta
  `muffin secret set` più `secret://nome`, ed è un'altra cosa (`docs/SECURITY.md`
  §8, ADR-0048 §2).
- **Non ferma un'esfiltrazione deliberata, e la ragione è nota.** Un modello che
  obbedisce a un'iniezione può riscrivere la chiave in Base64: **il pattern non
  sopravvive alla codifica, la provenienza sì.** È la critica che la letteratura
  muove a ogni filtro deterministico sull'output — APPA (arXiv:2607.24625):
  *«Content guardrails and boundary sanitizers offer valuable defense-in-depth,
  but remain vulnerable to semantic paraphrasing and cannot substitute for
  structural source–sink enforcement.»* Questa ADR chiude l'eco **accidentale**
  di una credenziale, che è il caso misurato dalle sonde; non l'esfiltrazione
  deliberata, che è un problema di flusso d'informazione.
- **Non tocca le righe già scritte.** `~/.muffin` reale non viene bonificato; la
  proposta `muffin secret scrub` di ADR-0048 §Residui resta non implementata e
  resta una decisione dell'owner sui propri dati.

## Alternative considerate

**La riga `reply` impara la destinazione.** Passare la destinazione nella
`DecisionRequest` di `surface.reply` — oggi `{ kind: 'none' }` a
`agent/loop.ts:1849` — così che il kernel possa distinguere il canale d'origine
da un terzo. Scartata **ora**, non in generale: la ricerca misura che la fuga
cross-tenant che la giustificherebbe non esiste su HEAD, perché `identify()`
(`core/surface/types.ts:287`) fa dell'owner-in-un-gruppo un `member` di quel
tenant e ogni capability che tocca il disco o la shell è `hostOnly: true`. Si
comprerebbe espressività per una politica che non c'è, contro una minaccia non
misurata. **La condizione che la riapre è sorvegliabile**: una capability
`hostOnly: false` che porti byte dell'host dentro un turno di gruppo.

Vale la pena registrare che quella forma **non sarebbe un'invenzione**, e che
rinviarla non è essere indietro. FIDES (Microsoft Research, arXiv:2505.23643) §8
dichiara di avere l'etichetta sul canale di risposta e di non usarla come gate —
*«Since we only enforce policies upon tool calls, our planners do not stop these
text-to-text attacks. Our planners could be extended to enforce policies on user
responses»* — che è alla lettera lo stato di `agent/loop.ts:1849`. In CaMeL
(Google DeepMind, arXiv:2503.18813) il canale conversazionale è la funzione
`print` e **non ha nessuna policy**, e la loro valutazione su AgentDojo perde
proprio lì. Il solo lavoro che nomini il canale di risposta come autorità
distinta è un preprint del 2026 (APPA, arXiv:2607.24625: *«Direct user response
channels are modeled as recipient-checked sinks»*). Il giorno in cui la
condizione sopra si verifica, esiste una formulazione da citare.

**Un gate su `reply` o su `memory.write`.** È «una conferma in più», ed è escluso
dal vincolo sopra e dalla misura del riflesso.

**Candidate B.** Già misurata e bocciata dal punto 4: batte A su 0/7 azioni
contese. Non si riapre senza evidenza nuova.

## Conseguenze

- Il *residuo* di ADR-0048 sui segreti incollati dall'owner si restringe: da «non
  intercettati» a «intercettati se hanno una forma nota», che è ciò che quella
  ADR credeva già di dire.
- Un `«redacted:N»` in una risposta è ora un esito possibile. È il rischio
  proprio di questa decisione: mutilerebbe testo legittimo senza che nessuno se
  ne accorga. Mitigato dalla misura a zero, e la mitigazione **è falsificabile** —
  una sola riga di conversazione vera che venga mutilata basta a togliere il
  pattern che l'ha causata, non il floor (ADR-0048: *«i pattern sono dati, non
  contratto»*).
- Il costo in codice è una chiamata a una funzione pura per confine. Nessuna
  migrazione di schema, nessuna riga di database cambia forma, revert pulito.

## Reversibilità

**Alta**, per le stesse ragioni di ADR-0048 §Reversibilità: sei chiamate in più a
una funzione pura già esistente, su valori già di passaggio.

## Come si prova che il cablaggio c'è

La regola di casa dice che l'evidenza deve **cadere** quando il cablaggio viene
tolto. Per ognuno dei sei confini: una sonda che pianta una forma nota di
credenziale e osserva il sink reale — la riga di `episodes`, il file di sessione,
`approvals.prompt`, lo stdout del binario — e che **fallisce se la chiamata viene
rimossa**, verificato per mutazione, come `agent/secret-redaction.test.ts` ha già
fatto per la 3428. Una sonda che passa anche senza la chiamata non prova questa
ADR: prova che la forma non c'era.
