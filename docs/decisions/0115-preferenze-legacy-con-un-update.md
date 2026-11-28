# ADR-0115 — Le preferenze leggibili nel patto precedente seguono l’aggiornamento

**Stato:** proposta verificabile. Modifica il caso di transizione di ADR-0112
quando la copia precedente contiene il default registrato seguito da preferenze.

Un aggiornamento costruisce una nuova release ed è inizialmente eseguito da
quella precedente. La selezione del patto avviene alla costruzione del prompt
della release nuova, in sola lettura. La release cerca la base registrata
nella propria storia Git locale. Se può ritrovare tutta la base con la stessa
impronta e il testo scritto per il modello risulta identico, seguito da un
paragrafo separato di preferenze entro il tetto esistente, carica la
fondazione nuova e quelle preferenze nella stessa struttura già usata per
l’overlay privato. Lo stato lo indica. I file restano al loro posto.

Una copia sostitutiva, una modifica interna, una base irricostruibile e
un’appendice troppo lunga continuano a usare il patto precedente. In questi
casi l’owner deve scegliere quali indicazioni del suo patto far convivere
con la fondazione nuova. Un `user.md` presente resta la fonte esplicita
delle preferenze. Il nuovo updater mostra l’esito della release installata.
Un updater già installato termina ancora con il proprio codice. Al primo
passaggio il nuovo runtime indica il conflitto all’avvio e in `muffin status`,
e lo può spiegare nel dialogo privato sull’identità. Il comando di migrazione
assistita può salvare un’appendice verificata già in uso, mentre lascia attivo
un patto riscritto anche con `--apply`.

La scelta evita sia un’euristica che assegna arbitrariamente al prodotto o
all’owner singole righe di una riscrittura, sia una migrazione a scrittura
che il vecchio updater non eseguirebbe al primo aggiornamento. Ricostruire
la base richiede solo il checkout locale. Il test di accettazione è un
aggiornamento reale della linea dev in una home isolata, con una copia
personalizzata prima dell’aggiornamento. Il profilo è CRITICAL perché
cambia la precedenza delle istruzioni persistenti.
