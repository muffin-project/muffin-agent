# ADR-0079 — Contributi: DCO + relicense verso licenze OSI

**Contesto.** Il 14/09/2026 l'owner ha scelto AGPL-3.0-or-later (ADR-0078) con
l'intenzione di poter allentare il copyleft se l'evidence dell'adozione lo
giustifica. Dopo il source-public, senza un accordo inbound, ogni autore esterno
conserva un veto pratico su quel futuro cambio: servono tutti i consensi oppure
la riscrittura delle loro parti.

**Decisione.** Ogni PR esterna deve avere ogni commit firmato con `git commit
-s`. `CONTRIBUTOR_AGREEMENT.md` incorpora verbatim il Developer Certificate of
Origin 1.1 e aggiunge un grant stretto, non esclusivo e senza assignment, che
permette al project owner di relicenziare il contributo solo sotto una licenza
open source approvata OSI. Il merge gate esegue `scripts/check-dco.ts` prima di
costruire il risultato integrato; per non bloccare retroattivamente i rami
dell'owner, applica il controllo agli autori PR diversi da `GiustoPiedimonte`.

**Alternative scartate.** Solo DCO: attrito minimo ma non risolve il consenso
per il relax futuro. CLA completo: più garanzia e possibilità di dual/proprietary
license, ma troppo attrito per source-public/pre-alpha e più potere del necessario.
Nessun accordo: trasferisce il costo del presente al primo futuro cambio licenza.

**Conseguenze.** La firma non prova crittograficamente identità o ownership: è
un'attestazione pubblica e verificabile meccanicamente nel commit. Il grant non
autorizza una licenza proprietaria né l'uso del marchio. Il nome dell'owner nel
controllo è un bootstrap esplicito per i commit pre-policy; prima di aggiungere
un altro maintainer con write bisogna decidere se farlo firmare come contributor
o estendere il set in una nuova decisione.

**Reversibilità.** La policy si può cambiare in avanti, ma non crea retroattivamente
un grant sui contributi che non l'hanno accettata. Segnale che è troppo stretta:
contributori legittimi non possono accettare il grant OSI-only; allora valutare un
CLA con percorso aziendale, non eliminare il controllo in silenzio.
