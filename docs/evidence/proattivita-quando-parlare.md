# Proattività: quando parlare, e con che conto

**Data**: 2026-08-10 · **Per**: MVP #5, la spina osservante (cancello a due stadi
+ segnale d'assenza) · **Metodo**: sweep di letteratura prima di scrivere il
detector, non dopo.

Distinguo per tutto il documento fra **verificato** (fonte aperta e letta) e
**visto solo in snippet**. Dove una cosa che credevamo è risultata sbagliata, lo
dico prima del resto: è la parte che vale.

## Quello che credevamo e non era esatto

**Pare-Bench, il 74,7%.** Il numero esiste, il paper esiste — arXiv:2604.00842,
*Proactive Agent Research Environment*, 1 apr 2026, 143 task con le app modellate
come macchine a stati — ma **non misura "proposte premature"**. Misura la quota di
proposte che fanno scattare un *gather context*: l'utente aveva bisogno di altre
informazioni prima di poter agire. È il proxy del paper per il tempismo sbagliato,
non una metrica che si chiami così.

E il confronto è più netto di come lo citavamo: **Gemma 3 4B Instruct 74,7% ±2,6%**,
**Claude 17,8%**, **GPT-5 23,4%**; delle proposte di Gemma solo il 16,0% è accettato
direttamente. Nei nostri documenti stava come "Gemma 4 31B IT" con Claude al 12,8%
e Qwen al 26,5% — modello sbagliato e numeri sbagliati.

Cosa cambia per noi: il divario fra un modello piccolo e uno di frontiera sul
*tempismo* è di quattro volte. La lezione che ne traevamo — soglia alta, gate
meccanico fuori dal modello — regge, e anzi regge meglio: 17,8% resta un errore su
sei anche col modello buono.

**Corretto in** `docs/foundations/REFERENCES.md` e
`docs/blueprint/knowledge/03-observing-spine.md`.

## 1. Il cancello a due stadi ha un precedente misurato

*"Do Proactive Agents Really Need an LLM to Decide When to Wake and What to
Anchor?"* — arXiv:2605.30152, ~29 mag 2026 (**verificato, fetchato**). È la stessa
architettura: uno stadio economico decide *se* svegliarsi, l'LLM entra solo dopo e
solo per dire *cosa*. Numeri riportati: **+16,7 F1 medio** su 14 backbone (fino a
+46,0), da **4-7× a 12-83×** più veloce del baseline LLM-come-trigger, ~11-14 ms
per evento, ~220 MB on-device.

**Ma il loro stadio 1 non è il nostro.** È un modello di Temporal Graph Learning
*appreso* su tuple (attore, verbo, oggetto, timestamp), che produce una probabilità
di trigger. Il nostro è deterministico e a costo zero. La divergenza è deliberata e
va registrata come tale: un gate appreso è una superficie che si può avvelenare con
l'uso e che non si può spiegare da uno snapshot — le due proprietà per cui il
kernel di policy è una funzione pura. Se un giorno il detector deterministico si
rivelasse cieco su segnali veri, questo paper è la porta accanto, e il prezzo da
pagare è dichiarato: 220 MB e un componente che va addestrato e riaddestrato.

Altri benchmark esistono e li lascio come inventario, non come base per decisioni
(visti in snippet, non aperti): ProactBench (2605.09228), ProactiveEval
(2508.20973), ContextAgent (2505.14668), ProEvent (2607.17701 — anche GPT-5.1 sta
al 26,7% di correttezza multi-step, gli agenti "frequently overact"), ProVoice-Bench
(2604.15037).

## 2. L'assenza come segnale non ha prior art

Cercato con più formulazioni — *silence detection user modeling*, *topic
disappearance*, *absence as signal*, *negative evidence user model*, *time since
last event anomaly*. **Non trovato**: nessun lavoro che tratti "un tema smette di
comparire" come segnale di retrieval o di attenzione nella memoria di un agente.
L'unico adiacente è *Making Absence Visible* (arXiv:2601.07234, ACM IUI 2026), che
però parla di informazione mancante nei riassunti generati, non di memoria.

