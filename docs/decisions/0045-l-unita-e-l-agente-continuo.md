# ADR-0045 — L'unità è l'agente continuo

**Stato:** accettato · 2026-08-16 · direttiva owner nella sessione di progetto;
il contenuto normativo rilevante è riportato in questa ADR · non modifica da
sola alcun permesso

## Contesto

La tesi pubblica nominava due assi — fare e capire — e metteva il vantaggio
quasi interamente nella continuità del dataset. Il codice era già più avanti
della formulazione: il gateway vive senza REPL (ADR-0035), un turno è un record
durevole (ADR-0042), job e consegna hanno stato proprio, e ADR-0021 aveva già
deciso che nessuna surface è “il” canale.

Mancava però una frase che tenesse quei pezzi insieme. Senza, era possibile
leggere Muffin come un assistente con buona memoria e aggiungere connector,
device o automazioni come prodotti separati. La critica owner è diversa:

> l'unità non è la sessione, il device, l'app o il modello. È un agente personale
> continuo che diventa l'interfaccia primaria al mondo digitale e fisico.

La stessa conversazione ha nominato due rischi. “Più ti conosce, più può fare”
può diventare un allentamento arbitrario della sicurezza; e “sempre presente”
può diventare un agente che produce rumore pur di mostrarsi vivo. Entrambi
contraddicono i guardrail già pagati da questo repository.

## Decisione

### 1. L'identità continua attraverso le superfici

Muffin è un solo agente. Turni, sessioni, job e processi sono unità di lavoro;
CLI, chat, voce e device sono porte. Modello e tool sono harness sostituibile.
Nessuno di questi può possedere una persona, una memoria o una policy separata.

Una nuova superficie dichiara cosa può ricevere, rendere e consegnare. Il
runtime risolve chi parla e dove va la risposta; il loop, il kernel e il
substrato restano gli stessi. Un pendant o uno speaker non è una seconda entità
da sincronizzare.

### 2. Fare, capire, essere presente

I tre assi sono indipendenti:

- **fare**: portare a termine effetti reali e verificarne l'esito;
- **capire**: mantenere credenze con tempo, provenienza e possibilità di
  contraddizione;
- **essere presente**: mantenere ciò che resta dovuto e giudicare quando agire,
  aspettare, tacere, interrompere, chiedere, rivedere o abbandonare.

Presenza non è un processo sempre occupato. Il default può essere il silenzio.
Il gateway è necessario ma non sufficiente: la proprietà utile è che il lavoro
e le attese sopravvivano al processo e tornino visibili.

### 3. Quattro stati non si fondono

Il disegno distingue:

1. **evidenza** — episodi di ciò che è accaduto, monotòni;
2. **credenze e modello della persona** — interpretazioni bi-temporali con
   provenienza;
3. **stato del mondo** — condizioni esterne che valgono adesso, con origine e
   freschezza esplicite;
4. **stato del lavoro** — turni, job, attese, todo, esiti e consegne.

È un confine semantico, non l'approvazione di una nuova tabella. Prima di
materializzare world state serve un consumer reale e un'ADR che risponda almeno
a provenienza, freschezza, ritiro e isolamento. `slice/memoria-nel-tempo`
estende il secondo piano; non costruisce il terzo.

### 4. L'autonomia si guadagna per scope

Conoscere meglio l'owner migliora il significato, non concede permessi. Restano
immutabili:

- il Root of Trust e il kernel puro e sincrono;
- il confinamento monotòno del taint;
- i tetti sigillati e i divieti costituzionali;
- la regola che il modello interpreta il significato ma non arbitra la
  sicurezza.

La supervisione può ridursi solo con una concessione legata a **capability,
classe di risorsa e contesto**, sostenuta da esiti osservabili e ripetuti. La
concessione deve avere origine, validità, revoca e regressione dopo un fallimento;
quando possibile richiede reversibilità o un recovery path provato.

Non esiste un punteggio globale di fiducia. Non esiste “Muffin mi conosce, quindi
può”. Questa ADR non alza `maxTaint`, non converte un `ask` in `allow` e non
risolve la decisione owner aperta dall'ADR-0044 che vive ancora su
`slice/taint-in-ingresso`, sullo shell dopo una lettura.

### 5. Si misura sostituzione, non parità di feature

Oltre ai test di meccanismo, la domanda di prodotto è: **quale interfaccia
diretta l'owner non deve più aprire grazie a Muffin, senza perdere controllo?**
Il Gate 1 resta il test vicino e operativo — quattordici giorni reali. In
seguito, una superficie o capability entra per sostituire un rapporto diretto
o rendere continua l'esperienza, non per inseguire la checklist di un peer.

