# ADR-0042 — Un documento entra intero, e si compatta dopo — mai al posto

**Stato:** accettato · 2026-08-15 · chiude `M5-BIS.md` C7 (*«PDF | Acquisisce
documenti utili? | BLOCKER — nessun parser»*)

**Contesto.** Un PDF che arriva su Telegram veniva scaricato in
`vault/inbox/`, e lì finiva. `core/vault/vault.ts` leggeva **utf-8 o niente**: un
byte NUL nel primo blocco e il file era «non è testo — serve un estrattore»,
saltato con una ragione onesta e mai indicizzato. Il risultato visibile
all'owner: Muffin diceva *ricevuto*, teneva i byte, e non una parola di quel
documento era ripescabile. Questa è la riga C7, ed è anche una **regressione
rispetto al vecchio Muffin**, che i documenti li leggeva.

Direttiva owner, verbatim (2026-08-15): *«dobbiamo parsare tutto, questa è una
cosa su cui siamo indietro rispetto al vecchio muffin, non dobbiamo MAI stare
dietro al vecchio muffin, parsiamo tutto quello che serve ed evitiamo di troncare
dati importanti, tipo se gli mando un PDF deve leggerlo tutto non solo meta…
forse conviene compattare in caso? con possibilità di poi analizzare meglio parti
specifiche»*.

Dentro c'è una tensione vera, ed è la decisione di questa ADR. Un documento
intero è ciò che serve alla memoria; un documento intero è precisamente ciò che
**non** deve entrare nel contesto del modello, che ha 32K token utili misurati
(`09-contratti-m0-m1.md` §3) e ottanta pagine non ci stanno. La risposta sbagliata
e naturale è compattare in ingresso: acquisire un riassunto. È irreversibile —
un riassunto non si ri-espande — e la perdita è invisibile sei mesi dopo, quando
la frase che serviva non c'è e nessuno sa che c'era.

**Decisione.** Due tempi, e l'ordine è la decisione:

1. **Acquisizione intera.** `core/documents/extract.ts` restituisce tutto il
   testo del documento; `core/vault/vault.ts` lo spezza in chunk e lo scrive nel
   piano evidence (`episodes`, `kind='document'`), pagina per pagina. Niente qui
   tronca, campiona o riassume. Un PDF di ottanta pagine produce ottanta pagine
   di testo indicizzato.
2. **Compattazione dopo, mai al posto.** `core/documents/outline.ts` costruisce
   la **vista compatta**: cos'è il documento, che è dentro per intero, un indice
   delle sue parti, e la chiamata che ne riapre una. Il turno riceve quella. Il
   modello che vuole il testo esatto chiama `document_read` (`agent/tools/
   document.ts`), che legge **dal file** — la fonte, non una copia — e restituisce
   la porzione verbatim.

La proprietà che tiene insieme i due tempi: la vista compatta **può** lasciare
fuori delle cose, e ogni volta che lo fa lo dice nella stessa riga in cui offre
il modo di prenderle. L'indice che si ferma a 16 righe nomina l'intervallo che
non ha elencato; la porzione che tocca il tetto di 12.000 caratteri nomina da
dove ripartire. È la differenza fra una vista e un riassunto, ed è verificabile
invece che promessa.

**La libreria: `unpdf` 1.8.1.** Misurato oggi contro `registry.npmjs.org`, non
ricordato:

| | pubblicata | licenza | dipendenze | Node |
|---|---|---|---|---|
| **`unpdf` 1.8.1** | 2026-08-13 | MIT | **0** | `>=22` |
| `pdfjs-dist` 6.2.108 | 2026-07-28 | Apache-2.0 | 0 | `>=22.13.0` |
| `pdf-parse` 2.4.5 | 2025-10-20 | Apache-2.0 | `pdfjs-dist` + **`@napi-rs/canvas`** | — |

`unpdf` è un imballaggio serverless del pdf.js di Mozilla (versione risolta a
runtime: **6.1.200**), quindi il motore è lo stesso di `pdfjs-dist` e la
manutenzione poggia su Mozilla, non sul wrapper. Zero dipendenze runtime, `engines`
identico al nostro, e l'API è quella che serve e nient'altro: `extractText` per
pagina, `getMeta` per il titolo. `pdf-parse` è escluso da solo: tira dentro
`@napi-rs/canvas`, cioè **binari nativi**, e l'ultima pubblicazione del suo ramo
principale è del 2025-10-20 — dieci mesi.

**DOCX senza una seconda dipendenza.** `mammoth` è la scelta standard e porta
**dieci** dipendenze runtime, contro un repo che ne ha tredici e tratta la
prossima come il rischio che è (`PRACTICES.md` §1). Un `.docx` è uno ZIP di cui
serve una sola voce, `word/document.xml`, e `node:zlib` fa già la metà difficile:
`core/documents/zip.ts` sono quaranta righe di lettura della directory centrale
(APPNOTE 6.3.10 §4.3.12/§4.3.16), con ZIP64, cifratura e metodi diversi da
stored/deflate **rifiutati per nome** invece che letti male. La fixture è un
`.docx` vero scritto da un serializzatore altrui (macOS `textutil`), non uno che
ci siamo costruiti per farci tornare i conti.

**Il fallimento che assomiglia al successo, e perché ha un tipo.** Un PDF di
scansioni si apre benissimo, dichiara le sue pagine, e restituisce la stringa
vuota — misurato su unpdf 1.8.1 il 2026-08-15: `{ totalPages: 2, text: ["",""] }`.
Un estrattore che restituisce quel valore come «testo» archivia il documento come
letto. Quindi il risultato non è una stringa: è un'unione che il chiamante non
può ignorare, `{ ok: true, document } | { ok: false, failure, why }`, con
`no_text_layer` fra i casi e un messaggio che nomina il documento, il numero di
pagine e l'unico rimedio — l'OCR — che qui **non c'è**. È `ORCHESTRATION.md` §14:
si preferisce la forma che fallisce da sola a quella che dipende da qualcuno che
si ricordi.

**Cosa non fa, dichiarato.** Niente OCR: è un modello o un binario, ed è una
decisione sua. La struttura visiva non si ricostruisce — pdf.js restituisce gli
elementi nell'ordine del content stream, quindi due colonne emesse riga-per-riga
escono fuse su una riga sola (misurato: `"SINISTRA-1 DESTRA-1"`), e i confini di
cella di una tabella diventano uno spazio (`"Voce Importo"`). Il testo c'è tutto;
la sua forma no. Vale la stessa cosa per le tabelle DOCX.

**Alternative scartate.** *Compattare in ingresso* (indicizzare un riassunto):
irreversibile, e la perdita non si vede — è esattamente il difetto che C7
descrive con un altro nome. *Rileggere la porzione dai chunk* invece che dal
file: i chunk portano una riga di contesto che il documento non contiene, quindi
una citazione «verbatim» non lo sarebbe; e contraddice la prima frase di
`vault.ts`, che i file sono la fonte. *Un servizio di estrazione*: già scartato
in ADR-0041 per l'HTML, e il motivo non cambia — leggerebbe il documento
dell'owner al posto nostro.

**Reversibilità.** Alta per la libreria: `extractDocument` è l'unico punto che
importa `unpdf`, e il tipo di ritorno non nomina pdf.js. Media per la forma della
vista compatta, perché è ciò che il modello vede: cambiarla cambia il prompt, non
uno schema. Nulla di questa ADR tocca `episodes.kind` — un documento resta
`kind='document'`, cioè uno dei cinque valori del `CHECK` che SQLite non altera.
