# Come parla il terminale di Muffin

Le decisioni sul colore e sulla forma, prese una volta. Accanto al codice che le
applica e non in `docs/`, per la stessa ragione per cui Codex tiene il suo
`styles.md` dentro `codex-rs/tui/`: è una cosa che si legge mentre si scrive una
riga di output, non mentre si progetta.

Esiste perché la lamentela che l'ha prodotto era precisa — *«manco si capisce da
dove parte un comando»* — e la risposta sbagliata a quella lamentela è spargere
colori finché sembra vivace. Un output colorato a caso è più difficile da
leggere di uno monocromatico, non meno.

## La regola che viene prima di tutte

**Il colore è additivo e sparisce da solo.** Mai fuori da un TTY, mai con
`NO_COLOR` impostata, mai su `TERM=dumb` (`cli/ui.ts` §`styleFor`).

Non è cortesia verso gli script: è la condizione che permette a ogni
`expect(out).toContain('…')` della suite di restare valido, e a `grep`, `tee` e
una pipe di ricevere gli stessi byte di sempre. Una sequenza di escape dentro un
file è spazzatura. Stessa regola di `cli/status-line.ts`, che senza TTY smette di
essere uno spinner e diventa una riga normale.

**Corollario operativo:** una funzione che *restituisce* una stringa non colora
per default (`formatReport(report)` è nudo; `formatReport(report, style)` no).
Chi chiama può volerla scrivere su disco, e il caso comodo non deve essere quello
sbagliato.

## Il vocabolario

Sei ruoli, e nient'altro. Aggiungerne un settimo è una decisione da prendere qui,
non in un file di comando.

| ruolo | SGR | dove |
|---|---|---|
| `ok` | verde | il segno `✓` di un check che va |
| `warn` | giallo | il segno `!` di qualcosa da guardare |
| `fail` | rosso | il segno `✗` di qualcosa di rotto |
| `accent` | ciano | il nome del comando nell'intestazione |
| `bold` | grassetto | il nome di un check, il nome del comando |
| `dim` | smorzato | i rimedi, i passi già finiti, i numeri di chiusura |

Niente sfondi, niente 256 colori, niente truecolor: sei codici SGR che ogni
terminale degli ultimi trent'anni rende uguale, e nessuna dipendenza per
produrli.

## Cosa NON si colora, che è la metà che conta

**Il segno prende il colore, il testo resta nudo.** In un `muffin doctor` la
maggioranza dei check è verde: colorare anche il dettaglio fa venti righe verdi
in cui trovare l'unica gialla è di nuovo un lavoro dell'occhio. Quello che deve
saltare fuori è **la colonna dei segni**, e sta a sinistra apposta.

**Il rimedio è smorzato, non evidenziato.** È la riga che leggi *dopo* aver
deciso che quella sopra ti riguarda. A piena intensità raddoppia il rumore.

**Il testo dell'agente non si tocca mai.** La risposta di un turno va su stdout
esattamente com'è, byte per byte, in streaming — è un invariante scritto
(`cli/repl.test.ts` §B11: *«a streamed turn's stdout bytes are `\n` + every chunk
in order, and an unstreamed one is `\n` + result.text, and those are required to
be the same bytes»*). Tutto ciò che è cornice vive su **stderr**, ed è per questo
che `muffin > risposte.txt` raccoglie le risposte e lascia la cornice a schermo.

## La forma di un turno

```
› come stai?
  ⠋ penso…                     ← vive e sparisce (stderr)
  ✓ cerco in memoria           ← resta, smorzato (stderr)

Tutto a posto. …               ← la risposta, nuda (stdout)

  4.7s · 5487→2 token · $0.0004   ← la chiusura, smorzata (stderr)
```

Tre livelli, e la gerarchia è tutta lì: **la risposta è l'unica cosa a colonna
zero e a piena intensità.** Il lavoro che l'ha prodotta è rientrato e smorzato,
perché è vero che è successo ma non è quello che sei venuto a leggere.

La riga di chiusura esiste perché un turno deve avere una **fine visibile**:
senza, due turni di fila sono un blocco solo. Che porti anche il costo è quasi
un effetto collaterale — ma è il numero che prima si poteva vedere solo con
`--debug` o con `/spend`, cioè mai.

## L'intestazione dei comandi

Una riga, il nome del comando in ciano grassetto, e ciò su cui sta lavorando
smorzato dopo un `·`:

```
muffin doctor · /home/user/.muffin
```

Risolve la lamentela alla lettera: senza, l'output di un comando e quello del
comando prima sono un blocco solo. **Mai su `--json`**, che ha un solo lettore e
non è umano.

## Quello che non facciamo, e perché

**Niente schermo pieno, niente buffer alternato.** Claude Code non lo usa e ha
ragione: il transcript deve restare nello scrollback, selezionabile e
copiabile. Da noi c'è anche un vincolo più duro — il REPL funziona su una pipa,
e gli acceptance test lo guidano senza TTY.

**Niente framework, per ora.** La valutazione sta in
`docs/evidence/tui-2026-08-27.md`. In breve: quasi tutto ciò che fa
sembrare una CLI «una schermata» si ottiene con le regole qui sopra, e ciò che
resta — un input multilinea con editing decente — è una voce di spesa che va
decisa per sé, non presa di contrabbando dentro l'estetica.

## Il riquadro dell'input (28/08/2026)

Owner: *«guarda tipo claude code, che ha i bordi, text area, personaggio in
alto, nomi testi e cose così»*. Da lì `cli/riquadro.ts`.

**Cosa c'è.** Un'intestazione all'avvio (il «personaggio in alto»), e attorno a
ciò che scrivi un riquadro che porta sul bordo alto **modello e sessione** —
le due cose che l'intestazione dice una volta e che dopo venti messaggi non
sono più a schermo. Sotto, una riga di suggerimenti smorzata.

**Cosa non c'è, e resta escluso.** Lo schermo alternato. La regola di questo
file non cambia: il riquadro si disegna **in fondo allo scrollback** e si
ridisegna cancellando solo le proprie righe. Quello che è già scorso sopra
resta selezionabile e copiabile — che è la ragione per cui la regola esiste, e
vale quanto la cornice.

**Le tre cose che si sbagliano disegnando, e chi le tiene chiuse.**

1. *Il colore conta come larghezza.* Il prompt colorato è dodici caratteri e
   due colonne. `larghezzaVisibile` toglie le sequenze; senza, il riquadro è
   storto **solo** col colore acceso, cioè mai in un test su una pipe.
2. *L'ancora del ridisegno.* Alla fine di un disegno il cursore non sta in
   fondo al riquadro, sta dove sta il testo. Risalire di «tutte le righe»
   invece che «fino alla riga del cursore» cancella righe che non sono nostre:
   a schermo si vede come **la risposta di prima che sparisce** mentre scrivi
   la domanda dopo.
3. *Guardare l'output invece dello schermo.* `script` registra i byte, e i byte
   di dieci ridisegni sono dieci riquadri anche quando a schermo ce n'è sempre
   stato uno. `cli/schermo.ts` applica quei byte e restituisce la griglia; è
   l'unica cosa che risponde alla domanda «quanti riquadri vede l'owner».
