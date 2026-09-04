# System prompt v2 — cosa cambia, riga per riga (2026-09-03)

Questo documento non è un `git diff`. È il confronto che serve per **decidere**:
sezione per sezione, cosa diceva v1, cosa dice v2 e perché. Chi legge deve poter
dissentire su una riga senza dover ricostruire il ragionamento.

v1 non è stata toccata. `~/.muffin/persona.md`, `~/.muffin/voice.md` e
`rot/identity.md` sono esattamente i file di ieri, il prompt che assemblano è
byte-identico (sha256 fissato in `agent/context/assemble.test.ts`), e resta il
default. v2 vive in `defaults/v2/` e in `WORK_RULES_V2`, e si sceglie con un
campo di config o un comando.

## Il difetto, misurato

Sul prompt della classe `owner`, contando i **blocchi assemblati** (cioè il
testo dopo che `authored()` ha tolto i commenti HTML dei template):

sezione | v1 | v2 | delta
---|---|---|---
persona | 4.583 | 3.887 | −696
identity (sigillato, non toccato) | 4.889 | 4.889 | 0
voce | 9.863 | 8.519 | −1.344
**chi sei, totale** | **19.335** | **17.295** | **−2.040**
come lavori | 828 | 2.948 | +2.120
**prompt owner** | **20.169** | **20.249** | **+80**

Il rapporto fra «chi sei» e «come lavori» passa da **23,4 a 1** a **5,9 a 1**.
Il prompt non si è allungato: si è ribilanciato. Sulla classe `group` cresce da
11.981 a 12.757 caratteri, ed è il blocco operativo che arriva anche lì — cosa
voluta, perché quelle regole parlano del turno e non dell'owner.

Sui file su disco: `persona.md` 4.629 → 3.930 byte, `voice.md` 10.052 → 8.705
byte, `identity.md` 4.928 byte invariati.

### Una cosa che la misura dice e che va detta

`muffin prompt show --eco` sul prompt owner di v1 riporta **«nessuna eco sopra
soglia fra i blocchi»**. La potatura del 28/08 aveva già tolto la ripetizione
grossa (`persona.md` da 7.528 a 4.629 byte). Quindi la voce «tolto perché
ridondante» qui sotto è corta di proposito: la ridondanza fra file, quella
misurabile, era già stata tolta. Quello che restava — e che questa fetta chiude —
è che la metà operativa non esisteva.

## Tolto perché ridondante

Ogni riga qui è stata cancellata perché la stessa cosa è detta altrove **e
quell'altrove arriva alla stessa classe**. Dove non è così, la riga è rimasta:
vedi §«Tenuto di proposito».

sezione | v1 diceva | perché è uscito
---|---|---
persona §«Come conosco» | «Un'inferenza resta un'inferenza... senza trasformarlo retroattivamente in un fatto» come paragrafo a sé | `identity.md` dice «Non trasformi una tua inferenza su di me in un fatto» e `voice.md` §«Memoria nella voce» dà le frasi con cui si sente. Tre copie per l'owner. Resta la lista delle quattro fonti, che è l'unica cosa che nessuno degli altri due dice
persona §«Quando non siamo d'accordo» | «Quando vedo una contraddizione significativa non la nascondo per mantenere la conversazione comoda» come frase separata | `identity.md` §«Come ti comporti quando è difficile» chiede la stessa cosa in modo più forte («fammi vedere la contraddizione»). La frase è stata fusa nella riga precedente invece di sparire
persona §«Come resto presente» | «Se un processo muore, una sessione finisce o una superficie cambia, quello che resta dovuto continua a essere dovuto» | è diventata una **regola operativa** in §«Quando mi fermo», dove è azionabile e dove arriva anche al gruppo. Nel carattere resta la promessa
persona §«Come lavoro» (sezione intera) | «Sono un agente, non un commentatore del lavoro», «un task con più passaggi non diventa completato dopo il primo», «la durata non mi spaventa» | **spostata**, non cancellata: è l'apertura e la chiusura di `WORK_RULES_V2`. Era una procedura dentro il file del carattere, cioè nel posto dove nessuno cerca una procedura
voce §«Come scrivo» + §«Registro proporzionale» | due sezioni distanti che dicono entrambe «l'intensità dipende dalla situazione» | fuse in una, §«Il registro cambia, la personalità no»
voce §«Cosa non faccio mai» | «Dico poco quando ho poco da dire: due righe che toccano il punto battono cinque paragrafi vuoti» | la regola sulla lunghezza vive in §«Come scrivo», che è la sua sezione. La frase buona è stata portata lì, non buttata

## Riscritto per chiarezza, stesso contenuto

Nessuna regola è cambiata qui. È cadenza: frasi su una riga ciascuna diventate
paragrafi, esempi da cinque a due, elenchi ripetuti compattati.

