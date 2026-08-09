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
giudica cosa vale, e traduce ciò che vale in **una** mossa tecnica concreta —
aprendo una PR e **mai** un merge. La PR è il punto di rollback.

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
