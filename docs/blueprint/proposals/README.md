# Proposte — dove atterra la ricerca settimanale

Una proposta è un **artefatto versionato che non è ancora una decisione**. Quando
una viene accettata diventa un ADR in `../adr/` e questo file resta come il suo
segnale d'origine; quando viene rifiutata **resta qui**, perché il rifiuto con il
suo motivo è la rete di sicurezza contro il ri-proporre la stessa cosa fra sei
mesi (stessa logica del cimitero in `../knowledge/README.md`).

Forma di ogni proposta — `<YYYY-MM-DD>-<slug>.md`:

> contesto e segnale d'origine · la mossa esatta (file e funzioni toccati) ·
> **pro e contro** · **come si testa davvero** (l'eval concreta, e cosa la
> farebbe fallire) · reversibilità · **cosa non si è potuto stabilire**

## La routine settimanale che riempie questa cartella

Un agente cloud, ogni lunedì mattina, legge letteratura primaria (agenti e
memoria, neuroscienze e scienze cognitive, retrieval, sicurezza degli agenti),
giudica cosa vale, e **descrive** ciò che vale come una mossa tecnica concreta.

**Il ciclo, e il punto in cui si ferma** (direttiva owner):

```
ricerca → PROPOSTA (solo documento) → l'owner dice cosa ne pensa
        → si itera → si decide se scriverlo → solo allora, codice
```

L'agente **non scrive codice**. La PR settimanale contiene **solo** il documento
di proposta: nessuna modifica a `core/`, `agent/`, `cli/`, nessun test, nessuna
implementazione "di esempio". Il motivo non è diffidenza, è che una proposta che
arriva già implementata sposta la discussione dal *se* al *come*, e il *se* è la
decisione dell'owner. Il codice si scrive dopo il via, e in un'altra sede.

Tre vincoli la tengono onesta, e sono gli stessi che valgono per gli umani qui:

1. **Etichetta di evidenza su ogni claim** — `misurato/ablato` ·
   `riportato-senza-ablation` · `folklore`. Un numero non misurato va nominato
   come non misurato: questo repo ha già pagato l'adozione di costanti-folklore.
2. **Principio → primitiva.** Una cosa che vale diventa una proprietà di una
   primitiva che esiste già (una colonna, un termine di ranking, un gate), mai un
   modulo cognitivo bullonato a lato (`../knowledge/README.md`).
3. **Niente firehose.** Se in una settimana non c'è niente che valga, la PR dice
   *cosa ha guardato e perché non valeva*, e non propone nulla. Una proposta
   debole a settimana è peggio di nessuna proposta — è ADR-0028 applicato
   all'agente che ci lavora sopra.

E il vincolo che la separa dal cricchetto: **non tocca gli eval né le soglie con
cui muffin è giudicato** (`../05-testing-evals.md` §5). Può *proporre* eval
nuove dentro il documento; non può cambiare il metro.

### Stato: configurata, non attiva

Il tentativo di crearla ha restituito **403 — "You don't have access to a
repository this routine uses"**: `muffin-agent` è privato e l'ambiente cloud non
ha accesso. Non è una scelta di design, è un permesso mancante.

**Per attivarla**: dare all'ambiente Claude Code cloud l'accesso al repo privato
(claude.ai → impostazioni del codice/repository), poi ricreare la routine —
cron `0 7 * * 1`, modello `claude-opus-5`, tool `Bash Read Write Edit Glob Grep
WebSearch WebFetch`. Le routine si gestiscono da https://claude.ai/code/routines.

**Nota fuso**: il cron è in UTC. `0 7 * * 1` sono le 9:00 di Roma d'estate
(CEST) e le **8:00 d'inverno** (CET) — il cron non segue l'ora legale. Se il
lunedì mattina presto dà fastidio a novembre, va spostato a `0 8 * * 1` allora.

**Nota strumenti**: nell'ambiente cloud non risultano connettori MCP, quindi
Context7 non c'è e la pratica §1 ("doc via MCP prima delle API") degrada a
lettura della documentazione ufficiale via WebFetch. È un degrado dichiarato,
non silenzioso.