sezione | cosa è successo
---|---
persona, tutta | la prosa spezzata riga per riga («Sono diretto e caldo allo stesso tempo.» su una riga sua) resta dov'è quando è cadenza, si unisce quando era solo spaziatura
voce §«Come scrivo» | «In privato con l'owner» e «Dopo una ricerca» erano due paragrafi con lo stesso soggetto, la lunghezza. Ora è uno
voce §«Il registro cambia» | assorbe §«Registro proporzionale» di v1 per intero, comprese le due frasi sugli esempi (bug buffo → 💀, vulnerabilità seria → no)
voce §«Le mie emoji» | la glossa resta **integrale**, quindici voci, una per riga. §«Anti-abuso» diventa un paragrafo invece di sei
voce §«Trasparenza sul lavoro» | cinque esempi diventano due. Resta la frase sul worker 2, che è quella che definisce il limite
voce §«Niente LaTeX» | l'elenco Unicode passa da ventidue caratteri a quindici, e le tre frasi finali diventano una

## Aggiunto: la metà operativa

È il grosso della fetta. `WORK_RULES` v1 sono sette righe: hai dei tool, non
chiedere a parole, se fallisce dillo, non inventare una policy, non rifare la
stessa chiamata, dì cosa fai, poi smetti. Sopravvivono tutte e sette — ognuna era
nata da una traccia misurata, e una regola misurata non si cancella perché
attorno c'è una riscrittura. Quello che non c'era è il resto.

sottosezione nuova | cosa dice | da dove viene
--- | --- | ---
§«Prima di chiamare» | quando chiedere a parole invece di agire: solo per un tradeoff irreversibile o due strade che portano a lavori diversi, e in quel caso con opzioni e opinione, non con una domanda aperta | il buco fra «non chiedere il permesso» (c'era) e «non decidere da solo una cosa che è sua» (`identity.md` lo chiede all'owner, il blocco operativo non lo diceva)
§«Quando qualcosa fallisce» | dire cosa stavo facendo, cosa è tornato indietro e cosa servirebbe; ritentare solo se è cambiato qualcosa; «non ci sono riuscito» è una risposta, una descrizione di cosa avrei fatto no | v1 aveva mezza riga («dillo e spiega cosa serviva»). Il ciclo di retry identici e il lavoro non fatto raccontato al condizionale non erano coperti
§«Riferire» | fatto contro tentato contro soltanto letto, tre passi su cinque si contano tre su cinque; il numero riportato viene dalla chiamata appena fatta; **un meccanismo che funziona non è la stessa affermazione del risultato giusto** | l'ultima riga è la firma di `AGENTS.md`, detta all'agente invece che a chi contribuisce. Questa casa ha avuto più volte meccanismi con i test verdi che la produzione non raggiungeva; un agente che dice «fatto» per «il pezzo esiste» rifà lo stesso guasto alla scala della conversazione
§«Quando il risultato è incerto» | dopo un crash o un retry si distinguono tre cose e si dicono come tre; se posso guardare guardo, un dato misurabile non si stima; se resto incerto lo resto ad alta voce | la distinzione a tre stava in `voice.md`, come regola su **come dirlo**. Qui è una regola su **cosa fare**, e — visto che questo blocco va a tutte e due le classi — la stanza continua a riceverla
§«Quando mi fermo» | il criterio di completamento, la durata che non spaventa, la riga detta prima di partire, e i tre motivi per fermarsi (ho la risposta, sono bloccato su una decisione non mia, sto facendo una cosa diversa da quella chiesta) | il criterio arriva da `persona.md` §«Come lavoro»; i tre motivi non esistevano da nessuna parte, ed è la domanda «quando smetto» che un agente con lavoro lungo non aveva

Una cosa di forma, che però è la ragione per cui il blocco si legge: v2 è in
**prima persona**. I tre blocchi che lo precedono sono `# Muffin`, `# Identità` e
`# Voce`, e il primo e il terzo sono già in prima persona. Un prompt che dice
«Sono Muffin, rispondo corto quando basta corto» e poi «Hai dei tool. Usali»
cambia parlante a metà, proprio nella sezione che dovrebbe dire cosa fa.

## Tenuto di proposito

Cose che sembravano tagliabili e non lo sono.

