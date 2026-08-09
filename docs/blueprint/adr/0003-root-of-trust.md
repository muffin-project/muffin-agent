# ADR-0003 — Root of Trust: contenuto e meccanica

**Contesto.** L0-2 (self-modifying) e L0-3 (RoT) collidono se il confine non è strutturale. Prior art: nessuno degli 8 peer ha un RoT immutabile a runtime; i surrogati procedurali (Hermes: `--apply`; approvazioni "always" eterne) derivano; il RoT-implicito di OpenClaw ("chi scrive sul filesystem è operatore") è la causa della sua storia CVE (A2).

**Decisione.** RoT = insieme minimo, nominato: (1) kernel di policy + capability registry; (2) matrice permessi e trust-ladder; (3) egress allowlist; (4) `identity.md`; (5) budget caps e quiet-hours; (6) suite eval di riferimento del cricchetto; (7) il meccanismo di update. Vive in `~/.muffin/rot/`, **read-only per il processo agente via permessi OS** (utente/gruppo separato), hash verificato al boot (boot rifiutato su mismatch). Modifica solo via repo→install+riavvio, con conferma owner. L'agente può leggerlo e proporne modifiche via PR.

**Alternative scartate.** *Enforcement crittografico (firma/TPM)*: protegge da un avversario (host compromesso) dichiarato fuori scope; complessità non pagata dal threat model. *RoT solo procedurale (flag, conferme)*: l'evidenza dei peer mostra che deriva. *RoT più grande (tutto il codice)*: ucciderebbe L0-2 — il punto è rendere sicuro il self-modifying, non impedirlo.

**Conseguenze.** Più facile: ragionare su cosa l'agente può toccare (tutto ciò che non è RoT, coi gate del cricchetto); audit del confine. Più difficile: ogni modifica al RoT ha attrito deliberato (install+riavvio) — è il prezzo del contrappeso.

---

## Revisione 2026-08-04 (owner: "vediamo bene se ha senso farlo così"; C1-2, C2-#1)

Il concetto resta — senza una parte che il loop non può cambiare, "self-modifying" e "sicuro" non coesistono (L0-3). Cambia il *meccanismo*, che era più pesante del necessario in un punto e più fragile del dichiarato in un altro.

**1. Il RoT si divide in due tier, con protezioni diverse per natura.**
- **RoT-codice** — kernel di policy, capability registry, verificatore. Sono **codice nel repo**, non file di configurazione: cambiarli richiede build + riavvio, non una scrittura a runtime. La protezione giusta non è `chmod`: è che **non esista un write-path**, verificato da un test (nessuna capability scrive in quei path) e dal CODEOWNERS sulle PR (C1-9). Nessun meccanismo di file-integrity serve qui.
- **RoT-dati** — matrice permessi, egress allowlist, budget e quiet-hours, `identity.md`, suite eval di riferimento, profili sandbox. Sono file in `~/.muffin/rot/`, e sono gli unici che hanno bisogno di manifest + hash + anchor (09 §4).

Questo dimezza la superficie del meccanismo: metà del RoT non ha bisogno di alcuna protezione di filesystem, perché non è un file che qualcuno modifica.

**2. Safe mode invece di rifiuto del boot** (default single-user). Il rifiuto di partire su mismatch d'hash era ostile nel caso più probabile: l'owner che edita `identity.md` a mano. Nuovo comportamento: hash divergente → il runtime **parte in safe mode** (nega ogni capability ≥ media, continua a rispondere e a spiegare cosa è cambiato, elenca i file divergenti) invece di lasciare l'owner senza agente. In modalità **hardened** (VPS, utente di servizio separato) resta il rifiuto: lì nessuno edita a mano e una divergenza è un incidente.

**3. `muffin rot reseal`** — comando esplicito che ri-sigilla manifest e anchor dopo una modifica legittima dell'owner. Senza, ogni edit manuale avrebbe fatto sembrare l'owner un attaccante: il RoT significa "il loop agentico e i tenant non possono cambiarlo", **non** "immutabile in assoluto". L'owner resta sovrano, ma deve dirlo esplicitamente.

**4. L'utente OS separato è opt-in, non prerequisito** (`--hardened`). Prevenzione reale, ma provisioning divergente tra macOS e Linux e privilegi che l'installazione consumer non ha. Default = rilevazione + `sys.shell` permanentemente ASK, dichiarato a ogni boot. La postura di sicurezza si dichiara per quello che è, in entrambe le modalità.

**5. Difendere la piccolezza.** Il RoT è utile finché è enumerabile a memoria. Ogni aggiunta futura richiede una riga di giustificazione nell'ADR: se cresce oltre una decina di voci, ha smesso di essere un root of trust ed è diventato un file di configurazione con delle pretese.

**Reversibilità.** Il *contenuto* del RoT è rivedibile a costo basso (è una lista); il *meccanismo* (permessi OS + hash) a costo medio. Segnale che era sbagliato: modifiche legittime al RoT così frequenti che l'attrito domina (allora qualcosa è nel RoT che non doveva starci), o bypass trovati in Fase C/red-team (il confine era poroso).
