# ADR-0101 — L'estrazione non certifica la dichiarazione

Stato: adottato per la correzione di attribuzione del 14 ottobre 2026.
Amenda l'assunzione della pipeline di estrazione e il fissaggio automatico
dell'identità; conserva il modello di Evidence e Beliefs di ADR-0049 e ADR-0051.

L'episodio autenticato contiene ciò che l'owner ha detto. Il fatto strutturato
prodotto dal modello è un'interpretazione, anche quando è accurata. La richiesta
nel prompt di non inferire non può certificare la corrispondenza semantica.
Usiamo quindi l'origine `inferred` già presente, mantenendo il riferimento e il
trust dell'episodio. Origine e trust sono assi distinti: una deduzione su parole
dell'owner può conservare tier 0 senza diventare una dichiarazione dell'owner.

Rimuoviamo il fissaggio automatico dei predicati identitari. Un successore può
ereditare il fissaggio solo se la sua provenienza soddisfa le condizioni del
writer: dichiarazione e trust dell'owner, non una deduzione o un messaggio meno
fidato. Il fissaggio esplicito dell'owner resta disponibile anche su un fatto
dedotto. Le correzioni attraversano ancora la riconciliazione canonica, con
evidenza e storia consultabili.

La conseguenza concreta è che anche le estrazioni corrette non entrano da sole
nel profilo incondizionato. Restano richiamabili con l'attribuzione della
deduzione. Non riclassifichiamo retroattivamente fatti personali o fissaggi
esistenti e non chiediamo un'approvazione aggiuntiva per ogni memoria.

Un verificatore semantico o l'eliminazione dell'estrazione possono migliorare la
qualità, ma richiedono il confronto già previsto con la ricerca della storia.
Questa decisione corregge l'attribuzione; non promette di eliminare i fatti
sbagliati né decide un nuovo servizio di consolidamento.

Alternative, controtesi e falsificatori:
[evidenza del 14 ottobre](../evidence/extraction-provenance-2026-10-14.md).
