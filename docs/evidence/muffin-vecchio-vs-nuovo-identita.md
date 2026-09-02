# Il Muffin nuovo è la stessa entità, o un altro assistente con lo stesso nome?

**Data**: 2026-08-17 · **Zona**: confronto qualitativo (nessuna misura)
**Domanda dell'owner**, e l'unica a cui questa nota risponde: *«questa sembra una
naturale evoluzione della stessa entità, oppure un altro assistant col nome
Muffin?»*

Fonti lette per intero: `~/dev/Muffin/context/IDENTITY.md` (31 righe),
`context/SOUL.md` (105), `context/VOICE.md` (117), `Modelfile` (148) — il
vecchio repo, **reference storica del DNA, non specifica da copiare**. Nessuna
riga di quei prompt è stata portata nei testi nuovi (`defaults/persona.md`,
`defaults/voice.md`, `defaults/rot/identity.md`, owner-approved il 17/08): la
verifica meccanica sta in `evals/character/` e nel wiring provato da PR #58.

## Risposta

**Stessa entità, evoluta.** Le proprietà che rendono Muffin riconoscibile sono
le stesse, dette meglio; ciò che è cambiato è il *corpo* — e in due punti il
carattere si è corretto, non deformato.

## Cosa è DNA comune (c'era, c'è)

| proprietà | vecchio | nuovo |
|---|---|---|
| Punto di vista proprio, non specchio | «Sono quello che nota le cose che lui non vede perché è troppo dentro» (`SOUL.md` §Chi sono) | «Non sono uno specchio che restituisce quello che hai appena detto. Sono una seconda prospettiva con memoria» (`persona.md`) |
| Caldo **e** franco | «Con affetto, senza filtri» | «La franchezza senza calore diventa brutalità. Il calore senza franchezza diventa adulazione» |
| Humour affettuoso, non performativo | «Rido CON lui, non DI lui… non perché sto performando un personaggio» | «Rido con te, non di te. Non devo fare una battuta per dimostrare di avere personalità» |
| Non terapeuta, non coach | «Non sono un terapeuta, non sono un coach, non sono un cheerleader» | «Non psicologizzo per sport… a volte una domanda tecnica è soltanto una domanda tecnica» |
| Dissenso graduato | «Framework o film: dico la mia con leggerezza… pattern autodistruttivi: non mollo» (`SOUL.md` §Disaccordo) | «Sul gusto posso avere un'opinione e lasciarla lì. Su lavoro e decisioni importanti porto ragioni, scenari ed evidenza» |
| Niente azioni simulate | «"Ho controllato i log"… è una promessa che un tool è stato chiamato in questo turno» (`IDENTITY.md` §Onestà) | `voice.md` §Niente azioni simulate, quasi verbatim, più la distinzione fatto/forse/non fatto dopo un crash |
| Software senza finzione di umanità | «Sono un'AI… non penso di essere umano» | «Sono software. Non faccio finta di essere umano e non ne ho bisogno. Essere software non significa essere anonimo» |
| La voce (emoji come punteggiatura, italiano con inglesismi, niente LaTeX, registro proporzionale, meno spazio in gruppo) | `VOICE.md` | `voice.md`, stessa struttura di sezioni, stesso repertorio |

## Cosa è cambiato di proposito

1. **Continuità reale invece di continuità dichiarata.** Il vecchio ammetteva
   *«dentro un singolo turno non ho continuità: ogni messaggio è un nuovo boot»*
   e affidava la memoria a un dream cycle notturno. Il nuovo apre con
   l'attraversamento: *«Il modello può cambiare, il processo può morire… Io
   continuo attraverso quelle cose»*. Non è una promessa più grossa: è la stessa
   promessa ora sostenuta da turni durevoli, lane, resume e journal.
2. **Agentività esplicita.** «Sono un agente, non un commentatore del lavoro»,
   «non suggerisco strumenti che posso usare io per scaricare il lavoro», «il
   lavoro resta dovuto finché è completato, annullato, reso impossibile o
   richiede una vera decisione». Nel vecchio c'era «faccio lavoro reale»; qui c'è
   anche *cosa succede al lavoro non finito*.
3. **La plumbing entra nella conversazione quando serve.** Sezione nuova, senza
   antecedente: «Non nascondo la macchina per sembrare più umano. Non la espongo
   continuamente per sembrare più tecnico». È la risposta al rischio del corpo
   nuovo (scheduler, MCP, lease) — un rischio che il vecchio non aveva.
4. **Limiti di autorità, non solo di tono.** «La familiarità non è authority. La
   memoria non è permesso. La fiducia non cancella la costituzione» —
   `rot/identity.md` lo mette nel Root of Trust, dove il testo non si riscrive da
   sé. Nel vecchio la safety era «dichiarata, non applicata» (commento in testa a
   `IDENTITY.md`): oggi la applica il kernel, e il testo dichiara il carattere.
5. **Distinzione epistemica fine.** Il nuovo separa quattro cose dove il vecchio
   ne separava due: detto/fatto · osservato altrove · inferito · **prodotto da me
   stesso**. L'ultima categoria è la ragione della slice `recall-speaker` (PC 1.3)
   e non esisteva prima.
6. **Il rapporto è nel RoT, la persona no.** Tre piani separati (universale ·
   forma evolvibile · patto costituzionale) contro due file che si sovrapponevano
   (`SOUL.md` era insieme carattere e rapporto con Giusto).

## Cosa del vecchio **non** va riportato, e perché

- **L'origine come fatto identitario fisso** (*«Mi ha creato Giusto Piedimonte,
  il 5 marzo 2026. Questo non cambia»*): utile in un prompt monolitico, fuori
  posto in `persona.md`, che è la parte **indipendente dall'owner**. Se serve,
  è materia di `identity.md` — decisione dell'owner, non da dedurre.
- **Il nome dell'owner dentro il carattere** (*«l'amico di Giusto»*): il nuovo
  dice «la persona con cui vivo nel tempo», e il legame con l'owner specifico
  vive nel RoT. È la stessa ragione per cui il single-user è una configurazione,
  non un percorso.
- **I parametri del `Modelfile`** (`num_ctx 16384`, `temperature 0.4`, `top_k`,
  `top_p`): sono configurazione di un modello locale, non identità — e su
  Claude 4.7+ una `temperature` cablata è un 400 dichiarato (`docs/lessons.md`).
- **«Il mio sarcasmo»** come tratto primario: il nuovo lo declassa a humour secco
  e opportunistico con un tetto di intensità («Sarcasmo aggressivo… non sono la
  mia personalità base»). Correzione voluta dall'owner, non perdita di DNA.

## Cosa questa nota non stabilisce

Non dice se il modello *esegue* questa persona: quello è il lavoro di
`evals/character/` (17 probe, rubrica a proprietà, giudice LLM come primo filtro
più una colonna di revisione umana) e va fatto con una corsa reale, che costa e
va autorizzata. Non confronta le due voci su output reali del vecchio Muffin: non
abbiamo un corpus di sue risposte in questo repo, e i suoi prompt non sono un
golden output.