La portabilità è parte del test: cambiare modello o superficie non deve cambiare
chi è l'agente, cosa ricorda, cosa deve ancora fare o quali limiti valgono.

## Conseguenze sui lavori in corso

- `slice/turno-sospeso` è il consumer immediato della presenza: `wait`, `todo`
  e resume devono appoggiarsi al record di turno, non a uno `sleep`. Finché le
  modifiche restano non committate e non verificate, i blocker restano aperti.
- `slice/superfici` realizza la regola “porte, non agenti” con capability e
  delivery tipizzati. Non rende Discord una priorità di prodotto da sola.
- `slice/memoria-nel-tempo` rende interrogabile la storia delle credenze. Non è
  world state e non va rinominata come tale.
- `slice/hermes` fornisce failure mode e primitive operative da adattare; non
  sposta la differenza di prodotto verso la parità con Hermes.
- `slice/taint-in-ingresso` resta fail-closed. L'autonomia guadagnata futura si
  costruisce sopra provenienza obbligatoria, mai togliendola.

## Alternative scartate

- **Un agente per device.** Duplica memoria, policy e lavoro; trasforma la
  continuità in sincronizzazione.
- **Un trust score unico.** Mescola risorse e rischi diversi, cresce per inerzia
  e non sa spiegare quale evidenza autorizza quale effetto.
- **Il modello dentro il kernel.** Rende non deterministica e attaccabile la
  decisione che deve restare il Root of Trust.
- **“Always on” come attività continua.** Produce il firehose che ADR-0028 ha
  reso incostruibile; presenza include il silenzio.
- **Una tabella `world_state` generica adesso.** È schema prima del consumer, la
  forma che `docs/lessons.md` registra come più costosa.
- **Costruire subito hardware ambientale.** Un device è giustificato dal porto
  che apre sullo stesso agente; prima serve provare l'agente sui porti esistenti.

## Reversibilità e falsificazione

La formulazione è reversibile nei documenti; i confini che impone sono
deliberatamente costosi da rompere dopo che dati e device dipendono da loro.

La decisione va rivista se almeno una delle seguenti resta vera dopo uso reale:

- cambiare modello o superficie spezza identità, memoria, policy o lavoro;
- la presenza aumenta le interruzioni più degli esiti utili;
- concessioni scoped non riducono conferme senza aumentare danno o false
  autorizzazioni;
- mesi di accumulo non sostituiscono alcuna interfaccia diretta dell'owner.

## Revisione — 2026-08-17: cinque piani, e le surface sono porte

Direttiva owner, verbatim nella sostanza: «formalizzerei mentalmente cinque
piani, anche se non necessariamente come moduli — **EVIDENCE** (cosa è
realmente entrato/uscito), **BELIEFS** (cosa Muffin pensa sia vero), **WORK**
(cosa è ancora dovuto), **EFFECTS** (cosa sta facendo / forse ha fatto / ha
fatto al mondo), **AUTHORITY** (cosa può fare). Il modello ragiona sopra questi.
Le surface sono porte». Estende la Decisione §3 («quattro stati non si
fondono») con due piani che erano impliciti: gli effetti sul mondo e
l'autorità.

La regola che ne discende, e che questo repo applicherà a ogni cambiamento
senza un grande refactor: **nessun nuovo store o tabella può essere due piani
insieme**. Ogni slice risponde «a quale piano appartiene?»; se la risposta è
due, c'è una cucitura da capire prima di scrivere codice.

Le tre cuciture già note, nominate perché sono la forma dietro tre invarianti
del mandato DAY-1 (`gate1/MANDATO-DAY-1.md` §4):

- **`SessionStore`** sembra Evidence ma è usata direttamente come Context, e
  perde la provenienza: è l'invariante 2 (taint attraverso la session history)
  — la direzione è che il contesto legga l'evidenza con provenienza e tier, non
  un trascritto crudo.
- **`turn_tool_calls`** sta diventando l'Effect ledger (intento prima,
  esito dopo, `rerunnable`) ma è ancora trattata in parte come bookkeeping: è
  l'invariante 1 (effect WAL) e la §6 sulla reversibilità (journal riusabile).
- **La delivery** è un effetto ma ha una semantica propria separata: è
  l'invariante 5 (durable result + delivery), da valutare con la stessa
  semantica intento/esito degli altri effetti.

Non si aprono slice «refactor per imporre i piani»: si estraggono i confini
quando una garanzia del DAY-1 li richiede.

