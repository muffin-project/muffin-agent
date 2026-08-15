<!--
  Questo template esiste per una riga sola di docs/ORCHESTRATION.md §3:
  «un subagente che dice di aver fatto non è evidenza» — e non vale solo per i
  subagenti. Una PR che afferma non è una PR che dimostra.

  Cancella le sezioni che non servono. Non cancellare "Come l'ho verificato".
-->

## Cosa non funzionava

<!-- Il difetto, non la feature. Se la riga giusta è "mancava X", scrivi cosa
     costava che mancasse. Chi legge fra sei mesi deve capire perché valeva. -->

## Come l'ho verificato

<!-- Evidenza, non affermazioni. Il comando eseguito e il suo esito, non "i
     test passano". Se c'è un test nuovo: è stato visto FALLIRE prima del fix?
     Se hai misurato qualcosa, il numero va prodotto nello stesso respiro in
     cui lo scrivi, non ricordato. -->

- [ ] `npx tsc --noEmit` pulito
- [ ] `npx vitest run` verde (quanti test: ___)
- [ ] Il test nuovo è stato visto rosso prima del fix
- [ ] Se tocca il comportamento a runtime: eseguito davvero, non solo testato

## Decisioni prese qui

<!-- Se questa PR decide qualcosa (§2 di ORCHESTRATION.md), dillo. Una scelta
     architetturale reversibile presa dentro una PR va nominata, non nascosta
     nel diff. Se la classe è irreversibile / prodotto / sicurezza / modello
     dati, quella decisione non si prende in una PR: si porta all'owner prima. -->

## Cosa resta aperto

<!-- Quello che hai trovato e NON hai chiuso, con la ragione. Un difetto noto e
     scritto è debito; un difetto noto e taciuto è una trappola per il
     prossimo. -->
