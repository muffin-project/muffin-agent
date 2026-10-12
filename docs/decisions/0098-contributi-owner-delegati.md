# ADR-0098 — Contributi interni delegati dall’owner

**Stato: accettato dall’owner il 12/10/2026.** Modifica l’ambito del gate di
ADR-0079 e supera la proposta universale di ADR-0097. AGPL, DCO 1.1 e grant
aggiuntivo verso licenze OSI rimangono per i contributi esterni.

**Contesto.** Il gate universale bloccava le PR interne e richiedeva nuove
attestazioni manuali sul singolo diff prodotto dagli agenti. La verifica
meccanica di un trailer non prova diritti o identità. Il confronto peer e le
alternative sono registrati in `../evidence/contribution-friction-2026-10-12.md`.
L’owner ha confermato di voler preservare un futuro passaggio verso MIT.

**Decisione.** Il lavoro interno attribuito all’owner, anche quando delegato
esplicitamente agli agenti, non richiede una nuova attestazione DCO per diff.
Il checker usa il metadata dell’evento PR GitHub: autore PR owner e repository
canonico sia per base sia per head. Controlla i commit dell’esatto intervallo
base/head; il confronto del nome normalizza spazi e maiuscole per le due
attribuzioni pubbliche dell’owner (nome e login). I commit attribuiti ad altri autori richiedono ancora il loro
sign-off. Fork, altri autori PR e intervalli Git senza evento verificabile
mantengono il controllo ordinario. La promozione canonica dev → main conserva
l’eccezione già prevista. Review, CI e protezioni dei rami non cambiano.

**Limiti.** Il nome autore è un filtro di attribuzione, non autenticazione o
prova di copyright. L’eccezione si fonda sulla responsabilità dell’owner che
controlla la PR. Non autorizza a riattribuire lavoro esterno, né certifica vecchi
commit, diritti sul codice generato o grant mai concessi. Il permesso aggiuntivo
per cambiare licenza copre soltanto contributi per cui è stato validamente
concesso. La copertura storica va verificata prima di cambiare licenza.

**Alternative.** Conservare il gate universale mantiene l’attrito misurato.
Eliminare ogni accordo esterno semplifica oggi ma rinuncia al grant aggiuntivo
che preserva il passaggio futuro da AGPL a MIT. Un nuovo bot o registro CLA
aggiungerebbe un meccanismo non necessario per il blocco interno osservato.

**Reversibilità.** Il confine del gate può essere cambiato con una nuova
decisione; nessuna modifica crea diritti retroattivi.
