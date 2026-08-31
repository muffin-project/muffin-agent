# ADR-0042 — Un turno è un record durevole con un'identità, non un frame di stack

**Contesto.** Tre righe dell'inventario Gate 1 sono BLOCKER e sembrano tre
lavori: **B2** (un turno lungo blocca il connettore), **B3** (`wait`), **B5**
(resume dopo una morte). L'istruttoria `research/turno-sospendibile.md`
(2026-08-15, letta riga per riga sul codice) le ha attaccate dal lato più debole
— *si può chiudere B2 senza sospendere niente?* — e la risposta ha cambiato
l'ordine di costruzione:

> B3 e B5 **sono** la stessa proprietà. B2 **no**: non chiede la sospendibilità,
> chiede che un turno **esista come oggetto** invece che come frame di stack di
> un `await`. Non sono tre feature e non sono una: sono **un substrato e due
> consumatori**, e il substrato va per primo perché tutti e tre lo vogliono.

Lo stato di un turno vive oggi in nove variabili locali di `runTurn` e in una
closure. Il difetto che ne segue non è futuro ed è misurato: se il processo muore
dentro `TelegramConnector.handle`, l'update resta pending e al riavvio `drain()`
**rifà il turno da capo, tool call ed effetti compresi**, senza che niente da
nessuna parte lo dica.

---

**Decisione.** Un turno è una **riga** in una tabella nuova, `turns`, scritta
prima che qualunque cosa sia generata e chiusa da una sola scrittura. Vive in
`core/turns/store.ts`. `LoopDeps.turns` è **obbligatorio**.

Questa slice costruisce **solo il substrato**. `wait`, `todo`, il resume vero e
la risposta-subito-consegna-dopo restano fuori, ognuno con la sua PR: se il
substrato è giusto cadono fuori da sé, e nessuno di loro dovrà riaprire il loop
per avere identità, taint o modello.

### Le sei cose che la riga tiene, e perché ciascuna

1. **Il modello, pinnato.** Un blocco `thinking` porta una `signature` del
   modello che l'ha prodotta. ADR-0037 documenta che rimandarla a un modello che
   non può leggerla **non fa rumore**: il server la scarta o spegne il thinking,
   e il sintomo è un agente peggiore. Un resume su un modello diverso dev'essere
   un rifiuto esplicito, e il rifiuto ha bisogno di sapere quale modello era.
2. **Il taint, come colonna e mai derivato.** Vive nella closure di
   `makeSnapshot` e non è ricavabile da nient'altro. Ricostruirlo dal principal
   farebbe ripartire da tier 0 un turno che aveva già scaricato una pagina web —
   il pattern fetch-then-act che il kernel esiste per chiudere, riaperto da una
   porta nuova. Sale nella **stessa transazione** dell'esito del tool che l'ha
   alzato: le due cose non possono atterrare separate.
3. **Il trascritto intero, thinking compreso.** `Message[]` è JSON piatto e
   `compactToolResults` restituisce una copia, quindi l'array del loop **è** il
   verbale completo. Il `.jsonl` di sessione non può farne le veci: il suo
   `content` è una `string`, i blocchi di thinking non ci arrivano mai, i turni
   intermedi dell'assistente non ci sono, e il lettore scarta le righe dei tool.
   Ma la ragione vera è di forma, non di formato: quel file è **evidenza**
   monotòna, lo stato di un turno è **mutabile**.
4. **Due esiti, mai uno.** Com'è andato il turno e com'è andata la consegna sono
   due colonne. `core/scheduler/scheduler.ts` ha già pagato questa lezione per i
   job: una consegna fallita non rifà girare il lavoro, perché lo raddoppierebbe.
5. **L'indirizzo di risposta**, opaco al loop — ogni superficie possiede la sua
   forma. È ciò che permetterà alla corsia di consegnare al posto di `handle()`
   senza riaprire il chiamante.
6. **Intento e esito per ogni tool call.** Oggi il loop registra solo l'esito,
   *dopo* che l'handler è tornato: un'invocazione partita e non conclusa non
   lascia **nessuna traccia**. Due righe fanno tre stati — *fatta*, *forse
   fatta*, *non iniziata* — e senza il primo dei due la distinzione non esiste.

### La dichiarazione nuova sulle capability: `rerunnable`

**`reversible` non è ri-eseguibilità, e riusarlo sarebbe stato il difetto più
caro di questa slice.** Sono due assi indipendenti: `fs.write` è `undoable` e
ri-eseguirlo è innocuo (stessi byte, stesso file); una mail non è né l'uno né
l'altro. Un disegno che consultasse `reversible` rifiuterebbe un resume che era
sicuro, e non avrebbe niente da dire su un `outward.send` che qualcuno
dichiarasse `undoable`.

