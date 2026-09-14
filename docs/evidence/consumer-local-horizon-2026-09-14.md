# Consumer-local task horizon — 2026-09-14

## Misura e decisione

Un turno sul profilo `consumer-local` si è chiuso dopo aver consumato il limite
di 15 tool call e 120 secondi di attività modello. Il tentativo successivo è
stato rifiutato dal runtime e il turno non ha prodotto una risposta conclusiva.
È una riproduzione diretta del fallimento descritto nello studio precedente;
non conserviamo qui transcript, identificativi o dati privati dell’installazione.

Per i modelli `consumer-local` il tetto numerico delle tool call diventa
facoltativo e viene disattivato (`null`). L’orizzonte cumulativo sale a 15
minuti sia di attività modello sia di tempo totale del turno, così un compito
con più fasi può arrivare alla risposta finale. Il limite di 90 secondi per
singola chiamata, il rilevamento di stalli, l’abort dell’owner, il budget
monetario e i permessi per azione restano attivi. I profili `frontier` e
`conservative` conservano i rispettivi limiti numerici.

## Alternative considerate

- Eliminare limiti di tempo e di spesa: respinto; un turno potrebbe consumare
  risorse indefinitamente.
- Aumentare soltanto il numero massimo di tool call: respinto dopo la
  chiarificazione dell’owner; sarebbe un altro tetto arbitrario e non
  consentirebbe sessioni autonome da 10–15 minuti.
- Sospendere e riprendere automaticamente a ogni soglia: resta una possibile
  evoluzione, ma richiede un limite alle continuazioni e un eval del flusso
  durevole. Non serve per il requisito corrente di un singolo turno lungo.

Il precedente studio del loop distingue guardrail dell’harness, budget e
sospensione durevole: [`orizzonte-del-turno-2026-09-03.md`](./orizzonte-del-turno-2026-09-03.md).
Le soglie monetarie per tenant e per giorno restano l’ultima difesa contro un
turno costoso.

## Cosa falsificherebbe la scelta

Se i turni consumer raggiungono spesso 15 minuti, se il budget giornaliero
interrompe compiti legittimi o se la spesa cresce oltre quanto l’owner accetta,
misurare l’orientamento ripetuto e valutare una continuazione durevole con un
eval prima di aumentare ancora l’orizzonte.
