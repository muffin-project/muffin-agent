# ADR-0085 — La Home Linux è un servizio di sistema, non una user unit

**Stato:** accettato · 2026-09-18 · attua D2 (decisione owner) · emenda ADR-0035
sulla supervisione Linux (non lo riscrive: la user unit resta la storia, questa
è la direzione nuova con la sua evidenza).

## Contesto

ADR-0035 scelse la user unit (`systemctl --user` + `loginctl enable-linger`)
per la ragione giusta di allora: girare come owner senza elevazione. Quella
scelta è diventata incompatibile con il requisito owner sui segreti (niente
file in chiaro come architettura permanente): la prova su VM Ubuntu 24.04
reale (systemd 255, senza TPM — come Hetzner) ha falsificato la combinazione
`--user` + `LoadCredentialEncrypted` con host key:

- key `0400 root` → il servizio muore con `243/CREDENTIALS`
  (`Failed to determine local credential key: Permission denied`);
- key resa leggibile al gruppo → `243/CREDENTIALS` con `Operation not
  permitted` (systemd rifiuta una host key non strettamente `0400 root`);
- `LoadCredential` in chiaro nella user unit funziona (controllo: il resto
  del plumbing è sano), ma è il plaintext che D3 vieta;
- la stessa unit come servizio di sistema con `User=` + host key: decrypt
  al boot senza login, reboot provato con zero sessioni, missing/corrupt che
  falliscono chiusi.

## Decisione

1. **Topologia.** Su Linux Muffin gira come servizio di sistema:
   `/etc/systemd/system/muffin-gateway.service` (root-owned), `User=` =
   l'utente dedicato che installa (mai root — il planner rifiuta `User=root`
   e l'install rifiuta uid 0), `WantedBy=multi-user.target`. Niente linger,
   niente user bus: il boot non richiede login.
2. **Semantica invariata.** `Restart=always`, `RestartPreventExitStatus` (78 e
   stop), `SuccessExitStatus` sullo stop chiesto, watchdog `Type=notify`
   quando `systemd-notify` c'è, `KillMode=mixed`, `TimeoutStopSec` oltre il
   budget di drenaggio, control plane su Unix socket, processo sempre con
   l'UID dell'utente dedicato. PID 1 è autorità di supervisione soltanto.
3. **Segreti dietro il seam esistente.** Nessun secondo sistema di
   credenziali: `secret://` resta l'unico linguaggio, `readSecret` l'unica
   risoluzione, `secret-boundary.test.ts` invariato (nessun nuovo chiamante).
   Il flag esplicito `secrets.backend` (`file` di default, `systemd` solo per
   comando esplicito) sceglie il magazzino; indisponibilità = errore
   azionabile, mai fallback silenzioso ai file (D3).
4. **Provisioning.** `muffin secret set --systemd` / `muffin secret migrate
   --yes`: stdin → `sudo systemd-creds encrypt` (root solo dove serve la host
   key), mai argv/env/file in chiaro; round-trip di decrypt prima di
   cancellare il legacy; rollback che preserva la credenziale funzionante.
5. **Niente mezzi stati.** Non si mergia una Home Linux che pubblicizza
   credenziali cifrate ma usa i file in silenzio: la unit nomina solo i nomi
   provisionati, `doctor` mette in rosso le ombre in chiaro e l'assenza del
   blob, e la migrazione cancella il legacy solo dopo la prova.

## Alternative scartate

- **Restare user unit + file 0600.** Contraddice il requisito owner. Scartata
  per decisione, non per tecnica.
- **User unit + `LoadCredential` in chiaro da `/etc/credstore`.** Il manager
  utente legge la sorgente come utente: il file dovrebbe essere leggibile
  all'utente = plaintext con un passaggio in più. Teatro, non sicurezza.
- **Helper/broker privilegiato che serve segreti via socket (architettura B).**
  Realizzabile ma è un nuovo TCB con IPC da autenticare: fuori budget pre-21
  per decisione owner esplicita (niente B/C prima del 21).
- **Keyring del kernel / Secret Service headless.** Perso al reboot/scadenza
  senza bootstrap sbloccato (stesso problema secret-zero, senza il bus di
  sistema a risolverlo); GNOME Keyring headless richiede collezione
  sbloccata a ogni boot. Non unattended.

## Non-claim espliciti (D1/D2)

Stesse parole della decisione owner: same-UID = compromissione della Home,
root = compromissione della Home, furto dell'immagine completa (cifrato +
host key) NON protetto, mai "hardware-backed", nessuna protezione non
provata. La host key lega all'installazione OS, non all'hardware (niente
TPM su Hetzner).

## Cosa NON copre

- macOS launchd: invariato in questa slice.
- Rotazione senza restart: le credential si materializzano all'attivazione;
  dopo `secret set --systemd` serve `sudo systemctl restart`.
- `mcp add` con nuovo `secret://`: richiede rigenerare la unit
  (`--write --force`) + restart; `doctor` segnala la deriva.
- GPG/`.asc` sui tarball Node e full-disk-theft: fuori scope, come prima.
