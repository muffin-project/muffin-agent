# ADR-0011 — Confine codice / configurazione / dati utente

**Contesto.** Open source: se codice, config e dati sono intrecciati, non si distribuisce (BRIEF). L'aggiornamento del repo non deve mai sovrascrivere l'identità che l'utente ha costruito.

**Decisione.** Tre territori con write-path diversi:
- **Repo** (codice + default + template + fixtures sintetiche): scrivono i maintainer via PR. Contiene `defaults/` (identity template, profili modello, matrice policy di default, seed vocabolario).
- **`~/.muffin/` (XDG)**: tutto ciò che è dell'utente — `config/`, `rot/` (ADR-0003), `db/` (SQLite), `vault/`, `traces/`, `evals/` (golden set personale), `voice.md`, `user.md`, `identity.md` (copiato al primo install). Un `git pull`+update non lo tocca **mai**: quando i default del repo cambiano, l'updater *propone* il merge (diff mostrato, decisione dell'utente/owner — per `identity.md` con conferma esplicita perché è RoT).
- **Secrets**: keychain OS o file cifrato (age) in `~/.muffin/secrets/`, referenziati per nome; mai in config in chiaro, mai nei trace (redaction nel layer tracing).

**Alternative scartate.** *Config nel repo con gitignore*: il pattern "fork personale" che rende impossibile aggiornare. *Dotfile sparsi*: irrecuperabile per backup/GDPR/export (qui: `~/.muffin` è UNA cosa da backuppare). *Config-file gigante*: vietato dal BRIEF — la configurazione si fa parlando con Muffin (L0-2), i file sono lo storage, non l'interfaccia.

**Conseguenze.** Più facile: distribuire, aggiornare, backuppare, cancellare (GDPR: `~/.muffin` è il perimetro). Più difficile: ogni nuova configurabile deve dichiarare la sua casa e il suo default (08 tiene il registro).

**Reversibilità.** Bassa dopo i primi utenti terzi (spostare i dati di casa è una migrazione per tutti): per questo si decide ORA. Segnale che era sbagliata: PR ricorrenti che aggiungono stato fuori da `~/.muffin` (il confine non regge la pratica).