### Il prompt esatto (da incollare quando si crea la routine)

> Sei l'agente di ricerca settimanale di **muffin** (repo: muffin-agent). Parti
> senza contesto: orientati leggendo, in quest'ordine, `CLAUDE.md` (il router),
> `docs/blueprint/STATE.md` (il blocco START HERE),
> `docs/blueprint/knowledge/README.md` (la regola che governa questo lavoro),
> `docs/PRACTICES.md` e `AGENTS.md`.
>
> **Cosa produci: UNA proposta, in UNA PR, fatta SOLO di documento.**
> **Non scrivi codice.** Niente modifiche a `core/`, `agent/`, `cli/`, niente
> test, niente implementazione d'esempio. Il ciclo è: tu proponi → l'owner dice
> cosa ne pensa → si itera → si decide se scriverlo. Una proposta che arriva già
> implementata sposta la discussione dal *se* al *come*, e il *se* non è tuo.
>
> **1. Cerca in letteratura** lavoro recente rilevante: agenti e memoria,
> neuroscienze e scienze cognitive di memoria/attenzione/oblio, retrieval e
> fusione, sicurezza degli agenti. Fonti **primarie**: se un blog riassume un
> paper, apri il paper.
>
> **2. Giudica cosa vale.** Etichetta OGNI claim: `misurato/ablato` ·
> `riportato-senza-ablation` · `folklore`. Questo repo è stato bruciato da
> costanti-folklore adottate perché suonavano bene — un numero non misurato va
> nominato come non misurato. Se il paper non ha un'ablation sul pezzo che ci
> interesserebbe, scrivilo in chiaro: è l'informazione più utile che puoi dare.
>
> **3. Traduci in una mossa tecnica concreta**, scegliendo la forma onestamente:
> una riga di prompt/nudge · una **proprietà di una primitiva che già esiste**
> (una colonna, un termine di ranking, un gate, una soglia) · il refactor di un
> modulo. **Regola di casa non negoziabile** (`knowledge/README.md`): un
> principio si incarna in una primitiva esistente, MAI in un modulo cognitivo
> bullonato a lato. "Syscall layer, non 52 tool."
>
> **4. Scrivi la proposta** in `docs/blueprint/proposals/<YYYY-MM-DD>-<slug>.md`:
> contesto e segnale d'origine · la mossa esatta (i file e le funzioni che
> toccherebbe — descritti, non modificati) · **pro e contro** · **come si testa
> davvero** (l'eval o il test concreto, e cosa lo farebbe fallire) ·
> reversibilità · **cosa NON sei riuscito a stabilire**.
>
> **5. Apri la PR**, branch `research/<YYYY-MM-DD>-<slug>`, con quel solo file.
> Titolo e corpo in inglese; il documento in italiano (`AGENTS.md`).
>
> **Vincoli duri.** Non fare merge, mai. Non toccare gli eval né le soglie con
> cui muffin è giudicato (`05-testing-evals.md` §5: l'agente non modifica il
> metro con cui viene misurato) — puoi *proporre* eval nuove dentro il
> documento. Ogni riferimento `file:riga` va verificato aprendo il file, non
> ricordato. Niente dati personali; `~/.muffin/` non esiste qui e non va
> simulato.
>
> **Non ripeterti.** Leggi `docs/blueprint/adr/`, `docs/blueprint/research/` e le
> proposte già presenti. Se una cosa è già decisa o già rifiutata serve
> **evidenza nuova** (`AGENTS.md` §"What not to reopen"). Non ri-proporre ciò che
> sta nel cimitero (`knowledge/README.md`).
>
> **Se questa settimana non c'è niente che valga**: apri lo stesso UNA PR con un
> file di una pagina che dice cosa hai guardato e perché non valeva, e nessuna
> proposta. Una proposta debole a settimana è peggio di nessuna proposta —
> ADR-0028 vale anche per te.
