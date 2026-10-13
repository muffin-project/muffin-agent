# ADR-0100 — Il budget appartiene all'attività, non al timer

Stato: adottato per l'implementazione concordata con l'owner il 13 ottobre 2026.
Amenda ADR-0086 sul rinnovo interattivo. Evidenze e alternative:
[audit della continuità](../evidence/autonomous-task-continuation-2026-10-13.md).

## Decisione

L'owner assegna un'attività, non una sequenza di permessi da rinnovare ogni pochi
minuti. Il requisito concordato è poter lavorare almeno quindici minuti e oltre,
senza un limite temporale complessivo predefinito. Quindici minuti è una soglia
di verifica, non il nuovo timeout. Rimangono i controlli della singola operazione
bloccata, il consenso agli effetti e i limiti finanziari esistenti.

Per il lavoro nuovo da input autentico dell'owner, i profili distribuiti
ammettono un budget di risorse conservato nel Turn. Richieste fisiche main e
light, esecuzioni dei tool e rinnovi automatici hanno contatori e limiti
durevoli. La prenotazione precede l'operazione ed è recintata dalla claim.
Una prenotazione persa prima della chiamata può sovrastimare il consumo; un
crash non deve invece concedere chiamate gratuite. I risultati già nel WAL
si riutilizzano senza addebitare una nuova esecuzione.

Ripresa, sospensione, checkpoint e reload non modificano il budget concesso o
il consumo. Per questa modalità i timer complessivi di drive e inferenza sono
disabilitati; il timeout della singola chiamata e il watchdog dopo attività
restano. La durata dei tool non consuma un budget temporale complessivo.

Una lease recuperabile continua internamente finché restano capacità e rinnovi.
La lane raggiunge lo stesso percorso dopo un riavvio. I marker sono controllo
del runtime, non nuove parole dell'owner e mai approvazioni. Esaurimento della
capacità, rifiuti, stop, chiavi invalide e decisioni necessarie non si
trasformano in rinnovi automatici. Un rinnovo esplicito dell'owner può concedere
altra capacità nello stesso Turn, conservando il consumo storico.

## Calibrazione e compatibilità

La prima configurazione distribuita concede 128 richieste fisiche ai modelli,
256 esecuzioni dei tool e tre rinnovi automatici. Sono valori iniziali di
policy, non risultati SOTA né equivalenti a quindici minuti. Contano anche i
tentativi falliti. I limiti finanziari restano indipendenti: il contatore di
richieste funziona anche per provider in abbonamento senza prezzo per token.

Il budget è un campo additivo del JSON dei contatori esistente; non introduce
Work/Goal, una tabella o un altro orchestratore. I record precedenti, l'input
esterno, i member e i job scheduler mantengono il percorso precedente. Una
continuazione esplicita può ammettere una vecchia attività owner alla nuova
modalità. Un profilo custom senza `activity` conserva la sua policy precedente.

## Falsificatori

- Lavoro sano interrotto da un timer complessivo a 240/300/900 secondi.
- Consumo azzerato o limite cambiato da checkpoint, restart o reload.
- Richieste o effetti oltre il budget, sotto una claim persa o senza consenso.
- Risultati/effect già registrati rieseguiti nella continuazione.
- Input esterno capace di concedere la continuazione autonoma.

L'accettazione richiede la CLI compilata, modello reale, una durata osservata di
almeno quindici minuti e un oracolo indipendente sullo stato e sugli effetti.
Una prova con tempo simulato verifica il wiring, ma non chiude quella garanzia.
