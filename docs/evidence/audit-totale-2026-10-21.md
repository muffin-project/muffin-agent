# Audit totale di Muffin, 21/10/2026

Questo documento guarda **tutto**: il repository, il codice sul percorso di
produzione, i documenti, lo stato GitHub e l'installazione viva. Non è la
continuazione del lavoro G0: è il tentativo di rispondere a una domanda diversa,
«a che punto è davvero Muffin», senza fidarsi del racconto che il repository fa
di sé.

La conclusione in una frase: **Muffin è un runtime serio con una disciplina di
sicurezza sopra la media e una crisi di consegna.** Il codice è più avanti della
sua prova, la prova è più avanti della sua consegna, la consegna è più avanti
della sua documentazione. Il prodotto non è rotto; è **non ancora sulla strada
di produzione** in troppi punti contemporaneamente.

## Metodo

Osservato direttamente il 21/10/2026:

- Git: branch, HEAD, stato, tag, divario con `origin`, contenuto di
  `.releases/current`.
- GitHub: issue aperte, milestone, PR, release, tag, esito dei check.
- Installazione viva: launcher `~/.local/bin/muffin`, `~/.muffin`, gateway
  supervisionato, `--version`, `doctor` (eseguito durante G0).
- Codice: percorso di produzione letto nei punti che reggono le conclusioni
  (ingress, turno, policy, egress, update, resume, superficie, delivery).
- Documenti: `docs/README.md`, roadmap, stato DAY-1, criteri, ADR citati,
  `MVP.md`, piano di esecuzione.

Sei esplorazioni read-only parallele (architettura, documenti, test/CI,
sicurezza, GitHub, prodotto) hanno rastrellato il resto. **Le loro conclusioni
non sono prove**: le ho ri-verificate a campione, e nel documento distinguo
«verificato qui» da «riferito». La prova SSRF è stata eseguita; i conteggi di
test, manifest, milestone e PR sono stati riletti; le contraddizioni
documentali sono state aperte nel file.

Non ho rieseguito l'intera suite, tutti gli eval, tutti gli attacchi di
`evals/security`, il project board GitHub (il token non ha `read:project`), né
ho misurato i provider reali. Dove un numero viene da una corsa precedente, è
scritto.

Base: `fix/reliability-remediation` a `dae23668`, **sporca** (31 modificati, 7
non tracciati), non presente su `origin`.

## Cosa è Muffin oggi

Non un chatbot. Un agente personale persistente, con un gateway
supervisionato, superfici (CLI, REPL, Telegram, Discord WIP), un kernel di
policy che distingue taint e reversibilità, memoria, job e scheduler, tool
tipizzati, un'installazione con update e backup.

La fase dichiarata è **source-public / pre-alpha**: il repository è
contribuibile, il prodotto non è alpha. Non esistono release né tag di
prodotto; esiste un solo tag locale di backup (`523-slice-backup`). La
milestone DAY-1 ha 62 righe READY, 9 OUT, 1 `? PARZIALE`, 0 BLOCKER su 72; il
dogfood di quattordici giorni non è mai iniziato. L'MVP è una **proposta del
21/10**, non uno stato raggiunto.

La scommessa di prodotto è coerente e vale la pena: continuità, autorità,
un solo owner, installazione locale, l'agente che vive dove vive l'owner. Il
problema dell'audit non è la tesi; è la distanza fra tesi e catena di
consegna.

## Il percorso di produzione, in breve

```text
CLI / REPL / Telegram
    → connectors/shared/ingress/work.ts  (WorkPort, lane, enqueue)
    → router                             (un turno alla volta per scope)
    → agent/loop.ts → agent/loop/engine.ts
    → contesto (agent/context/assemble.ts)
    → modello (ModelLane, OpenRouter)
    → tool (agent/tools/*)
    → policy (core/policy/decide.ts, matrix.ts, taint)
    → stato (core/turns, core/memory, core/jobs, scheduler)
    → superficie (delivery, send_file, streaming)
gateway supervisionato (cli/gateway.ts, core/gateway/*)
installazione/update (cli/update.ts, .releases, launcher)
```

I punti che l'audit ha trovato fragili non sono «moduli mancanti». Sono
**raccordi**: ciò che collega un meccanismo al suo consumatore reale.

## I dieci difetti che contano

