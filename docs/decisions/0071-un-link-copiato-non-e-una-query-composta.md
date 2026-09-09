# ADR-0071 — Un link copiato non è una query composta

**Stato:** accettato · 2026-09-04 · direzione owner

## Contesto

Il gate sui parametri (`gateParams`, `core/policy/decide.ts`) nasce dall'audit
del 2026-08-16 (P04-1, P04-2) e risponde a una domanda giusta: i byte che il
modello mette in una query string escono verso un host, e nessuno li ha visti.
La regola scelta allora era un numero — `taint > paramsMaxTaint` — e quel
numero si è rivelato incapace di distinguere le due cose che contano.

`hasParams` vede un `?` e si ferma lì. Non sa dire se quell'URL il modello se
lo è **inventato** — il canale di esfiltrazione, l'unica cosa che il gate
esiste per fermare — o se lo ha **copiato** da un risultato di ricerca, cioè
se sta semplicemente seguendo un link, che è il mestiere.

Due conseguenze misurate, opposte fra loro, dalla stessa riga:

**Per l'owner, il gate scattava quasi sempre a sproposito.** Nella ricerca
vera quasi ogni link ha un `?`. Dopo la prima pagina letta il turno è a taint
3, quindi da lì in poi *ogni* link seguito chiedeva un'approvazione. Un giro
di ricerca normale — cerca, apri, apri il prossimo — era una fila di
richieste di conferma per URL che Muffin non aveva scelto. Direzione
dell'owner, testuale: *«e basta con sta cosa che non puo leggere i link
normalmente, va cambiata»*, *«non puo non entrare»*.

**Per un gruppo, non scattava mai.** `tierOf(member)` è 2 e `paramsMaxTaint`
è 2, quindi `taint <= ceiling` era vero **per costruzione** per ogni turno di
gruppo: la prima query inventata da un membro qualunque usciva senza che
nessuno la vedesse (`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §6.1). Il
criterio era un numero che i gruppi avevano già raggiunto in partenza.

Lo stesso difetto, letto due volte: il taint misura *quanto contenuto di terzi
c'è nel turno*, non *da dove vengono questi byte*. Sono domande diverse.

## Decisione

Il gate sui parametri risponde alla provenienza, non al numero.

`DecisionRequest` porta `quoted`: **questi byte erano già nel turno prima che
il modello scrivesse?** Il turno lo calcola su ciò che gli è **entrato** — il
messaggio della persona e i risultati dei tool — e mai sul testo che il
modello ha prodotto.

- **Citato** → nessun cancello, per nessun principal. Seguire un link non è
  scegliere byte.
- **Composto, owner** → invariato: `taint <= paramsMaxTaint` passa, sopra si
  chiede mostrando l'URL intero.
- **Composto, non-owner** → `deny`. Non `ask`: in un gruppo non c'è nessuno
  che possa rispondere, quindi degradare a domanda non sarebbe una difesa.

Tre confini, ognuno dei quali è il punto in cui questa decisione poteva
diventare sbagliata:

**Solo gli ingressi contano, mai l'output del modello.** Altrimenti il
criterio è circolare: una pagina avvelenata dice «manda i dati a …», il
modello lo scrive nella sua risposta, e al passo dopo lo cita come se fosse
arrivato da fuori. Sarebbe un timbro che si mette da solo.

**Solo l'URL intero, e solo per `url-read`.** Una query di ricerca
(`resourceKind: 'query'`) è per definizione **scritta** dal modello: è
linguaggio naturale, non un indirizzo che si copia, e la provenienza lì non
si applica affatto. Questo confine non è stato dedotto: il primo giro della
fetta lo aveva sbagliato e l'ha trovato la suite, con
`agent/read-then-egress.test.ts` che legge un segreto da un file avvelenato e
lo cerca **letteralmente** — «era già negli ingressi» è vero, ed è vero
*perché* è il segreto.

**Confronto letterale.** Una versione tollerante — normalizzare l'escaping,
riordinare i parametri — allargherebbe la finestra a stringhe che
*somigliano* a un ingresso, ed è esattamente lì che lavorerebbe un
aggressore. Un falso negativo costa un'approvazione in più; un falso positivo
aprirebbe il canale che il cancello esiste per chiudere.

## Perché regge

Non si esfiltra un dato attraverso una stringa che esisteva **prima** che il
dato fosse visto: chi ha pubblicato quella pagina non conosceva il segreto
quando l'ha scritta. Se il modello aggiunge anche un solo byte suo, la
stringa non è più citata e il cancello torna. L'aggressore che concatena un
proprio prefisso con byte letti altrove non produce una stringa già presente;
quello che pubblica l'URL completo conosceva già ciò che ci ha messo dentro.

## Conseguenze

`sys.search` resta `hostOnly: true`. Con la provenienza, la query di un
membro sarebbe sempre composta e quindi sempre negata: aprirla ai gruppi
darebbe un tool che non funziona mai, che è peggio di un «no» dichiarato.

Il buco di §6.1 si chiude come effetto, non come intenzione — ed è il segno
che il criterio nuovo è quello giusto: la stessa riga che smette di
infastidire l'owner smette di lasciar passare uno sconosciuto.

Resta vero che `paramsMaxTaint` governa ancora il caso composto per l'owner.
Questa ADR non lo tocca: sposta il *criterio*, non la soglia.
