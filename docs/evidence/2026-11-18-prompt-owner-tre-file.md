# 2026-11-18 — il prompt owner tiene i tre file finché ADR-0107 non è accettato

Domanda: su `dev` `0d1c7ceb`, un turno owner legge solo `rot/identity.md`.
L'ADR-0107 dice ancora «in attesa dell'owner». La home installata (`7064bec`,
`muffin prompt show --blocks`) legge persona, identità sigillata e voce.
Il patto corto spedito contiene «Il registro segue il momento»; il file
sigillato della home no. Installare così fa sentire un altro Muffin, e
l'assemblaggio non può risigillare al posto dell'owner.

Trigger del challenge pass: person model. Peer letto il 2026-11-18: Hermes
tiene `SOUL.md` come slot 1 e non sovrascrive un file già presente
(`NousResearch/hermes-agent` PR 1922, docs `which-file-does-what` e
`personality`). OpenClaw separa IDENTITY e SOUL e li fa scrivere dal
dialogo, non da un reseal silenzioso. Nessuno dei due è una ragione per
spedire un taglio il cui stesso ADR è ancora una proposta.

| | |
|---|---|
| Fallimento misurato | Il turno owner su `0d1c7ceb` non legge `persona.md` né `voice.md`. |
| Meccanismo attuale | `buildSystemPromptBlocks` → `systemPrompts[turnClass]` in `agent/loop/round.ts`. |
| A, scelta | Se il file c'è e ha testo, il prompt owner lo include: persona, patto, voce. Il sigillo si legge e non si scrive. Una home nuova, senza quei file, resta al patto sigillato. |
| B | Ricopiare anche i file in `muffin init` e alzare il tetto dei 4000 token. Rimette in vigore il prefisso lungo per chi non ce l'ha. Non è il difetto misurato. |
| C | Lasciare il taglio e chiedere il reseal. Il reseal è un atto dell'owner, e lo stato dell'ADR dice che non l'ha accettato. |
| Falsificatore | Su una home con i due file, `buildRuntime` manda i tre blocchi in quell'ordine e i byte di `rot/identity.md` restano quelli di prima. Togliere la lettura di `voice.md` fa fallire il test. |

Scelta: A. Il profilo è CRITICAL perché il prefisso di ogni turno owner cambia in silenzio e confina con il sigillo, anche se non lo scrive.