### F1. SSRF: la soglia vieta solo la forma dotted dell'IPv4-mapped — CRITICO

`core/net/egress.ts:118-136` dichiara nel commento di rifiutare «v4-mapped v6,
il modo classico in cui un hostname pubblico risolve in privato». La regex
copre solo `::ffff:a.b.c.d`:

```ts
const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
```

La forma esadecimale non entra. `isIP('::ffff:7f00:1')` vale `6`,
`forbiddenV6` non matcha, `isForbiddenAddress` restituisce `false`.
`agent/tools/http.ts:195-199` passa l'hostname a `resolvePinnedIp`, che
accetta un IP letterale (`:326-356`), `buildPinnedUrl` lo mette nell'URL e
`defaultPinnedFetch` ri-verifica con la stessa funzione (`:397-423`), quindi
connette.

**Prova eseguita il 21/10**, non dedotta: un server HTTP in ascolto su
`127.0.0.1`, una richiesta `http.get` con `hostname: '::ffff:7f00:1'` ha
restituito `200` e il corpo `REACHED`. La stessa forma mappa
`169.254.169.254` (`::ffff:a9fe:a9fe`, metadata cloud), `192.168.x.x`
(`::ffff:c0a8:xxxx`), `10.x.x.x`, e così via.

Perché è raggiungibile: `sys.http` non è `hostOnly` (`agent/tools/http.ts:82`);
un URL **citato** salta il gate dei parametri (`core/policy/decide.ts:519-534`);
la riga è `external` (`core/policy/matrix.ts:466`). L'owner a taint 0/1 lo
esegue senza domanda; un membro con l'URL intero pure. Dopo ADR-0066 la
lettura non ha più allowlist: la soglia degli indirizzi è **l'unica** difesa
rimasta, e ha un buco.

Vale anche per le risposte DNS: un hostname pubblico che risolve
`::ffff:7f00:1` passa lo stesso controllo. Non serve un URL letterale.

**Rimedio minimo**: normalizzare ogni forma IPv4-mapped (dotted ed
esadecimale, più la vecchia `::a.b.c.d`) a IPv4 **prima** della
classificazione, e fallire chiuso su una forma che non si sa normalizzare.
Test obbligatori: `::ffff:7f00:1` → vietato, `::ffff:a9fe:a9fe` → vietato,
`::ffff:c0a8:101` → vietato, `::ffff:808:808` → pubblico, oltre a un test
sul tool che prova il connect, non solo la funzione. Controllare nello stesso
passaggio `2002::/16` (6to4) e `fec0::/10` (site-local), oggi non coperti.

`docs/architecture/SECURITY.md:514` afferma che gli equivalenti IPv6 sono
rifiutati. Era falso.

**Aggiornamento, 21/10, dopo l'audit**: F1 è stato corretto nello stesso
branch con `fix(net): refuse hexadecimal IPv4-mapped addresses`.
`mappedV4` normalizza entrambe le grafie prima della classificazione, e la
regressione agisce sul tool, non solo sulla funzione: un URL con
`[::ffff:7f00:1]` non raggiunge più `fetch`. `core/net/egress.test.ts` e
`agent/tools/http-pinning.test.ts`: 44 verdi.

### F2. La build viva non è riproducibile — ALTO

Il launcher `~/.local/bin/muffin` punta a
`~/dev/muffin-agent/dist/cli/main.js`, cioè alla build del worktree sporco:
`muffin 0.0.0 (dae23668c85d+modificato, 2026-10-18)`. Il marcatore
`.releases/current` punta ancora a `f7616889`. Il branch non esiste su
`origin`; non c'è PR, non c'è check CI su questo codice, non c'è tag.

Conseguenze concrete:

- il dogfood di quattordici giorni, se partisse oggi, misurerebbe un artefatto
  non committato;
- un riavvio della macchina non ricostruisce quella build da un SHA;
- `muffin update` ragiona su `.releases/current` e vede una release diversa da
  quella in esecuzione, quindi il rollback raccontato non è quello vero;
- ogni ulteriore modifica al worktree cambia il binario senza che nessuno lo
  sappia.

Non è un difetto di codice: è un difetto di **stato**. La cura è noiosa e
necessaria: autorizzazione a committare, push del branch, PR verso `dev`,
verifica CI, build pulita, aggiornamento di `.releases/current` e del launcher
alla release pulita. Fino a quel momento la frase «giriamo su HEAD» è falsa.

