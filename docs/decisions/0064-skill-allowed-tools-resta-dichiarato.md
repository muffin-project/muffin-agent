# ADR-0064 — `allowed-tools` resta dichiarato e non applicato; `skills-ref` entra come controllo

**Stato:** proposto · 2026-09-04 · esegue la raccomandazione di
`docs/evidence/skill-standard-2026-09-04.md` §Raccomandazione

> **Proposto, non accettato.** Nessuna riga di codice cambia con questo
> documento. Diventa `accettato` solo con una decisione dell'owner, nello
> stesso commit che implementa i due punti sotto. Se l'owner decide altrimenti,
> questo file diventa lineage in `docs/history/design-notes/` e la ricerca resta
> come evidence.

## Contesto

L'owner ha chiesto se le skill di Muffin seguono lo standard che si trova in
giro. `docs/evidence/skill-standard-2026-09-04.md` ha verificato che il
formato lo segue byte per byte (`core/skills/skills.ts` replica esattamente i
sei campi e i vincoli di `agentskills.io/specification`, letto alla fonte lo
stesso giorno), e che l'adozione (ADR-0010) compra un'interoperabilità reale e
non ipotetica: OpenClaw e Hermes Agent — i due peer che l'owner segue per
nome — sono entrambi elencati oggi come adopter dello stesso standard esatto.

Restano due punti aperti nel codice, entrambi con un commento che lascia
intendere un lavoro futuro implicito senza mai deciderlo per iscritto:

1. `core/skills/skills.ts:42` — il campo `allowedTools` sul tipo `SkillInfo` è
   commentato **"Present but NOT enforced in v1"**. La dicitura "v1" implica un
   piano d'azione: qualcuno, un giorno, potrebbe leggerla come "va applicato in
   v2" senza aver mai verificato *perché* non lo è oggi.
2. Nessun punto del repo esegue `skills-ref validate` (`grep -rln "skills-ref"`
   su tutto `dev`: solo due voci di evidence che *ne parlano*, zero uso reale).
   La conformità del parser Zod (`FrontmatterSchema`, `skills.ts:24-35`) al
   validator canonico dello standard non è mai stata confrontata contro
   l'implementazione di riferimento — solo letta a occhio contro la
   specifica.

Sul primo punto, la ricerca ha trovato un fatto che cambia il calcolo: Claude
Code — la reference implementation, non un adottante minore — **ha
implementato l'enforcement di `allowed-tools`** da quando l'evidence
dell'08/08 è stata scritta, e la sua stessa documentazione ne segnala il
rischio in modo esplicito: *"Workspace trust doesn't gate this field... A
skill can grant itself broad tool access, so review the `allowed-tools` of
skills checked into a repository before you run Claude Code there."*
(`code.claude.com/docs/en/skills`, letto 2026-09-04). Cioè: nella reference
implementation, un file di testo — installabile con un `git clone`, non
scritto dall'owner in quella sessione — può concedere a se stesso l'uso di
strumenti senza passare dal dialogo di trust del workspace.

In Muffin questo canale non esiste per costruzione, non per omissione:
`core/policy/decide.ts` decide se una capability richiede l'`ask` dell'owner
sulla base di `capability` + `risk` + `taint` calcolati dal kernel
(`decide.ts:84-85` la funzione `ask()`, `decide.ts:254-291` la logica di
soglia), mai leggendo un campo dichiarato dentro il testo che il modello ha
appena letto. Il corpo di una skill è tier 1 — istruzioni, non dati fenced
(`agent/tools/skill.ts:115-128`) — proprio perché è testo che l'owner ha
installato e può audire, ma "installato e auditabile" non è la stessa
garanzia di "non può auto-concedersi privilegi": una skill di terzi scaricata
e mai riletta riga per riga potrebbe contenere `allowed-tools: shell_run`
tanto quanto una skill di Claude Code può contenere `allowed-tools: Bash(*)`.
Applicare il campo sposterebbe la decisione "quale capability posso usare ora"
dal kernel al testo — la stessa classe di problema che le note di sicurezza
del repo chiamano "la capacità sta nel nodo, non nel testo che la chiede".

## Decisione

**`allowed-tools` resta parsato e mai applicato**, e la ragione entra nel
commento del codice invece di restare implicita in "v1":

