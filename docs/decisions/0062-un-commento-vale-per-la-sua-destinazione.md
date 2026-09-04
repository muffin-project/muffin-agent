# ADR-0062 — Un commento vale per la sua destinazione, non per il suo volume

**Stato:** proposto · 2026-09-04 · esegue la raccomandazione di
`docs/evidence/forma-del-repo-2026-09-04.md` §E

> **Proposto, non accettato.** Nessuna riga di codice cambia con questo
> documento, e nessun commento esistente viene toccato. Diventa `accettato`
> solo con una decisione dell'owner. Se l'owner decide di no, questo file
> diventa lineage in `docs/history/design-notes/` e la misura resta come
> evidence.

## Contesto

`docs/evidence/forma-del-repo-2026-09-04.md` misura che il 46,08% delle righe
non-test di `agent/core/cli` sono commenti (23.551 su 51.111). Il coordinatore
ha corretto la domanda iniziale: il volume non è il problema — otto casi
misurati di prosa falsa a HEAD (§E.1 dell'evidence, verificati uno per uno:
quattro erano già auto-corretti nello stesso file, uno resta falso senza la
riserva che il suo gemello ha, uno è tuttora un mismatch reale, uno non è
stato ritrovato) dicono che il **drift** è misurabile e non ipotetico. Un
campione dichiarato di 1126 righe di commento (11 file, campionamento
sistematico ogni 13° file non-test di `agent/core/cli`) le classifica per
**destinazione**: 85,2% motiva una scelta (WHY), 5,5% è un numero o un
invariante misurato (MEASURE), 5,4% ridice cosa fa il codice (WHAT), 3,9% è
riferimento tecnico necessario.

## Decisione proposta

Un commento si scrive per la destinazione che porta, non per abitudine:

1. **Cosa fa il codice → si toglie.** Se il tipo o il nome della funzione lo
   dice già, il commento è ridondante col linguaggio stesso — non un
   arricchimento, un doppione che può divergere dal codice sotto senza che
   nessun test se ne accorga.
2. **Perché questa scelta → un ADR**, non un paragrafo nel file. Se la
   motivazione è già la sostanza di un ADR esistente (misurato:
   `core/policy/types.ts` ripete ADR-0053 riga per riga), il commento diventa
   una citazione (`// vedi ADR-0053 §…`), non una seconda copia in parole
   diverse — la stessa dispersione di Parte B, in prosa invece che in codice.
   Una motivazione nuova, non ancora registrata altrove, resta dove serve
   finché non guadagna un ADR proprio; questo non chiede di svuotare ogni file
   subito.
3. **Una misura → un test.** Un numero che giustifica una costante
   (`MAX_AUDIO_BYTES`, `MIN_PLAUSIBLE_EXTRACTED_CHARS`, `TICK_MS =
   HEARTBEAT_MS`) o un accoppiamento fra due file dichiarato in prosa diventa
   un'asserzione: un test fallisce quando smette di essere vero, un commento
   no. Tre istanze concrete già trovate in `docs/evidence/forma-del-repo-2026-09-04.md`
   §E.3.
4. **Un vincolo sul cambiamento futuro → un test.** Lo stesso principio del
   punto 3, applicato a un invariante piuttosto che a un numero.

**Cosa questa regola non chiede.** Non chiede una potatura di massa: l'85,2%
di WHY misurato non è per forza da spostare — lo è quando duplica un ADR che
già esiste, non quando è motivazione locale non ancora registrata altrove.
Non chiede di riscrivere gli otto casi di §E.1 in questa stessa PR: quattro
sono già auto-corretti, gli altri restano per una revisione dedicata.

## Perché ora, e perché così

Il repository già **fa** parte di questa cosa senza una regola scritta:
quattro degli otto casi misurati mostrano un commento o un ADR che documenta
la propria correzione passata, a mano, nello stesso posto dove l'errore
viveva. È un istinto giusto senza un nome — questo ADR gli dà il nome, e
sposta il meccanismo di correzione da "riscrivi la prosa quando un giudice la
smentisce" a "il test torna verde", che è più economico e non richiede che
qualcuno ricordi di tornare a riscrivere il commento.

## Cosa la ribalterebbe

- Se incrociare ogni blocco WHY del campione con l'ADR che eventualmente
  ripete mostrasse che la duplicazione reale è marginale (non misurato in
  questo giro — richiede un secondo passo dedicato), il punto 2 perderebbe la
  sua giustificazione principale e resterebbe solo una preferenza stilistica.
- Se il costo di scrivere un test per ogni MEASURE (punto 3) si rivelasse più
  alto del costo di lasciarlo derivare — per esempio perché la misura dipende
  da un ambiente non riproducibile in CI — quella singola istanza resta
  prosa, e lo dice esplicitamente invece di fingere il test.
- Se l'owner giudica il costo di applicare questa regola a ritroso su 23.551
  righe esistenti superiore al beneficio, la regola vale solo per il codice
  nuovo, e questo ADR va riscritto per dirlo.