**Aggiornamento, 21/10, dopo l'audit**: il worktree è stato committato
(`22779711`), il branch è stato pushato e la PR verso `dev` è aperta. La build
pulita è stata costruita dallo SHA `709c4179` in `.releases/709c4179`, e
`.releases/current` e il launcher puntano lì: `muffin --version` risponde
`muffin 0.0.0 (709c4179f1ab, 2026-10-21)` e il gateway è stato riavviato su
quella build. Restano la CI della PR (`verifica`, `install`,
`symphony-fixture`) e il merge.

### F3. Meccanismi presenti ma non cablati — ALTO

Il repository conosce il proprio pattern di guasto e lo ripete.

- **Automation rules**: `connectors/shared/ingress/work.ts:52-60` lo dice a
  chiare lettere. Lo store persiste le definizioni, l'adapter compila, ma i
  call site di gateway e superfici non passano né resolver né regole: le
  regole persistite **non girano sull'ingress vivo**. I test iniettano le
  regole e provano la cucitura, non la funzione.
- **Resume**: `cli/resume.ts` costruisce il runtime e chiama `continueTurn`,
  poi chiude. Non attacca MCP (`attachMcp`), non attacca `send_file`, non
  ricostruisce il project root. Un turno ripreso può quindi avere meno tool e
  meno consegna del turno originale.
- **Event intelligence / job delivery**: il percorso eventi è dietro flag e
  non è la strada predefinita; un job che «dice inviato» non ha, su tutte le
  superfici, la stessa prova di consegna del turno interattivo.
- **Canali**: Discord è WIP fuori dal supported path; il gruppo passivo è
  opt-in. Non sono bug, ma vanno sottratti al racconto di prodotto, non
  contati come superficie.

La regola da applicare è già scritta in `AGENTS.md`: un meccanismo che
funziona non è la stessa claim dell'esito giusto. O si cabla e si aggiunge uno
scenario che diventa rosso se il cablaggio sparisce, oppure si dichiara OUT e
si toglie dalla superficie offerta.

### F4. Autorità e consegna cambiano con la superficie — ALTO

L'owner binding e l'approvazione hanno un default permissivo:
`inputOrigin` nasce come owner (`agent/loop/engine.ts:260-278`) e
l'approvatore ricade sull'owner (`permissions.ts:255-275`). `send_file` esiste
su CLI e Telegram; su Discord restituisce un percorso
(`cli/surface.ts:1170-1185`). Il `send_file` durevole viene registrato, ma solo
la CLI lo rigioca (`cli/surface.ts:1212-1272`). Un job o un'automazione non
hanno una destinazione di consegna altrettanto esplicita.