Questo è **il fatto scomodo del documento**: non c'è benchmark contro cui tarare la
soglia, e nessuno ha pubblicato quanto un segnale così sia gradito. Conseguenza
diretta sul codice: postura conservativa per obbligo, non per gusto — alpha stretta,
pavimento assoluto sui giorni, tetto basso per giro. E il primo taglio non consegna:
mostra.

## 3. La statistica dell'"in ritardo"

La coniugazione Gamma-Esponenziale (posterior Gamma(a+n, b+S)) è **confermata** su
un testo bayesiano terzo; l'identità *mistura Gamma di esponenziali = Lomax /
Pareto-II* è **confermata** su due fonti indipendenti. La forma chiusa che usiamo,

    P(T > gap) = (1 + gap/S)^(-n)

**non è stata trovata scritta così da nessuna parte**: segue meccanicamente dalle
due sopra, ma l'abbiamo derivata noi. Due conseguenze pratiche, entrambe finite nel
codice:

- **la costante dipende dalla prior**. Il "19× con un solo intervallo" e il "12,5%
  a k=3" valgono sotto la prior di Jeffreys p(λ) ∝ 1/λ. Con una prior propria
  cambiano. Sta scritto in `core/memory/absence.ts` invece di essere implicito;
- essendo una derivazione e non una citazione, `overdueProbability` è **esportata e
  provata su numeri calcolati a mano** — è la sola affermazione del file che possa
  essere sbagliata in silenzio.

**BG/NBD (P(alive))** è l'alternativa matura e la formula è confermata, ma costa
quattro parametri stimati per massima verosimiglianza o MCMC, e — questo è il punto
— si stima **mettendo in comune la storia di molte entità** per catturare
l'eterogeneità della popolazione. Su una singola entità con due o tre intervalli non
paga: sarebbe apparato senza il dato che lo rende sensato. Diventa la scelta giusta
il giorno in cui vorremo un tasso di silenzio *comparato fra* centinaia di temi.

## 4. Quanti messaggi al giorno: non lo sappiamo

- Pielot et al., *An In-Situ Study of Mobile Phone Notifications*, MobileHCI 2014
  (**confermato**): 15 utenti, una settimana, **63,5 notifiche/giorno** in media, e
  più volume ⇒ più affetto negativo. Ha dodici anni ed è pre-LLM: vale come ordine
  di grandezza dell'ambiente, non come budget per noi.
- Il "3-5 messaggi proattivi al giorno" che circola: **non verificato**. La fonte è
  un post pratico del 13 mag 2026, esplicitamente prescrittivo, senza dato dietro.
- Il "60% disattiva dopo overload" attribuito a Localytics: **fonte primaria non
  trovata**, solo citazioni secondarie. Da non usare.
- Numeri di tolleranza specifici per messaggi proattivi di un LLM: **non trovati**.

Quindi il tetto a 3 per giro in `ABSENCE_DEFAULTS` è **un'assunzione di design, non
una costante citabile**. Il modo onesto di risolverla è il segnale che ADR-0028 già
nomina: il tasso con cui l'owner li ignora o li zittisce.

## Cosa è cambiato nel codice per via di questa ricerca

1. La soglia è **p**, non "media × 3". La regola ereditata sembra un test al 5% ed è
   un test al 16% dove il vecchio detector viveva (n=2).
2. La prior è **dichiarata** nel file, perché la costante dipende da lei.
3. `overdueProbability` è **esportata e testata**, perché è derivata e non citata.
4. La postura conservativa è **motivata dall'assenza di benchmark**, e detta come
   tale invece di sembrare prudenza generica.
5. Il tetto a 3 è **etichettato come assunzione**, con scritto cosa lo falsificherebbe.

## Fonti

arXiv:2604.00842 (Pare-Bench, verificato) · arXiv:2605.30152 (gate non-LLM,
verificato) · arXiv:2601.07234 (adiacente, snippet) · Pielot et al. MobileHCI 2014
(verificato) · coniugazione Gamma-Esponenziale e identità Lomax (testi terzi,
verificati) · BG/NBD (formula confermata, derivazione originale di Hardie).
