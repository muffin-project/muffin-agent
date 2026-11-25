# ADR-0108 — Niente sigillo sui file di configurazione dell'owner

**Stato: adottato dall'owner il 2026-11-25 alle 15:20 (Europe/Rome).**
Profilo di verifica **CRITICAL** (`docs/development/ORCHESTRATION.md`: Root
of Trust, authority, dati durevoli). Questa decisione ritira la *cerimonia*
del sigillo sul tier dati. Non autorizza l'agente a scrivere quei file, né
indebolisce il kernel di policy.

Numero: **0108** era il prossimo libero su `dev` al momento della stesura
(`node docs/decisions/prossimo-numero.mjs`).

## Contesto

ADR-0003 ha diviso il Root of Trust in due tier. Il **tier codice** (kernel
di policy, registro delle capability, verificatore) vive nel repository: la
protezione è che non esiste un write-path a runtime. Il **tier dati**
(matrice, egress, budget e quiet hours, `identity.md`) vive in
`~/.muffin/rot/`, con manifest, hash, anchor e il comando `muffin rot reseal`.
In single-user un hash divergente avviava la safe mode; in hardened rifiutava
il boot.

Su un'installazione single-user quel sigillo non dà la prevenzione che
promette. Lo stesso utente può riscrivere i file e risigillarli. #767 e #774
registrano il fatto: un reseal coerente non si distingue da un tamper, e
`muffin rot verify` non distingue un insieme cambiato da una manomissione.
ADR-0003 aveva già scartato firme e TPM come fuori dal threat model, e aveva
indicato come segnale di errore un attrito così frequente sulle modifiche
legittime da dominare l'uso.

I peer (ChatGPT, Claude, Grok Bot, Hermes) non chiedono all'owner una
cerimonia di hash per cambiare identità, tetti di spesa o una allowlist. La
direttiva del 23 novembre 2026 autorizzava a rimuovere o riprogettare Root
of Trust, sigilli e `rot harden` se una protezione comparabile risultava più
semplice. Il 25 novembre 2026, di fronte al suggerimento di `muffin rot reseal`
su tre default derivati, l'owner ha scelto di ritirare il concetto di sigillo
e di ridisegnarlo in quella direzione, non di risigillare.

`rot harden` era già ritirato (#980, poi #1016). Questa decisione completa il
disegno sul tier dati.

## Decisione

1. **Il tier codice resta.** Il kernel di policy, il registro delle capability
   e l'assenza di un write-path su quel codice non cambiano. `rot.write` e
   `rot.*` restano in `neverAtRuntime`: l'agente in un turno non può
   riscrivere i file di confini. Una modifica proposta dall'agente richiede
   un'approvazione esplicita dell'owner per quell'effetto (stessa postura di
   D3 e della questione aperta #516), mai un permesso permanente.

2. **Il tier dati è configurazione dell'owner.** `policy.json`, `budgets.json`,
   `identity.md`, `egress.json` e gli eventuali file affini in `~/.muffin/rot/`
   sono file semplici, modificabili dall'owner. Un suo edit vale al
   caricamento successivo, senza `muffin rot reseal` e senza safe mode. Prima
   di una scrittura fatta da uno strumento di Muffin (allargamento egress,
   binding dell'owner, migrazione, `adopt`) si fa una copia di backup sotto
   `~/.muffin/backups/`.

3. **La cerimonia di sigillo è ritirata.** Manifest, `.rot-anchor`,
   `muffin rot reseal` e l'ingresso in safe mode (o il rifiuto di boot) perché
   un file non coincide più con un hash non sono più il meccanismo in vigore.
   `muffin doctor` descrive la deriva rispetto ai default spediti come
   informazione, e non invita a un `cp` seguito da un reseal. Un comando di
   migrazione aggiorna solo i campi additivi, conserva il fuso orario e
   `identity.md` già presenti, e se `rot/` non è scrivibile (per esempio è
   ancora di `root`) si ferma e dichiara il comando che l'owner deve lanciare
   lui, senza eseguirlo.

4. **#767 e #774 non si “aggiustano” con più sigillo.** La indistinguibilità
   fra reseal coerente e tamper, e fra insieme cambiato e manomissione, è il
   motivo per cui la cerimonia si ritira, non un buco da chiudere con una
   attestazione nuova. I due issue si chiudono su questa decisione, quando il
   codice la rispecchia.

## Alternative scartate

Risigillare i tre default derivati e tenere la cerimonia: è la strada che
l'owner ha rifiutato, e su questa installazione avrebbe anche sovrascritto un
fuso già corretto e un'identità approvata. Aggiungere firme o TPM: già
scartato in ADR-0003, e non toglie complessità. Tenere il sigillo “solo in
hardened”: la ricetta hardened è già ritirata e, in single-user, è la modalità
reale delle installazioni owner.

## Conseguenze

`doctor` e l'avvio smettono di trattare un edit legittimo, o un default
invecchiato, come un incidente. L'aggiornamento dei default spediti è un
merge proposto, mai una copia cieca di `identity.md` o del fuso. Il testo di
ADR-0003 resta come record storico, con un rinvio in testa a questo ADR.
ADR-0107 resta una proposta sul contenuto del prompt; la parola “sigillata”
là non reintroduce questa cerimonia.

## Falsificatore

- Un turno agente può scrivere un file sotto `rot/` (o allargare egress, o
  cambiare i tetti) senza un'approvazione esplicita dell'owner per quell'effetto.
- Un edit dell'owner a `identity.md` o `budgets.json` fa entrare l'installazione
  in safe mode, oppure rifiuta l'avvio, finché non si lancia `muffin rot reseal`.
- `muffin doctor` indica come rimedio un `cp` dei default seguito da
  `muffin rot reseal` per file già presenti.
- Una migrazione dei default sovrascrive il fuso già impostato o sostituisce
  `identity.md` senza una scelta dell'owner.
- Un comando di Muffin esegue da solo un `chown` o un `sudo` su `rot/`.

## Reversibilità

Tornare al sigillo richiederebbe una nuova decisione dell'owner e un ADR
nuovo. I file di configurazione e i backup restano; non si ricostruisce un
hash come fonte di autorità senza quella decisione.