Quindi un **secondo campo obbligatorio** su `CapabilityDecl`, deciso **adesso**:
è l'unica scelta di questo lavoro che **esce dal repo** — un server MCP di terze
parti la incorpora, e con cinque attaccati non si cambia più. Obbligatorio e non
opzionale perché così un tool nuovo che non risponde **rompe la build**, invece
di ereditare un default sbagliato metà delle volte.

Le undici risposte stanno accanto ai tool. `mcp.*` è `false` per costruzione: non
possediamo la semantica dall'altra parte della pipe.

### Cosa succede a un turno che muore

La riga resta `running` con il pid del processo che l'aveva presa. Il primo
runtime che apre quella home la **riprende come `interrupted`** — mai come
`runnable`: un resume non esiste, e uno stato che ne promettesse uno sarebbe un
meccanismo dichiarato e collegato a niente. Il giudizio di liveness è `heldBy`
di `core/lock/durable.ts`, riusato e non riscritto: due punti che giudicano la
stessa cosa divergono esattamente attorno a un crash, che è il momento in cui la
risposta conta.

L'annuncio è una riga di boot (`bootLines`, che ogni superficie stampa) e un
controllo di `muffin doctor`. Dice cosa **non si può sapere**: se una delle
chiamate rimaste aperte non è dichiarata ri-eseguibile, nessun record da questa
parte può stabilire se ha avuto effetto. Non si promette meglio, perché la
promessa migliore è quella che nessuno può mantenere — Temporal, con dieci anni e
un cluster, promette at-least-once salvo idempotenza esplicita.

### Il costo di migrazione, dichiarato

**Zero, oggi e su un database pieno.** Non esiste un migration runner: ogni store
esegue il proprio `db.exec(SCHEMA)` nel costruttore, e `CREATE TABLE IF NOT
EXISTS` **crea** una tabella nuova su un'installazione esistente. È così che sono
arrivate `jobs`, `spend`, `gateway_lock`.

**Il costo che non è zero è il nostro `CHECK` su `status`**, e eredita la
trappola di `episodes.kind`: SQLite non altera un `CHECK`, quindi uno stato
nuovo, dopo, vuole una ricostruzione della tabella. Per questo l'insieme è
scritto per i consumatori che arrivano e non per l'unico scrittore di oggi:
`waiting` e `runnable` sono già nel `CHECK` senza avere uno scrittore. **Prima
del giorno 1 dei quattordici** un valore nuovo costa una riga; dopo, costa una
migrazione. `episodes` non viene toccato — non per il costo, ma perché un
episodio è evidenza e un turno è stato.

---

**Cosa NON cambia.** La cascata di recovery, il gate di completamento,
`compactToolResults`, il kernel e la forma delle capability: sono tutti per-passo
e puri, e il record li rende ripetibili senza modificarli. **Nessuna superficie
cambia comportamento**: `muffin run`, la REPL, lo scheduler e Telegram fanno
esattamente ciò che facevano, e la suite passa da 982 a 1027 test senza che una
sola asserzione preesistente sia stata toccata.

**Cosa resta orfano e va detto.** `ChatCall.stream` è obbligatorio e nessun
adapter lo legge — la dodicesima istanza di *dichiarato e non collegato*, sullo
stesso confine che questa slice riscrive. Il record non lo peggiora (non tocca
quel campo e non aggiunge nessuno stato non serializzabile) e non lo ripara.
Quando lo streaming arriverà, la regola che il record impone è già chiara: uno
stream in corso non è serializzabile, quindi un turno non si sospende **a metà
stream** — lo stream finisce, poi il turno si sospende al punto di sospensione
successivo.

**Verificato eseguendo.** Un secondo processo vero costruisce il runtime di
produzione, prende un turno, apre una tool call `sys.shell` e **muore**
(`agent/turn-record-wiring.test.ts`). `muffin doctor`, eseguito **prima** che
qualunque altra cosa riparta — che è lo stato in cui l'owner apre davvero il
terminale — stampa questo, copiato dall'esecuzione:

```
! turni              1 registrati · 1 interrotti — turno crash-turn su telegram
                     (2026-08-15 20:35): il processo che lo eseguiva non c'è più
                     — 1 tool call può essere partita e non risulta conclusa
                     (shell_run), e non è dichiarata ri-eseguibile: non è
                     possibile sapere se ha avuto effetto
  → non esiste ancora un resume: se una di quelle chiamate aveva effetti sul
    mondo, controllali a mano
```

e il boot successivo — di `muffin run`, della REPL o del gateway, indifferente —
stampa la stessa frase, perché la formulazione è una sola e condivisa
(`describeInterrupted`): due punti che descrivono la stessa riga con parole
diverse sono il modo in cui un owner finisce per credere che siano due problemi.

---

**Emendamento, 2026-08-16 — i consumatori sono arrivati: ADR-0047.**

Questa ADR si chiude dicendo cosa non aveva costruito — «`wait`, il resume vero,
la consegna dalla corsia» — e lascia le righe BLOCKER apposta. Sono state
costruite in `slice/turno-sospeso`, e **ADR-0047** registra le decisioni che
scriverle ha costretto a prendere. Niente qui sopra è stato riscritto: quello che
segue è solo ciò che di questo testo va letto diversamente adesso.

