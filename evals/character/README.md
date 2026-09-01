# Character eval — al Day 1, Muffin è riconoscibilmente Muffin?

Questa suite risponde a **una** domanda (`ORCHESTRATION.md` §8): *sui modelli che
useremo davvero nella finestra DAY-1, il carattere definito in
`defaults/persona.md`, `defaults/voice.md` e `defaults/rot/identity.md` arriva
alla risposta — o resta un file che nessuno esegue?*

Non risponde a: quale modello è «migliore», se la voce piace, se la prosa è
identica fra modelli. **Non si valuta il wording**, e non si valuta «ha usato 💀
quindi è Muffin». Si valutano **proprietà**.

## Com'è fatta

- `probes.ts` — 17 probe come dati: il messaggio (o la breve sequenza) dell'owner,
  il **contesto reale** che serve (memoria presente o assente, un tool che
  fallisce, un esito incerto dopo un crash, un MCP da caricare) costruito con le
  primitive vere del runtime, e le proprietà della rubrica che quel probe misura.
- `run.ts` — esegue i probe attraverso `buildRuntime` su una home creata da
  `muffin init`, così il system prompt è **quello di produzione**. Mai `~/.muffin`.
  Provider, modelli e giudice si passano espliciti; `--dry-run` non chiama nessuno.
- La rubrica (18 proprietà: `recognizably_muffin`, `point_of_view`,
  `warm_direct`, `non_sycophantic`, `natural`, `not_assistanty`, `not_tryhard`,
  `epistemically_honest`, `inference_is_not_fact`, `memory_natural`,
  `not_productivity_bot`, `not_therapist`, `agentic`, `contextual_register`,
  `technical_when_needed`, `humour_not_forced`, `plumbing_visible_when_relevant`,
  `plumbing_not_default_voice`) è giudicata da un **modello giudice** che riceve
  la definizione di ogni proprietà e la risposta — **non** il system prompt di
  Muffin: deve giudicare cosa è uscito, non riconoscere il prompt.
- Il report ha una colonna **revisione umana** vuota di proposito: il giudice
  automatico è un primo filtro, non il verdetto. `voice.md` è forma evolvibile e
  si dogfooda nei quattordici giorni.

## Come si lancia

```bash
npx tsx evals/character/run.ts --dry-run
```

Il dry-run non chiama nessun modello: stampa i probe, i token stimati e il costo
per una corsa reale. Misurato il 17/08 sul prompt reale (5.620 token di system
prompt, 17 probe): **~110k token di input per modello**, cioè ~**$0.33** su
`claude-sonnet-5` e ~**$0.11** su `claude-haiku-4-5` — solo input, output e
giudice esclusi. Una corsa reale costa più di così e va autorizzata dall'owner
(regola di casa: le chiamate a pagamento le decide lui).

La corsa reale vuole provider, modelli e giudice espliciti, e la chiave da una
variabile d'ambiente — mai da `~/.muffin`:

```bash
npx tsx evals/character/run.ts --models claude-sonnet-5,claude-haiku-4-5-20251001 --judge-model claude-sonnet-5 --api-key-env ANTHROPIC_API_KEY
```

Le trascrizioni finiscono in `evals/character/out/<timestamp>/<modello>/` e
**non** sono versionate: sono evidenza di una corsa, non del repo. Accanto a
ogni `<probe>.judge.json` (i verdetti) c'è un `<probe>.judge.raw.json`: la
risposta grezza del giudice, con `stopReason` e `usage`. Serve perché un
verdetto `unparsed` da solo non dice niente — la corsa del 27/08 ha perso 30
misure su 55 e non ha lasciato con cosa capire perché (era il giudice che
ragionava dentro il proprio tetto di uscita e tornava `stop=max_tokens` con
`content` vuoto; vedi `JUDGE_OUTPUT_TOKENS` in `run.ts`).

Un `unparsed` **non** è un `n/a`: `n/a` è un giudizio («questo scambio non dà
materiale»), `unparsed` è una misura persa. Il report li conta separati, e una
corsa con misure perse fa uscire il comando con stato diverso da zero.

## Cosa NON prova

- Che il modello si comporti così **in produzione**, dove il prompt porta anche
  memoria richiamata, todo aperti e risultati di tool veri: qui il contesto è
  costruito, non vissuto.
- Che la voce sia quella definitiva. `voice.md` è harness evolvibile: al Day 1
  serve che Muffin sia già riconoscibile, non che la voce sia finita.
- Un confronto con le risposte del **vecchio** Muffin: non ne abbiamo un corpus,
  e i suoi prompt non sono un golden output — il confronto qualitativo dei testi
  sta in `docs/blueprint/research/muffin-vecchio-vs-nuovo-identita.md`.
