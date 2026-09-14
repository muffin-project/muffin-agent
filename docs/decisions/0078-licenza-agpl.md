# ADR-0078 — Licenza AGPLv3-or-later

**Contesto.** Decisione owner 14/09/2026, ultima finestra a costo zero prima del
source-public 25/09. Supera ADR-0019 (MIT). Gli obiettivi registrati in #464 sono,
in ordine: adozione massima; uso aziendale non bloccato; fork/sperimentazione
liberi; **nessun terzo che impacchetta/hosta Muffin come prodotto concorrente
senza permesso**; marchio protetto separatamente dal copyright.

**Decisione.** **AGPL-3.0-or-later** per il codice del repo (`LICENSE` è il testo
ufficiale verbatim, SPDX `AGPL-3.0-or-later` in `package.json`). Documentazione
sotto la stessa licenza (nessun doppio regime). Il "or-later" tiene aperta la via
di aggiornamento alle future versioni AGPL senza dover chiedere il consenso a
tutti in futuro; senza, anche quel passo richiederebbe ogni autore.

**Perché non GPLv3** (ipotesi scartata esplicitamente). Il copyleft scatta sulla
*distribuzione*; far girare Muffin come servizio hosted non è distribuzione
(loophole ASP), quindi un concorrente potrebbe hostarlo senza pubblicare una riga.
GPLv3 farebbe pagare il costo di adozione del copyleft senza chiudere il buco che
motiva il cambio. AGPL chiude quel buco: l'uso in rete obbliga a offrire il
sorgente corrispondente. Non *vieta* l'hosting concorrente — nessuna licenza OSI
può farlo — ma lo rende costoso da parassitare.

**Perché non MIT/Apache** (mantenimento dello status quo, scartato). Non mordono
né sulla distribuzione proprietaria né sull'hosting: l'obiettivo (d) resterebbe
affidato solo a brand e velocità. **Perché non source-available** (SSPL/BSL,
scartato). Otterrebbe (d) ma non è open source OSI: ucciderebbe la promessa del
25/09 e l'obiettivo (a).

Conseguenze pratiche che vincolano il codice:
- **Compatibilità delle dipendenze, invertita rispetto a ADR-0019**: sotto AGPL le
  dipendenze permissive (MIT/Apache/BSD/ISC) restano tutte usabili inbound, e le
  dipendenze copyleft (GPL/AGPL/LGPL) diventano usabili dove prima erano vietate.
  Resta vietato il proprietario/sconosciuto. **Correzione di un drift**: ADR-0019
  prometteva una verifica in CI (`license-checker` con allowlist) che non è mai
  esistita — nessun file di CI la implementava. Ora esiste davvero:
  `scripts/check-dep-licenses.mjs` + step `licenze delle dipendenze` in
  `.github/workflows/ci.yml` (ereditato da `ci:local`, quindi dal merge gate).
  Fallisce su proprietario/`UNLICENSED`/mancante; il copyleft è segnalato, non
  fallito.
- **Modelli e pesi non sono codice** (invariato da ADR-0019): si configurano, non
  si redistribuiscono.
- **Contenuto personale fuori dal repo** (invariato, ADR-0011): AGPL copre il
  codice, non i dati dell'utente.
- **Marchio fuori dal grant**: nome e logo non sono coperti dalla licenza, vedi
  `TRADEMARK.md`. Registrazione rinviata per budget; first-use evidence raccolta
  dal 14/09 (annuncio) + 25/09 (flip).
- **Niente CLA, ma con un costo registrato**: i contributi entrano sotto
  AGPL-3.0-or-later (nota in `CONTRIBUTING.md`). Senza CLA, un futuro "relax" delle
  restrizioni richiederà il consenso di ogni autore esterno o la riscrittura delle
  sue parti — ogni PR mergiata senza accordo inbound alza quel prezzo. Prima di
  accettare contributi esterni post-25 serve la decisione DCO-minimale vs CLA-light
  con clausola di relicense (tracciata nel piano source-public §1.1, non qui).

**Conseguenze.** Più facile: chi hosta contribuisce indietro; deterrenza sui cloni
parassitari; patent grant esplicito. Più difficile: chill sull'adozione aziendale
(alcune policy vietano AGPL anche per uso interno); contributori corporate
rallentati.

**Reversibilità.** **Irreversibile per il codice già pubblicato** (come ADR-0019
per MIT): una release AGPL resta AGPL per sempre. In avanti si può solo
*allargare* (con il consenso di tutti gli autori dal primo contributo esterno) o
restringere il futuro. Segnale che era sbagliata: l'adozione misurata mostra che
il copyleft blocca gli utenti che volevamo, non i parassiti che temevamo.
