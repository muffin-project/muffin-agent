# ADR-0019 — Licenza MIT

**Contesto.** Il progetto è insieme strumento personale e artefatto pubblico rivolto a sviluppatori. L'owner ha deciso: MIT, e non prevede una versione commerciale. Le implicazioni tecniche non sono neutre, quindi vanno messe a verbale una volta sola.

**Decisione.** **MIT** per il codice del repo. Documentazione sotto la stessa licenza (nessun doppio regime tipo CC-BY: complica senza beneficio per un progetto di una persona).

Conseguenze pratiche che vincolano il codice:
- **Compatibilità delle dipendenze**: MIT non può includere codice GPL/AGPL. Vincolo operativo concreto — nessuna dipendenza GPL/AGPL nel repo. Verifica in CI (`license-checker` con allowlist MIT/Apache-2.0/BSD/ISC); una PR che introduce una dipendenza copyleft fallisce.
- **Modelli e pesi non sono codice**: la licenza del repo non tocca la licenza dei modelli. Un modello con licenza restrittiva (es. Llama Community License) resta usabile *dall'utente* ma non va mai vendorizzato né presentato come parte del progetto: si configura, non si redistribuisce.
- **Contenuto personale fuori dal repo**: identità, prompt personalizzati, memoria e vault vivono in `~/.muffin/` (ADR-0011) — MIT copre il codice, non i dati dell'utente, e il confine è già architetturale.
- **Niente CLA**: per un progetto MIT di una persona un Contributor License Agreement è attrito senza ritorno. I contributi entrano sotto la stessa MIT (nota in `CONTRIBUTING`).

**Alternative scartate.** *AGPL-3.0*: massimizza il ritorno alla comunità e impedisce a un SaaS di forkare e chiudere — ma raffredda l'adozione (molte aziende vietano AGPL anche per uso interno) e, senza intenzione commerciale, protegge da un rischio che l'owner non corre. *Apache-2.0*: praticamente equivalente a MIT con in più la clausola di brevetto — motivo reale ma marginale qui, e paga con un file di licenza che nessuno legge; MIT è la più leggibile e la più diffusa in questo spazio (OpenClaw e Hermes sono MIT). *Dual-license*: senza piani commerciali è complessità pura.

**Conseguenze.** Più facile: adozione, fork, uso in contesti aziendali; nessuna domanda legale da parte di chi prova il progetto. Più difficile: se un domani nascesse un'idea commerciale, MIT non offre leva — chiunque può offrire il servizio senza restituire nulla. Reversibilità asimmetrica: si può ri-licenziare *in avanti* solo il codice futuro, mai revocare ciò che è già uscito sotto MIT.

**Reversibilità.** **Praticamente irreversibile per il codice già pubblicato** (una release MIT resta MIT per sempre, chiunque può forkarla da quel commit). È l'unica decisione del blueprint con questa proprietà — il costo di cambiare idea non è tecnico ma definitivo. Segnale che era sbagliata: comparsa di un'intenzione commerciale reale (non ipotetica) prima della prima release pubblica — che è anche l'ultima finestra in cui cambiarla costa zero.
