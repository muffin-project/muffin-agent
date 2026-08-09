# ADR-0013 — Kernel di permessi unificato (capability + scope + taint)

**Contesto.** Domanda aperta №6: un'unica astrazione per tool interni, tool esterni, azioni di sistema e capability dei tenant, o modelli separati? Prior art interno: HITL a 3 livelli + zone + tier-2 act-notify-undo (validato). Prior art esterno: Progent (policy simboliche su nome+argomenti, confinamento monotono), CaMeL (capability sul flusso dati al momento della chiamata). Consenso OWASP: l'injection non si previene nel prompt — si contiene all'esecuzione.

**Decisione.** Un'unica funzione di decisione, deterministica, nel RoT: `decide(principal, tenant, capability, resource, args, taint) → ALLOW | ASK | DRAFT | DENY`. Ogni tool (interno, MCP, di sistema, del tenant) dichiara le proprie capability con classe di rischio, risorse, taint massimo, reversibilità. I tre livelli HITL storici diventano *esiti* della policy. Restrizioni auto-strigibili, allargamenti solo con approvazione (confinamento monotono). Snapshot di permessi calcolato nel pre-loop, immutabile per il turno.

**Alternative scartate.** *Modelli separati per natura* (HITL per i tool, ACL per i tenant, sandbox per il sistema): tre linguaggi di sicurezza = tre superfici di errore e nessuna risposta unica a "cosa può fare questo turno?". *Enforcement nel prompt*: architetturalmente insufficiente (consenso di campo). *Sandbox OS completa per ogni azione*: costo enorme, e il problema dominante è *quale* azione, non *come* isolarla.

**Conseguenze.** Più facile: audit ("perché è stato negato?" = una riga di trace), estendere al system layer post-v1 (stessa astrazione), ragionare sulla community (capability dei tenant = stesse regole). Più difficile: ogni tool nuovo paga il costo della dichiarazione (è il prezzo del contenimento; un tool senza dichiarazione non esiste per il runtime).

**Reversibilità.** Bassa — è il cuore del contenimento e tutto vi si appoggia: cambiarla dopo = ri-audit completo. Per questo è nel RoT e si decide ora. Segnale che era sbagliata: proliferazione di bypass "temporanei" nella matrice (la policy non esprime ciò che serve) o Fase C che trova percorsi non mediati dal kernel.
