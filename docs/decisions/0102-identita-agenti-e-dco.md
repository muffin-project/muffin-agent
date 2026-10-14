# ADR-0102 — Identità degli agenti e DCO

**Stato: adottato dall'owner il 14/10/2026.** Chiarisce per il lavoro prodotto
dagli agenti il perimetro dell'esenzione interna di ADR-0098. Non cambia la
licenza AGPL del repository né crea grant o certificazioni retroattivi.

## Contesto

Il commit `287c8ec2bf5badab512c7d584cd713d1b97ed248`, poi integrato in `dev`
con il merge di #891 (`7f54ac46a5c1c927802987e64b0faf67316d76f0`), è stato
creato come `Codex <codex@agent.invalid>` e contiene il trailer
`Signed-off-by: Codex <codex@agent.invalid>`. L'agente non poteva fare quella
certificazione. Il controllo CI ha accettato il trailer perché confrontava il
testo con autore ed e-mail Git. Il resoconto dell'errore e i suoi limiti sono
registrati in [evidenza DCO del 14 ottobre](../evidence/dco-agent-attribution-2026-10-14.md).

Il DCO 1.1 è una dichiarazione resa dal contributore; una stringa corrispondente
nei metadati Git non prova identità o veridicità. Il controllo meccanico deve
quindi rifiutare le firme di identità non umane conosciute e consentire il
lavoro delegato senza trasformarle in attestazioni.

## Decisione

- Gli agenti usano un'identità esplicitamente non umana con e-mail nel dominio
  riservato `agent.invalid`, per esempio `Codex <codex@agent.invalid>`. Non
  usano l'identità di una persona e non aggiungono `Signed-off-by`.
- Un commit con autore `@agent.invalid` è esente dal requisito DCO soltanto
  quando il PR è aperto dall'owner autenticato e sia base sia head appartengono
  al repository canonico. È lavoro interno delegato sotto la responsabilità
  dell'owner, non una certificazione dell'agente.
- Fuori da quel perimetro, un'identità `@agent.invalid` non può soddisfare il
  gate neppure con un trailer testualmente corrispondente. Le persone che
  contribuiscono mantengono la propria attribuzione e firmano soltanto quando
  possono rendere personalmente la dichiarazione richiesta dall'accordo. Se
  non possono, il contributo non viene inviato.
- I commit importati da persone diverse dall'owner conservano il requisito del
  loro sign-off, anche dentro un PR dell'owner. L'eccezione non riscrive la
  storia, non concede il grant aggiuntivo di relicensing e non certifica
  retroattivamente diritti.
- Il checker CI verifica l'intervallo esatto del PR e applica questa regola;
  non pretende di autenticare le persone o di valutare la verità delle loro
  dichiarazioni.

## Alternative e conseguenze

Continuare a firmare i commit con l'identità dell'agente fa apparire il gate
verde ma attribuisce una dichiarazione a un soggetto che non può renderla.

Rimuovere ogni esenzione imporrebbe al founder di firmare per conto dell'agente
oppure di rinominare i commit come se fossero stati scritti dalla persona;
entrambe le opzioni confondono provenienza e attestazione. L'esenzione limitata
al PR interno dell'owner conserva l'autore agente e lascia intatti i requisiti
per i contributori esterni.

Il trailer storico di #891 resta nel commit pubblico e non diventa valido per
effetto di questa decisione. La correzione rende il fatto esplicito e impedisce
che nuovi commit con identità agente passino come firmati nel percorso esterno;
non modifica la history protetta.

## Falsificatore e reversibilità

Un fixture con `Codex <codex@agent.invalid>` deve fallire nel gate ordinario
anche se porta una firma testualmente corrispondente, passare senza firma solo
nel PR canonico aperto dall'owner, e non esentare un autore agente importato da
un fork. Se il metadato autenticato del PR non distingue questi casi, il gate
deve fallire chiuso. Una diversa regola di diritti o relicensing richiede una
nuova decisione e nuove autorizzazioni dei titolari; questa ADR non le concede.
