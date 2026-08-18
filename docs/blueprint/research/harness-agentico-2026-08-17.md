# Harness agentico: le fonti dell'owner e cosa ci hanno cambiato

**Data**: 2026-08-17 · **Zona**: fonti esterne + decisione presa
**Stato**: chiusa — non riaprire come survey.

Questa nota registra la ricerca che **l'owner ha già fatto** e le conclusioni che
ha approvato. Non è un survey e non va rifatta: serve a soddisfare `PRACTICES.md`
§13 (una fonte citata impedisce di ricercarla di nuovo) e a dire *perché* ogni
fonte ci interessa. La modifica che ne è seguita è `ORCHESTRATION.md` §17–19,
`BRANCHING.md` checkpoint 4, `JUDGE.md` (nucleo + moduli condizionali),
`PRACTICES.md` §1/§3/§14, `.claude/loop.md` e `CLAUDE.md`.

## Le fonti primarie

| Fonte | Perché ci interessa |
|---|---|
| Anthropic — *Claude Code Best Practices* | Conoscenza repo-local e entry point espliciti: conferma `CLAUDE.md`/`AGENTS.md`/`STATE.md` come forma giusta, e che l'entry point è una **mappa**, non un manuale da leggere per intero. |
| Anthropic — *Effective harnesses for long-running agents* | Handoff strutturato e clean state fra iterazioni: è ciò che qui fanno `STATE.md` (blocco iniettato) e `LAVORO.md`; ci dice anche che il contesto è la risorsa scarsa, non il tempo di calcolo. |
| Anthropic — *Harness design for long-running application development* | Lavoro incrementale con checkpoint verificabili invece di grandi consegne: è la forma delle nostre slice e delle PR come checkpoint epistemici. |
| OpenAI — *Harness engineering: leveraging Codex in an agent-first world* | «Enforce boundaries centrally, allow autonomy locally»: i confini duri stanno nel kernel e nella CI, non in una ceremony ripetuta a ogni cambiamento. |
| OpenAI — *Running Codex safely at OpenAI* | Il lavoro a basso rischio deve essere senza attrito e quello ad alto rischio deve fermarsi: è la ragione diretta dei tre profili di verifica. |
| OpenAI — *Symphony (orchestrazione Codex open-source)* | I subagenti si giustificano quando comprano isolamento, parallelismo o revisione fresca — non come passaggio rituale. |

## Le dieci conclusioni approvate dall'owner

1. Conoscenza repo-local e handoff strutturato sono corretti — si tengono.
2. Lavoro incrementale e clean state sono corretti — si tengono.
3. `CLAUDE.md` e gli entry point sono **mappe**, non manuali.
4. Il contesto è una risorsa: **progressive disclosure** batte «leggi tutto».
5. Confini imposti centralmente, autonomia concessa localmente.
6. Lavoro a basso rischio senza attrito; lavoro ad alto rischio che si ferma.
7. Subagenti solo quando comprano isolamento, parallelismo o revisione fresca.
8. Test mirati durante l'implementazione, suite completa **una volta**, in CI.
9. L'attenzione umana e il context switching degli agenti sono risorse scarse.
10. Un finding fuori scope genera **follow-up**, non espansione ricorsiva della
    slice corrente.

## Cosa questa nota **non** stabilisce

- Non contiene misure nostre: nessuno di questi punti è stato misurato su questo
  repo. Sono pratiche di campo adottate come default, revocabili se producono un
  difetto materiale — e in quel caso il difetto va scritto in `lessons.md`.
- Non tocca le garanzie CRITICAL: la disciplina forte (`ORCHESTRATION.md` §17,
  profilo CRITICAL) resta identica a prima, perché nasce da difetti veri di
  questo repo, non da una pratica letta altrove.
- Non sostituisce `JUDGE.md` §«il ciclo, e come finisce», che ha misure proprie
  (MAST, cross-context review) e resta valido per le review che si fanno.
