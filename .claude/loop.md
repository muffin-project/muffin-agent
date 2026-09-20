# Manutenzione della sessione

Questo è il prompt di un `/loop` nudo: **manutenzione periodica**, non il metodo
di sviluppo. Per orientarti e scegliere una claim usa `/riprendi`; per chiudere
una claim con un criterio terminale usa `/goal`.

Ogni giro, in quest'ordine, e solo questo:

1. `node .claude/deleghe.mjs riprendi` — deleghe aperte, morte o parcheggiate.
   Una delega morta si parcheggia con stato riprendibile, non sparisce.
2. `node .claude/riconcilia.mjs` — se il handoff descrive come vivo un lavoro
   chiuso, correggi `docs/development/handoff.md`, non il checker.
3. I check delle PR aperte. Un rosso che ha eseguito step è un difetto; un rosso
   a zero step non lo è.

**Fermati da solo.** Se non c'è niente in sospeso, dillo in una riga e chiudi il
loop (`ScheduleWakeup` con `stop: true`). Idem quando l'unico lavoro rimasto è
dell'owner — un segreto, un pagamento, una PR che mergia lui. Un loop che
continua dopo essere arrivato non prova di essere arrivato: nasconde che non lo è.

**Non aprire lavoro nuovo qui.** Se trovi qualcosa che merita una slice,
scrivilo nel handoff e fermati: sceglierlo è il mestiere di `/riprendi`.
