# I file copiati a `init` non tornano mai indietro (26/08/2026)

`muffin update` aggiorna il codice. Non aggiorna i file che `init` ha copiato
dentro `~/.muffin`, e non deve: `defaults/` esiste **per essere modificato
dall'owner** (`agent/context/assemble.ts` lo dice a chiare lettere). Un update
che sovrascrive distruggerebbe modifiche vere.

La conseguenza però non era stata guardata: su un'installazione che vive da
settimane, quei file restano a com'erano il giorno dell'`init`, e nessuno lo
dice.

## Misurato sull'installazione dell'owner

Ogni file confrontato per **hash**, contro HEAD e contro ogni versione spedita
nella storia di Git:

| file | stato | corrisponde a |
|---|---|---|
| `persona.md` | vecchio | `98b3955`, 09/08 |
| `voice.md` | vecchio | `285b65d`, 09/08 |
| `rot/identity.md` | vecchio | `ba6a74d`, 10/08 |
| `rot/policy.json` | vecchio | `d398f6d`, 11/08 |
| `rot/egress.json` | **aggiornato** | HEAD |
| `rot/budgets.json` | vecchio | `c80fdf9`, 04/08 |

Nessuno dei sei corrisponde a una versione *mai spedita*: combaciano tutti
esattamente con un commit. Quindi **l'owner non ne ha modificato nessuno** —
non è divergenza voluta, è un aggiornamento che non è mai avvenuto.

## Quali di questi contano davvero

Un elenco di date fa paura più di quanto informi. Il diff dice altro.

**`rot/policy.json` e `rot/budgets.json`: nessuna differenza funzionale.**
`budgets.json` diverge solo nel `_comment`. `policy.json` diverge nel
`_comment` e per una chiave assente, `paramsMaxTaint` — che `matrix.ts` risolve
con `file.paramsMaxTaint ?? POLICY_FLOOR.paramsMaxTaint`, cioè **2**, esattamente
il valore che HEAD spedisce nel file. Il ceiling effettivo è identico. Il
fallback ha fatto il suo lavoro: è la ragione per cui questa riga è una nota e
non un allarme.

**`egress.json`**: già a HEAD.

**`persona.md`, `voice.md`, `rot/identity.md`: deriva vera, e grossa.** Il
prompt owner assemblato da HEAD misura 22.477 caratteri; quello che gira sulla
macchina dell'owner ne misura **11.498**. La persona approvata dall'owner il
17/08 (`c090dce`, A2/A3) **non è mai arrivata all'agente che gira**: da nove
giorni esegue metà del prompt che gli è stato scritto.

Vale la pena notare cosa questo spiega. `rot/identity.md` è stato «riempito per
la prima volta» proprio il 17/08 — e la macchina ha la versione vuota del
10/08. Il fatto che l'agente non sapesse chi fosse l'owner, chiuso l'11 e il
26/08 riempiendo di fatti il database (migrazione 3, #122), aveva anche questa
seconda causa, che non era stata guardata.

## Cosa serve, e cosa NON serve

Non serve sovrascrivere a ogni update: cancellerebbe le modifiche dell'owner,
che sono il motivo per cui quei file stanno lì.

Serve **distinguere** «vecchia versione spedita, mai toccata» da «modificato
dall'owner», perché solo la prima si può adottare senza perdere niente. Due
strade, in quest'ordine:

1. **Registrare l'hash a `init`.** Al momento della copia, scrivere l'hash di
   ciò che è stato copiato. Poi: hash uguale a quello registrato → mai toccato,
   adottabile; hash diverso → è dell'owner, non si tocca. Non richiede la
   storia di Git e funziona su qualsiasi installazione.
2. **Per le installazioni che esistono già** — che non hanno quel registro, come
   quella dell'owner — confrontare con gli hash delle versioni spedite nella
   storia di Git. Funziona perché l'installazione **è** un checkout (è così che
   `update` fa il fast-forward). Dove non lo è, la risposta onesta è «non lo so
   dire», dichiarata invece che indovinata (ADR-0008).

`doctor` è il posto: oggi non guarda affatto questi file. E `rot/identity.md`
sta **dentro il sigillo**, quindi adottarlo manda l'installazione in safe mode
finché non si rifà `muffin rot reseal` — che è un atto di autorità dell'owner,
non una copia di file, e va chiesto invece che eseguito.

## Un buco minore, notato qui

Il fallback per chiave singola è **silenzioso**: `paramsMaxTaint` mancava e
nessuno lo ha detto. Qui non è costato niente perché il fallback vale quanto il
file, ma il fallback di *tutto* il file `doctor` lo nomina, e questo no. Se un
giorno il valore spedito e il `POLICY_FLOOR` divergono, l'installazione userà
il secondo senza che nessuno se ne accorga.