Il risultato è che «lo stesso turno» non è lo stesso turno a seconda di dove
è entrato. La tabella D16 riferisce **4/8 attacchi che completano senza umano**
(5/8 se l'owner risponde come ha risposto); non li ho rieseguiti, ma la
struttura che li rende possibili è quella descritta.

La cura non è un altro flag: è un **contesto di esecuzione unico** (principal,
surface, destinazione di consegna) filato attraverso Work, con fallimento
chiuso quando manca. E due accettazioni che oggi non esistono: job → Telegram
con prova di arrivo, resume → file con prova di allegato.

### F5. La suite è ampia, ma la strada viva ha buchi — ALTO

I numeri sono reali: 423 file `*.test.ts` più 2 `*.test.mjs` (425), 5.569 test
verdi, 7 skip, `tsc` pulito. L'accettazione ha 33 file `*.accept.ts` e 64 righe
di manifest (58 `verde`, 6 `provataDalMeccanismo`). Ma:

- `npm test` **esclude** `evals/acceptance/**/*.accept.ts`
  (`vitest.ignored.ts:19-22`); l'accettazione è un comando separato.
- In CI l'accettazione gira solo per PR **ready** verso `dev`/`main`
  (`.github/workflows/ci.yml:225-230`). Non c'è trigger su push a `dev`, non
  c'è un workflow schedulato, non c'è una gamba macOS.
- Gli scenari in-process usano un provider finto (`evals/acceptance/fixtures/`):
  provano il cablaggio col modello, non il modello. Solo una parte gira sul
  binario vero, e gli e2e reali (`e2e:real`, Telegram, character) sono manuali.
- La prova di mutazione è manuale e non ripetibile da CI. Il 21/10 la famiglia
  B4 era ancora ferma al contratto precedente ad ADR-0104: la suite era verde
  perché misurava la cosa sbagliata, non perché il prodotto fosse giusto.
- L'update non è transazionale: backup del DB, build, smoke test, swap; non
  c'è un rollback automatico se il nuovo processo non parte, e il backup non
  copre `.releases`/config.

Questa è la ragione strutturale per cui le regressioni sopravvivono: il segnale
verde non attraversa la strada di produzione.

### F6. I documenti non sono una fonte, sono più fonti in disaccordo — ALTO

Le contraddizioni trovate, tutte verificate nel file:

| Claim | Dove | Cosa dice il codice o lo stato |
|---|---|---|
| «dogfood parte subito, in parallelo» | `docs/status/day1/critical-path.md:24-28` | `readiness-criteria.md` e `ROADMAP.md` lo mettono dopo source-public e dopo zero `?`/BLOCKER |
| Quattro ordini di fase diversi | `ROADMAP.md:21-33`, `public-alpha/readiness-criteria.md:17-24`, `README.md:255-260`, `VISION.md` | non esiste un solo ledger |
| B4: «il piano si mostra senza chiedere» | `requirements-status.md` (riga B4) | ADR-0104: piano on-demand; l'accettazione è stata corretta il 21/10 |
| D13: «la shell in sola lettura non chiede più» | `requirements-status.md` (riga D13) | ADR-0091/`SECURITY.md:648-658`: chiede **ogni volta**, è disclosure irreversibile |
| D6: «Tavily, chiave presente, doctor attiva» | `requirements-status.md` (riga D6) | `doctor` del 21/10: `web_search` spento, manca `tavily_api_key` |
| Workspace: «il gateway pinna la home» | `ROADMAP.md:145-160` | decisione owner: project root dichiarata; il codice è più avanti del documento |
| `docs/STATE.md` come fonte di verità | link in più documenti | il file non esiste |
| «31 acceptance scenarios» | `MVP.md:134` | 33 file, 64 righe di manifest |
| «G0 needs owner go» | `MVP.md:117` | G0 è stato eseguito il 21/10 |
| «#598 not implemented» | `MVP.md:101` | la spina #912–#915 è in `dev`; il gate #598 resta aperto, qui manca |

`docs/README.md` dice «un fatto, una casa». Oggi i fatti hanno più case e le
case si contraddicono. Non è un problema estetico: un agente che legge i propri
documenti per rispondere all'owner impara la versione sbagliata.

### F7. L'installazione viva ha tre buchi dichiarati e uno non dichiarato — MEDIO-ALTO

- `web_search` è spento: manca `tavily_api_key`. La riga D6 lo dà per attivo.
- L'embedder Ollama è giù: l'indice vettoriale ha 1.220 chunk e 1.220 vettori
  coerenti, ma i nuovi ricordi non vengono indicizzati. La memoria resta
  utilizzabile in testo, non in similarità.
- `~/.muffin/v2/persona.md` e `voice.md` sono indietro; l'installazione usa
  v1. L'esperimento v1-vs-v2 non è quindi giudicabile sul campo.
- `rot/*` sigillato diverge (atteso dopo le modifiche); non va toccato.
- La build è quella di F2, con `.releases/current` incoerente.

Nessuno di questi è un mistero: sono tutti in `doctor` o nel piano. Il punto è
che il prodotto che l'owner usa **non è** il prodotto che gli eval misurano.

### F8. La verità di prodotto è più avanti del suo gate — ALTO

DAY-1: 62 READY, 9 OUT, 1 `? PARZIALE` (A11), 0 BLOCKER. La regola scritta è
che i quattordici giorni partono solo con zero BLOCKER **e zero `?`**. A11 è
ancora `?`. La milestone «DAY-1 owner dogfood» ha 8 issue aperte (#769, #771,
#772, #767, #654, #657, #602, #374). #874, la scorecard che deve trasformare
le famiglie in prove di mutazione, non ha ancora una riga PASS: il 21/10 è una
baseline che passa, non una prova che tiene.

#598 (un obiettivo autonomo durevole) è la spina #912–#915 in `dev`, ma non è
in questo branch. L'MVP lo mette dentro il confine; il branch non lo contiene.
È una dipendenza di merge, non una decisione ancora aperta.

Il verdetto di prodotto: la lista «62 READY» è una lista di meccanismi provati
al livello giusto, non di esiti provati sulla strada viva. È esattamente il
pattern che il repository ha già pagato.

### F9. La qualità del prodotto è affittata e non versionata — ALTO

La produzione usa `openrouter/free`. Il modello pinnato della baseline del
19/10 (`nvidia/nemotron-3-super-120b-a12b:free`) il 21/10 restituisce **404 dal
provider Nvidia**. La baseline è stata rifatta con
`nvidia/nemotron-3.5-lightning:free` e giudice
`nvidia/nemotron-3-ultra-550b-a55b:free`: 74/75 giudicate, 59 pass, 9 fail, 6
n/a, 1 misura persa.

Questo significa tre cose:

- il confronto v1/v2 del 19/10 non è riproducibile sullo stesso modello;
- l'eval di carattere non gira sul modello di produzione, quindi non predice
  l'esperienza viva;
- un modello gratuito che sparisce è un single point of failure del prodotto,
  non un dettaglio di configurazione.

Per i quattordici giorni serve un modello **pinnato e noto**, o una catena di
fallback versionata, e la baseline di carattere va rifatta sul modello esatto
che l'owner userà. La spesa (tetto 80 USD/mese, 2/day) non è stata auditata.

### F10. Il perimetro si allarga mentre la spina non è prova — MEDIO

75 issue aperte, 38 nella milestone MVP, 8 PR aperte. Delle PR: #925 è draft
(guest mode, fuori MVP), #923 è Dependabot bloccata dal DCO, #921 e #922 sono
pulite, #920/#915/#914/#910 sono dietro `dev`. Nessuna ha review. La coda
spinge breadth (Groq, guest mode, knip, persona) mentre la scorecard MVP non
ha una prova di mutazione.

L'MVP dice la cosa giusta: il rischio non è la feature mancante, è il
cablaggio non provato e il perimetro senza fondo. La coda delle PR dice
un'altra cosa. Per trenta giorni, la seconda deve perdere.

## Cosa è solido, e va detto

Non è tutto un problema. Queste parti reggono un audit severo:

- **Kernel di policy**: taint e soffitto, `solo-irreversibile`, enumerazione di
  ogni capability spedita, test che pinnano per nome chi chiede. È la parte
  migliore del repository.
- **Turni durevoli e gateway**: SIGKILL a metà turno, sostituzione, ripresa di
  `wait` e job con consegna una sola volta (A1, B-continuity). Pochi progetti
  personali hanno questa prova.
- **Sandbox**: confinamento della scrittura, niente rete IP diretta, test su
  Linux vero; la lettura è dichiarata non confinata, non nascosta.
- **Harness di accettazione**: 33 scenari, manifest esplicito, provider finto
  per il cablaggio, scenari real-binary per il resto, cultura della mutazione.
  È un asset, anche se la CI non lo esegue sempre.
- **Lifecycle**: `init`, `doctor`, `update`, backup, schema-ahead guard,
  supervisore launchd/systemd. L'installazione è trattata come prodotto.
- **Onestà intellettuale**: il repository scrive i propri difetti, spesso nel
  punto in cui li trova. L'audit ha potuto trovare F1 anche perché il commento
  di `egress.ts` prometteva la cosa giusta.

## GitHub e processo

- `dev` è a `a6e6bfae` (18/10), `main` a `1e2117c5` (01/10): 434 commit di
  distanza. `main` non è la linea di sviluppo; è un punto fermo vecchio.
- Il branch di questo lavoro non è su `origin`. Quindi il codice che gira non
  è nemmeno una PR.
- Zero release, un tag locale di backup. Non esiste un artefatto che un altro
  possa installare e verificare.
- Il project board non è leggibile con il token attuale (manca
  `read:project`): la pianificazione non è verificabile da qui.
- CI: `verifica` su PR e su push a `main`; `accettazione` solo su PR ready
  verso `dev`/`main`, su `main` e su dispatch. Nessun trigger su push a `dev`,
  nessuna schedulazione, nessuna gamba macOS.
- 75 issue / 8 PR / nessuna review: il collo di bottiglia non è la scrittura di
  codice, è la **chiusura** (review, merge, release, dogfood).

## Cosa farei nei prossimi trenta giorni

Non è il piano dell'owner; è la raccomandazione dell'audit, ordinata per
riduzione del rischio.

**Giorni 0–2 — togliere il rischio che non aspetta**

1. ~~Decidere e correggere F1 (SSRF) con test rosso→verde~~ — fatto il 21/10
   nello stesso branch, prima di qualsiasi nuova feature.
2. Committare il worktree, pushare il branch, aprire la PR verso `dev`, far
   girare la CI. Senza questo, ogni misura successiva è su sabbia.
3. Congelare il perimetro: niente nuove integrazioni, niente dashboard, niente
   Discord, niente guest mode, niente PR fuori MVP.
4. Chiedere all'owner le tre decisioni che mancano: chiave Tavily, embedder
   (Ollama vs API, dimensioni/reindex), modello pinnato per i quattordici
   giorni.

**Giorni 3–10 — la prova**

5. #874: passare le otto famiglie a **prova di mutazione** sul binario vero;
   una riga è PASS solo se togliere il cablaggio la fa diventare rossa.
6. Cablare o dichiarare OUT i due meccanismi inerti che contano: automation
   rules e resume (MCP, send_file, project root).
7. Aggiornare i documenti che mentono: un solo ledger di fase, B4, D13, D6,
   A11, `MVP.md` (G0, #598, 31 scenari), `STATE.md` o link morti.

**Giorni 11–20 — la spina**

8. G3.2: foreground e prelazione del turno (la parte che l'MVP chiama
   «presence»).
9. Chiudere le otto issue DAY-1 e portare A11 da `?` a READY o OUT.
10. #507: onboarding reale (OAuth, chiave persistita, `init` pulito).
11. Se #598 è dentro l'MVP, mergiare la spina #912–#915 e chiudere il gate.

**Giorni 21–30 — il dogfood**

12. Deploy pulito da SHA, `.releases/current` e launcher coerenti, rollback
    provato.
13. Partire con i quattordici giorni **su quella build**, con evidenza
    giornaliera (turni, errori, costo, consegne) e un canale di rollback.
14. Durante il dogfood: solo difetti osservati. Niente nuove feature.

**Criterio di successo dell'audit, non del piano**: alla fine dei trenta giorni
esiste uno SHA che un'altra macchina può costruire, una PR con check verdi, una
SSRF chiusa con test, otto famiglie con mutazione, e quattordici giorni iniziati
sulla build giusta. Se manca uno di questi, il resto non è prova.

## Cosa non ho verificato

- La suite completa e tutti gli eval sono quelli della corsa del 21/10, non
  rieseguiti qui.
- Non ho rieseguito gli attacchi di `evals/security`: il 4/8 di D16 è
  riferito, non mio.
- Non ho aperto il project board (scope mancante), non ho contato le review
  una per una, non ho misurato la spesa reale.
- Non ho provato il rollback di `muffin update` su un'installazione usa-e-getta.
- Non ho letto ogni documento del repository; ho letto quelli che governano
  fase, MVP, sicurezza e stato DAY-1.

## Decisioni richieste all'owner

1. ~~**Commit/push/PR** del branch e build pulita~~ — fatto il 21/10: PR #926,
   release `709c4179`, launcher e `.releases/current` riconciliati.
2. ~~**SSRF adesso**~~ — chiuso il 21/10 con test. Resta da verificare, nel
   passaggio successivo, `2002::/16` e `fec0::/10`.
3. **Tavily**: chiave, oppure `web_search` dichiarato OUT per i quattordici
   giorni.
4. **Embedder**: Ollama locale (e deroga esplicita alla direttiva «niente
   modelli locali», se vale solo per i modelli) oppure API con reindex.
5. **Modello**: pinnato e pagato per il dogfood, o catena gratuita di fallback
   con baseline rifatta sul modello esatto.
6. **Perimetro**: approvazione a chiudere o rinviare le PR non-MVP per trenta
   giorni.

L'audit non chiede di cambiare la tesi di Muffin. Chiede di smettere di
misurare un prodotto e di consegnarne un altro.
