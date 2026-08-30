# Quando l'owner chiede qualcosa che non si fa adesso

**30/08/2026 · evidenza, non decisione.** Misurato sul `muffin.db` vero
(snapshot con `.backup`, mai `cp`) e sul sorgente a
`a2d3572`. Nessuna claim aperta: il tema tocca work/todo, memoria, esposizione
dei tool e person model — cioè primitive che stanno per essere riconciliate.
Questo file esiste perché le misure non vadano perse, non per proporre una
forma.

L'osservazione che l'ha aperto è dell'owner: *«se dico di scrivermi tra cinque
minuti»*, e prima ancora *«se gli scrivo su Discord di dirmi una parola quando
gli scrivo su Telegram, e subito dopo scrivo su Telegram, non ha idea di questa
cosa»*.

## I tre portatori che esistono

| meccanismo | dove vive | portata | chiamate mai fatte |
|---|---|---|---|
| `wait` | riga sul turno, onorata fra due iterazioni | **dentro** il turno | **1** |
| `todo` | tabella `todos`, chiave `(tenant, session_id, key)` | **una sessione** | **2** |
| `jobs` | cron in `jobs`, gateway | globale, nel tempo | **0 dal modello** |

Per confronto, nello stesso corpus: `fs_list` 36, `memory_search` 33,
`shell_run` 32, `fs_read` 31, `sys_inspect` 21.

## Cinque misure

**1. `jobs` non ha un tool. Per nessuno, a nessun taint.** `agent/tools/`
contiene `wait.ts` e `todo.ts` e **non** un `jobs.ts`: i job si creano solo da
`muffin jobs add` (`cli/main.ts:166`). Quindi «scrivimi tra cinque minuti» non
ha un portatore raggiungibile da Telegram — non perché una policy lo neghi, ma
perché la porta non è stata costruita. Un meccanismo con una porta
sola: quella della CLI.

**2. E il modello, interrogato, ha spiegato l'assenza come una policy.**
Episodio 310, Telegram: «*il sistema job esiste, adesso a zero job. Ma da
Telegram, a taint 2, il tool per crearli non me lo espongono: è la policy, non
un bug*». Falso e verosimile insieme, che è la combinazione peggiore: non c'è
nessuna regola di taint su un tool che non esiste. Il difetto non è solo la
porta mancante, è che il sistema non sa dire di non averla.

**3. Il tetto dei tool non è più il problema — verificato, non ricordato.**
`0d519cb` (28/08) ha portato `consumer-local` da 10 a 15, ed è dentro il binario
installato (`3ae9595`). `muffin doctor` oggi non stampa nessuna riga
«invisibili al modello». Il reperto precedente — «`wait, todo, sys_inspect`
tagliati dal tetto» — è **morto**: `sys_inspect` ha 21 chiamate, `wait` e `todo`
sono esposti. Se una forma futura parte da lì, parte da ieri.

**4. I sette todo sono fermi da tre giorni, e nessuno può vederli.** Tutti e
sette vengono da una sola sessione (`2026-08-27-ae654a8e`, 23:16:11), tutti
`pending`, nessuno mai passato a `done` — compresi quelli che quella sessione
ha evidentemente eseguito. La chiave primaria è
`(tenant, session_id, key)`: da qualunque altra sessione quella lista non
esiste. Un portatore che muore con la sessione non porta niente oltre la
sessione.

**5. Metà del person model sono richieste morte.** 44 fatti attivi su 83 hanno
predicato `asked_to`/`asks_to`, cioè **il 53%** di ciò che Muffin crede
stabilmente sull'owner. Fra questi: `dimmi solo: uno`, `dimmi solo: due`,
`dimmi solo: tre`, `dimmi solo: delta`, `rispondere solo con PONG`. Sono
istruzioni di un istante scritte come credenze permanenti.

E nello stesso mucchio indistinto stanno le uniche due che erano davvero
pendenti:

- **#79** `asks_to: write 'ciao' in one minute`
- **#84** `asked_to: ripetere la parola ANANAS dopo averla ricevuta su Telegram`

## Perché ANANAS non poteva funzionare

L'estrazione ha fatto il suo lavoro: il fatto **84 esiste ed è corretto**. Il
guasto è a valle. Un fatto è raggiungibile solo da un recall guidato dalla
domanda, e l'istruzione non somiglia al messaggio che dovrebbe attivarla.
Misurato sul corpus vero dell'owner, con la metà semantica accesa:

| interrogazione | posizione di #84 |
|---|---|
| «Mi devi dire qualcosa?» | **fuori dai primi 8** |
| «Hey Muffin!» | **fuori dai primi 8** |
| «che parola dovevi dirmi» | 14 |
| «ananas» | 1 |

Cioè: si trova solo dicendo la parola che doveva essere detta. Riparare Ollama
non cambia niente — non è un guasto dell'embedder, è che *nessuna somiglianza
può recuperare un'istruzione che il messaggio successivo non menziona*.

Lo stesso vale per l'episodio 307, «*puoi scrivermi ciao tra un minuto?*»: la
risposta è arrivata 2m09s dopo, ma come **ripresa dello stesso turno** via
`wait` — non come un messaggio proattivo. Ha funzionato perché il turno non era
finito. Se l'owner avesse chiuso la conversazione, non sarebbe arrivato niente:
`proactive_fires` ha **0 righe** in tutto il corpus, e l'unico job mai creato
(`922ac8b7`, da CLI il 25/08) è scattato una volta sola e da allora è
`active = 0` con `next_fire_at` fermo al 26/08.

## La forma del problema, senza sceglierne la soluzione

Le tre domande che una futura architettura deve poter distinguere, e che oggi
finiscono tutte nello stesso `asked_to`:

1. **differita nel tempo** — «tra cinque minuti», «domani mattina». Vuole un
   appuntamento e una consegna proattiva.
2. **differita su condizione** — «quando ti scrivo su Telegram», «quando quel
   file cambia». Vuole un *trigger*, e in particolare un trigger che
   attraversa le superfici: la condizione nasce su Discord e si avvera su
   Telegram.
3. **permanente** — «non riguardare tutto ogni volta» (#76). Vuole entrare nel
   prompt, non nel recall.

Nessuna delle tre si serve con la similarità: tutte e tre hanno bisogno di
qualcosa che **guardi le richieste aperte a ogni turno** invece di aspettare
che la domanda le assomigli. Il precedente più vicino è già in casa:
`todoSection` mette i todo nel prompt di *ogni* turno senza che nessuno li
cerchi. Quello che manca non è un meccanismo nuovo, è la portata — sessione,
superficie, tempo.

**Cosa falsificherebbe una soluzione**, da definire prima di scriverla: che
l'owner scriva su una superficie una condizione che si avvera su un'altra, e
che il turno sulla seconda la porti senza che il messaggio la nomini.
