# ADR-0011 — Confine codice / configurazione / dati utente

**Contesto.** Open source: se codice, config e dati sono intrecciati, non si distribuisce (BRIEF). L'aggiornamento del repo non deve mai sovrascrivere l'identità che l'utente ha costruito.

**Decisione.** Tre territori con write-path diversi:
- **Repo** (codice + default + template + fixtures sintetiche): scrivono i maintainer via PR. Contiene `defaults/` (identity template, profili modello, matrice policy di default, seed vocabolario).
- **`~/.muffin/` (XDG)**: tutto ciò che è dell'utente — `config/`, `rot/` (ADR-0003), `db/` (SQLite), `vault/`, `traces/`, `evals/` (golden set personale), `voice.md`, `user.md`, `identity.md` (copiato al primo install). Un `git pull`+update non lo tocca **mai**: quando i default del repo cambiano, l'updater *propone* il merge (diff mostrato, decisione dell'utente/owner — per `identity.md` con conferma esplicita perché è RoT).
- **Secrets**: keychain OS o file cifrato (age) in `~/.muffin/secrets/`, referenziati per nome; mai in config in chiaro, mai nei trace (redaction nel layer tracing).

**Alternative scartate.** *Config nel repo con gitignore*: il pattern "fork personale" che rende impossibile aggiornare. *Dotfile sparsi*: irrecuperabile per backup/GDPR/export (qui: `~/.muffin` è UNA cosa da backuppare). *Config-file gigante*: vietato dal BRIEF — la configurazione si fa parlando con Muffin (L0-2), i file sono lo storage, non l'interfaccia.

**Conseguenze.** Più facile: distribuire, aggiornare, backuppare, cancellare (GDPR: `~/.muffin` è il perimetro). Più difficile: ogni nuova configurabile deve dichiarare la sua casa e il suo default (08 tiene il registro).

**Reversibilità.** Bassa dopo i primi utenti terzi (spostare i dati di casa è una migrazione per tutti): per questo si decide ORA. Segnale che era sbagliata: PR ricorrenti che aggiungono stato fuori da `~/.muffin` (il confine non regge la pratica).

---

## Revisione 2026-08-17 (owner: decisione A2/A3, `slice/identita`)

Il commit `c090dce` ha sostituito `defaults/persona.md`, `defaults/voice.md` e
`defaults/rot/identity.md` — non più template, testo reale dell'owner — realizzando la
riga 7 qui sopra ("l'updater *propone* il merge... per `identity.md` con conferma esplicita
perché è RoT") per la prima volta con contenuto vero da proporre. Questa revisione
documenta due cose che quella riga presupponeva e non diceva ancora: i passi concreti per
un `~/.muffin` esistente **oggi**, e cosa `muffin update` — non ancora scritto — deve fare
quando esisterà.

### Adozione su un'installazione esistente

L'owner ha già una `~/.muffin` coi tre file vecchi installati e `identity.md` sigillata nel
Root of Trust. `muffin update` non esiste (§sotto), quindi i passi sono manuali, e sono
divisi in due gruppi perché **solo uno dei tre file è sigillato**:

```
# persona.md e voice.md: fuori dal RoT (core/config/config.ts paths()), nessun reseal serve
cp defaults/persona.md   ~/.muffin/persona.md
cp defaults/voice.md     ~/.muffin/voice.md

# identity.md: dentro rot/, il manifest sigillato ne conosce l'hash — copiare senza
# risigillare fa leggere una divergenza al prossimo boot (safe mode in single-user,
# boot rifiutato in hardened — core/rot/verify.ts verify())
cp defaults/rot/identity.md ~/.muffin/rot/identity.md
muffin rot reseal            # core/rot/verify.ts seal(): ri-hasha TUTTO rot/, riscrive
                              # manifest.json e l'anchor esterno — non solo identity.md
muffin doctor                 # conferma che il root of trust torni a leggere ok
```

Il `reseal` sigilla l'intera `rot/`, non solo il file appena copiato — se nel frattempo
sono state fatte altre modifiche non intenzionali sotto `rot/`, questo comando le accetta
come vere insieme a quella voluta. Già dichiarato altrove e vale anche qui: *"il RoT
significa 'il loop agentico e i tenant non possono cambiarlo', non 'immutabile in
assoluto'"* (ADR-0003 §Revisione, punto 3; la stessa idea in inglese sul codice che il
comando chiama, `core/rot/verify.ts:143-145` — *"The RoT means 'the agent loop cannot
change this', never 'nobody can'"*). Un `muffin rot verify` prima del reseal, per vedere
esattamente quali file risultano divergenti, è la precauzione a costo zero.

### Cosa deve fare `muffin update`, quando esisterà

**Non implementato in questa slice** — mandato owner esplicito. La regola che il codice
dovrà rispettare, perché non regga solo come intenzione:

- **`persona.md`/`voice.md`**: possono aggiornarsi da soli **solo se l'owner non li ha
  toccati** dall'ultimo install/update. Oggi non esiste un modo economico per saperlo:
  `cli/init.ts installFile` (`:142`) controlla solo `existsSync(dest)`, mai un contenuto —
  "il file c'è" non è "il file è ancora quello che ho scritto io". Chi implementa `update`
  deve prima risolvere questo: o un hash della versione installata salvato da qualche parte
  che l'owner non ha ragione di editare (`config.json`? un campo nel manifest del RoT esteso
  a file non sigillati, che sarebbe un cambiamento di scopo del RoT stesso e va discusso), o
  — più semplice e più sicuro come default finché quel meccanismo non esiste — trattare
  *sempre* `persona.md`/`voice.md` come `identity.md` sotto: mostra il diff, chiedi.
- **`identity.md`: mai in silenzio, punto.** Nessuna euristica "non modificato quindi sicuro
  da sovrascrivere" si applica qui, anche se tecnicamente disponibile: è il patto
  costituzionale scelto dall'owner (ADR-0046, `docs/blueprint/adr/0046-identita-e-contenuto-
  sono-due-piani.md`), e "non l'ha toccato" non distingue "va bene com'è" da "non ci ha
  ancora pensato". Conferma esplicita, sempre, prima di scrivere sotto `rot/` — e un
  `muffin rot reseal` è parte dell'operazione, non un passo successivo che l'owner deve
  ricordarsi da solo.
- **Il diff mostrato** (già promesso dalla riga originale di questo ADR) deve essere un vero
  diff testuale fra l'installato e il nuovo `defaults/`, non una descrizione — la stessa
  disciplina di `muffin rot verify`, che nomina i file divergenti invece di dire "qualcosa è
  cambiato".