- Il blocco `muffin doctor` copiato qui sopra finisce con *«non esiste ancora un
  resume: se una di quelle chiamate aveva effetti sul mondo, controllali a
  mano»*. **Quella riga non esiste più**, ed è stata corretta perché era
  diventata falsa: un resume c'è, e mandare l'owner a rifare a mano proprio ciò
  che il runtime ha deliberatamente non rifatto lo manderebbe a ripetere
  l'effetto che il record esiste per non ripetere. Adesso dice cosa la ripresa
  rifà e cosa no.
- `TurnCounters` è cresciuto di due campi nel blob JSON (`resumes`,
  `contextBuilt`), nella direzione additiva che questa ADR chiama a basso costo.
- `TurnHealth` ha una seconda domanda, `waiting`, perché `health()` contava solo
  `interrupted`: un turno sospeso da una superficie senza corsia restava
  `waiting` per sempre e non lo diceva nessuno.
- La tabella `todos` (ADR-0047 §3-4) porta un `tier` per la stessa ragione per
  cui questa ADR ha reso la taint una colonna del turno: un piano scritto da un
  turno sporco, riletto pulito dal turno dopo, è la stessa scalata di privilegio
  che avevamo chiuso da un lato e lasciato aperta dall'altro.

**Emendamento, 2026-08-17 — `claimed_by` da solo non bastava: ADR-0035
emendamento №3.** L'audit avversariale (P19, `docs/blueprint/research/audit-2026-08-16/`)
ha trovato che `checkpoint`/`finish`/`suspend` — le tre scritture che questo ADR
descrive sopra — erano guardate solo su `id` (le prime due) o `id`+`status` (la
terza), mai sul detentore: dopo un furto della riga (`reclaim()` che giudicava
"morto" un processo ancora vivo, la stessa forma di bug del lock del gateway),
il processo perdente poteva sovrascrivere in silenzio il lavoro del vincitore.
La riga sopra — *"Il giudizio di liveness è `heldBy` di `core/lock/durable.ts`,
riusato e non riscritto"* — resta vera; quello che è cambiato è `heldBy` stessa
(ordine liveness-poi-orizzonte, orizzonte duro) e una colonna nuova,
`claim_token`, la stessa forma dell'`holder_id` di quel file, che fence le tre
scritture. Il dettaglio pieno — perché, i numeri, le alternative scartate — vive
in un posto solo: ADR-0035 emendamento №3, non ripetuto qui.

---

**Emendamento, 2026-08-17 — l'intento è una precondizione dell'effetto, non un
log: `slice/wal-intent`.**

Il punto 6 sopra («Intento e esito per ogni tool call») costruiva le due righe
e non diceva cosa fare quando la prima non si lascia scrivere. Il codice
rispondeva con un `try/catch` che inghiottiva l'errore e lasciava partire
`tool.handler` comunque, motivato allora come lo stesso swallow di
`checkpoint`: un tool che funziona non va trasformato in un turno fallito da
una scrittura di contabilità. Il ragionamento resta vero per l'esito
(`endToolCall`, ancora inghiottito di proposito: una riga di esito persa si
legge «forse fatta», la direzione innocua) e **non** vale per l'intento: un
handler lasciato libero di partire senza riga fa sì che una riga mancante
smetta di significare «mai iniziata» e cominci a significare «iniziata, ma la
sua stessa ricevuta è andata persa» — per un tool non ri-eseguibile, esattamente
l'ambiguità che questa riga esiste per togliere. `MANDATO-DAY-1.md` nomina
questo l'invariante 1, «EFFECT WAL»: nessun effetto può iniziare senza che il
suo intento sia già durevole, e «provo a scriverlo e se fallisce continuo
comunque» non soddisfa la proprietà.

`runTool` ora rifiuta la chiamata quando `startToolCall` fallisce — per ogni
tool, ri-eseguibile o no, un'unica regola, non una per tipo — con un
`tool_result` d'errore esplicito che il modello legge come qualunque altro
fallimento di tool: nessun byte è entrato, quindi la taint non sale, e non si
scrive `endToolCall` per una riga d'intento che non esiste.
`TurnStore.endToolCall` guadagna anche `tier` obbligatorio nella propria
firma (audit P05, BLOCKER): opzionale permetteva un `NULL` silenzioso che saltava il bump
di taint sotto di sé — la stessa forma di difetto un livello più in basso
(ORCHESTRATION.md §15: il tipo permetteva lo stato sbagliato). Prova a
mutazione in `agent/turn-record.test.ts`: reintrodurre lo swallow fa cadere i
due casi nuovi (tool non ri-eseguibile, tool ri-eseguibile) e lascia verdi
tutti gli altri, compreso il caso felice.