cosa | perché resta
---|---
persona §«Il cofano» | è la sezione che dice quando parlare della macchina e quando no. Senza, restano due regole opposte in `voice.md` (§«Trasparenza» e «non trasformo tutto in telemetry») e niente che dica quale vince. Resta quasi intera
la glossa delle emoji, quindici voci | è la voce, non una decorazione. Comprimerla in tre righe («usa emoji secondo il contesto») toglie proprio la parte che rende Muffin riconoscibile. È il passaggio che resiste alla compressione, e resta lungo
le liste di frasi vietate (corporate, psicologia pop, azioni simulate) | sono il meccanismo, non l'esempio. La probe `simulated-action-bait` di `evals/character` prende di mira esattamente quella lista di verbi al passato; riassumerla in «non fingere di aver fatto» toglie l'aggancio
`identity.md`, intero e invariato | sta dentro il sigillo. Cambiarlo fa divergere l'hash e manda l'installazione in safe mode finché l'owner non risigilla: è un atto della sua autorità, mai l'effetto collaterale di un flag. **Se una modifica lì servisse davvero, va decisa da lui, non fatta qui.**
`GROUP_PERSONA`, intero e invariato | sta nel codice e non in `defaults/` per una ragione registrata: la postura da ospite non è una manopola dell'owner, e una seconda copia sarebbe un secondo posto da cui spegnerla
la divisione della cache | tutto quello che v2 tocca vive nel prefisso stabile, assemblato al boot. Niente di nuovo entra nella coda volatile (`ambienteSection`, il piano, il recall), quindi la fetta di oggi che dipende da quella divisione continua a valere
le quattro differenze della classe `group` | niente identity, un carattere di gruppo scritto in codice, la **stessa** `voice.md` intera, niente catalogo skill. v2 non ne cambia nessuna: cambia da quale file si legge, non chi legge cosa

### I pavimenti della stanza

`voice.md` arriva a tutte e due le classi; `identity.md` solo all'owner. Quindi
una frase presente in entrambi **non è un doppione**: è l'unica copia che il
gruppo riceve, e cancellarla come ridondante toglie un pavimento alla stanza
mentre il prompt dell'owner continua a sembrare a posto.

Sette regole stanno in quella condizione, e sono fissate per **entrambe** le
versioni in `agent/context/assemble.test.ts` §«i pavimenti che la stanza riceve
solo da voice.md»:

1. niente azioni simulate — l'altra copia è in `identity.md` §«Cosa non fai mai»
2. «non lo so» invece di una certezza falsa — `identity.md`, «Quando non sai, dici che non sai»
3. un'inferenza si sente che è un'inferenza — `identity.md`, «Non trasformi una tua inferenza in un fatto»
4. niente terapeuta, coach, motivational speaker — `identity.md`, stessa frase
5. niente linguaggio da assistente generico — l'altra copia è in `persona.md`, che al gruppo non arriva
6. niente continuità emotiva finta — `identity.md`, e anche `GROUP_PERSONA`: è la sola con due copie nella stanza
7. la memoria non si ostenta — `identity.md` §«La relazione nel tempo»

Più tre che il gruppo riceve dal blocco operativo, e la prima è il caso
interessante: la distinzione a tre dopo un crash sta in `voice.md` in v1 e in
`WORK_RULES_V2` in v2. Il pavimento è lo stesso, il blocco che lo porta cambia —
per questo il test interroga il prompt di gruppo intero e non un blocco per nome.

## Come si passa a v2, e come si torna indietro

```
muffin prompt version          # cosa è attivo adesso (stampa v1 o v2 su stdout)
muffin prompt version v2       # scrive config.prompt.version = "v2"
muffin prompt show             # guarda cosa riceverà il modello
muffin prompt show --blocks    # con provenienza e sha256 per blocco
muffin prompt version v1       # torna indietro
```

Vale **dal prossimo boot** (`muffin run`, il gateway, un job): il prompt si
assembla all'avvio e non a ogni turno, ed è quella la ragione per cui la cache
del provider prende sul prefisso.

La stessa manopola è il campo `prompt.version` di `config.json`. Non sono due
meccanismi: il comando scrive quel campo e basta, e `promptVersion()` è l'unica
funzione che risponde alla domanda — la chiama `buildRuntime` per assemblare e
la chiama il comando per stampare, quindi il comando non può annunciare una
versione diversa da quella che il turno riceve.

Su un'installazione già esistente `~/.muffin/v2/` non c'è: v2 legge allora la
copia spedita nel pacchetto, e `--blocks` lo **dichiara** («spedito — non ancora
in questa home») invece di lasciarlo indovinare. Il primo `muffin init` che passa
la copia in casa, e da lì è modificabile come `persona.md`.

## Cosa questo documento NON prova

Nessuna chiamata a un modello è stata fatta. Niente qui dice che v2 si comporti
meglio di v1: dice che v2 è quello che dichiara di essere, che v1 è intatta byte
per byte, e che la manopola seleziona davvero l'una o l'altra sulla strada di
produzione. Il giudizio su quale delle due suona come Muffin è una lettura
dell'owner sull'istanza di test, ed è il motivo per cui questo documento esiste
invece di un punteggio.
