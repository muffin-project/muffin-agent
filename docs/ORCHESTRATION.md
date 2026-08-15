
## 11. Cosa significa «chiuso»

Direttiva owner, 2026-08-15, e sostituisce ogni uso più permissivo della parola
in questo repo. **Un test verde non è «chiuso».**

Chiuso è, per ogni voce di lavoro:

| | |
|---|---|
| implementazione | il codice esiste |
| unit test | la logica è provata in isolamento |
| **integration test** | provata attraverso i confini, non nei mock |
| **cablaggio in produzione** | il percorso reale ci arriva — non solo i test |
| **percorso di fallimento** | cosa succede quando non funziona, e chi lo dice |
| **scenario di accettazione reale** | eseguito come lo eseguirebbe l'owner |
| documentazione · `STATE.md` | ciò che è cambiato è scritto dove si cerca |

Le due righe in mezzo sono quelle che questo repo salta, e sono la ragione per
cui esiste una famiglia di difetti chiamata *dichiarato e non collegato*: un
`decideProactive` con zero chiamanti aveva unit test verdi, e una allowlist
egress con i suoi test verdi non è mai entrata in funzione in produzione.

È la stessa disciplina che il giudice applica al codice: non che sembri
corretto, ma che **la garanzia sia raggiungibile dal percorso vero**.

## 12. Un inventario, non una lista di feature

Quando l'obiettivo è «siamo pronti?», la forma giusta non è l'elenco di ciò che
si vuole costruire — quello parte da come è fatto il codice. È un **inventario
di domande**, che parte da cosa serve a chi lo usa, e in cui **ogni voce ha una
di tre risposte**: `READY`, `FUORI DALLO SCOPO` con la ragione scritta, o
`BLOCKER`.

> **La quarta categoria — «non ci avevamo pensato» — è quella che produce le
> fasi di recupero.** Un inventario esiste per renderla impossibile: se emerge
> una lacuna nuova non si nasconde, si aggiunge.

L'inventario vivo è `docs/blueprint/M5-BIS.md`.