```
core/skills/skills.ts — SkillInfo.allowedTools:
  Dichiarato dallo standard, mai letto da una decisione di policy. Applicarlo
  sposterebbe "quale capability posso usare ora" dal kernel (decide.ts, che
  decide su capability+risk+taint) al testo di una skill installata — lo
  stesso canale che la reference implementation ammette essere un vettore di
  privilege escalation (code.claude.com/docs/en/skills, "A skill can grant
  itself broad tool access"). Se un giorno serve una skill che pre-autorizza
  uno strumento per il proprio turno, il meccanismo passa dal kernel — una
  policy che il turno dichiara e che decide.ts valuta con lo stesso rigore di
  ogni altra ask-gate — non da un parser di frontmatter. ADR-0064.
```

Nessun comportamento cambia: il campo resta nel tipo (serve al report — "quali
skill dichiarano di volere quali strumenti" è comunque informazione utile a
`doctor`), semplicemente smette di essere un lavoro rinviato e diventa un
confine deciso.

**`skills-ref` entra come controllo, non come dipendenza runtime.** Un job
(script in `scripts/`, richiamato da CI) esegue `skills-ref validate` su ogni
cartella sotto `defaults/skills/*` e sulla skill "cattiva" già costruita dal
test D9 (`evals/acceptance/scenarios/d-skills.accept.ts:61-66`), verificando
che il validator canonico e `FrontmatterSchema` concordino sia sull'accettare
sia sul rifiutare. Se divergono, il job fallisce e nomina la riga di
divergenza — non "aggiorna" silenziosamente lo schema Zod per farli
coincidere.

## Alternative considerate

**Applicare `allowed-tools` come Claude Code.** Comprerebbe una comodità UX
(pre-approvazione per il turno) al prezzo di aprire in Muffin lo stesso canale
che la sua stessa reference implementation segnala come rischio. Scartata:
nessuna richiesta dell'owner la giustifica oggi, e il costo di sicurezza è
descritto a fonte primaria, non congetturato.

**Non fare nulla (lasciare il commento "v1" com'è).** Scartata: è la ragione
per cui questo ADR esiste. Un commento che promette un completamento futuro
senza mai decidere se va completato è lo stesso pattern che
`docs/evidence/i-sink-scoperti-2026-09-04.md` (citato in ADR-0061) ha già
misurato altrove nel repo: una frase di copertura letta più larga di com'era.

**Sostituire lo schema Zod con `skills-ref` in produzione.** Aggiungerebbe una
dipendenza npm sul percorso di boot per un controllo che serve solo in CI.
Scartata: il confronto va fatto come test, non come sostituzione runtime.

## Conseguenze

- Il commento "NOT enforced in v1" smette di essere una promessa implicita e
  diventa una decisione citabile (`ADR-0064`), nello stesso punto del codice.
- Un nuovo controllo CI (costo: una dev-dependency, uno script, un job) alza
  la fiducia che `FrontmatterSchema` non stia derivando dallo standard senza
  che nessuno se ne accorga — lo stesso rischio di drift silenzioso che
  l'evidence dell'08/08 aveva già misurato per la spec stessa.
- Nessuna riga di `rot/policy.json`, nessuna capability, nessun tool cambia.

## Reversibilità

**Alta.** Il commento è testo; il job CI è un controllo aggiuntivo che non
altera un comportamento esistente e si rimuove con un `git revert` pulito.
Se in futuro serve davvero pre-autorizzare uno strumento dal contesto di una
skill, il disegno del meccanismo (nel kernel, non nel frontmatter) è un lavoro
nuovo e separato — questo ADR non lo preclude, gli dà solo un punto di
partenza scritto: *non nel testo della skill*.

## Cosa lo ribalterebbe

- Claude Code, OpenCode o un altro adottante pubblica evidenza di un incidente
  reale causato dall'assenza di enforcement in un sistema con architettura di
  capability equivalente a quella di Muffin — cioè un caso in cui il kernel,
  non il frontmatter, avrebbe dovuto fermare qualcosa e non l'ha fatto perché
  nessuno glielo aveva detto.
- L'owner chiede esplicitamente una skill che debba pre-autorizzare uno
  strumento per il proprio turno (es. una skill di manutenzione che deve poter
  girare senza interruzioni di `ask`) — a quel punto il meccanismo va
  disegnato nel kernel, con la stessa ricerca previa che `docs/RESEARCH.md`
  richiede per ogni cambio ad autorità/sicurezza.
