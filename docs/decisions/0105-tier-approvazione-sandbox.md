# ADR-0105 — Tiers di approvazione: il confine sandbox sostituisce il prompt (proposto)

**Stato: proposto · richiede ratifica owner.** Cambia un confine di sicurezza
(SECURITY §12): in `single-user` senza harden, `sys.shell` chiede oggi sempre.
Questa decisione lo conferma come default ma introduce tiers espliciti sotto
controllo owner. Non adottata finché l'owner non ratifica.

## Contesto e research

267 approval misurate sull'installazione dell'owner, 91% shell, 10 deny: il
prompt-per-shell è un riflesso, non un giudizio (stessa misura Anthropic:
93% di approvazioni, approval fatigue documentata). SOTA concorde:

- **Claude Code auto mode + sandbox auto-allow**: il boundary sandbox
  *sostituisce* il prompt (comandi sandboxed auto-approvati), mai il contrario;
  deny espliciti e critical path (`rm -rf /`, home) chiedono sempre; classifier
  leggero per l'ambiguo; allow/deny list owner; deny vince su tutto.
- **Windsurf Off/Auto/Turbo**: Off chiede (tranne allow-list), Auto decide il
  modello per sicurezza, Turbo tutto tranne deny-list; deny-list ad admin max.
- Controtesi: il classifier sbaglia (17% miss misurati); la sandbox richiede
  manutenzione per capacità; nessun tier copre exfil mirata meglio dell'occhio.

Muffin ha già i pezzi: sandbox Seatbelt/bwrap reale, lane light come
giudice-ombra, `/yolo` come delega esplicita, deny/ask nel kernel.

## Decisione proposta

Tre tiers, owner-configurati, deny vince sempre:

1. **Allow-list esplicita** (owner, nel config): comandi/pattern nominati
   girano senza prompt. Mai wildcard su interpreti (`python`, `node`) né
   package-manager run — erediterebbero esecuzione arbitraria.
2. **Sandbox auto-allow**: comandi interamente contenuti nel boundary sandbox
   girano senza prompt. Il confine sostituisce la domanda, come Claude Code.
3. **ASK + classifier light**: tutto il resto chiede come oggi; su richiesta
   esplicita dell'owner, la lane light pre-valuta e propone (mai decide).

Restano sempre prompt: deny espliciti, critical path, comandi fuori sandbox,
irreversibili ad alto impatto (deploy/pagamenti/invii/cancellazioni),
`--env` con valori, host fuori allowlist. `/yolo` resta la delega esplicita
per lavoro (ADR-0095), mai attivabile dal modello.

## Alternative scartate

Tutto-auto senza boundary (bypass): zero manutenzione, zero protezione.
Tutto-ask per sempre: è lo status quo che ha prodotto il 91%. Classifier
senza sandbox: giudizio senza contenimento.

## Falsificatore

Traccia di approvazioni: con tiers attivi, prompt/turno calano senza che
aumentino effetti irreversibili non approvati; un comando deny-listato o
critical-path non passa mai silenzioso (test di mutazione sul cancello).
Se un tier fa passare un irreversibile, il tier si disattiva (fail-closed),
non si allarga.
