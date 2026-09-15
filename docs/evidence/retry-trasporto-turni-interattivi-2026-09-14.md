# Retry di trasporto nei turni interattivi — 2026-09-14

## Domanda

Il limite attuale di retry basta a permettere a un turno Telegram multi-step di
superare guasti transitori del provider e riprendere dopo un riavvio senza
perdere l'errore né ripetere effetti?

## Stato osservato

- Release dogfood: `78ed149`, provider attivo `qwen/qwen3.8-flash`, profilo
  `consumer-local`.
- I metadati recenti del database mostravano turni Telegram conclusi con
  `outcome=error` dopo 2, 5, 8 e 15 tool call; uno era sotto i 20 secondi. Un
  turno aveva `delivery=pending` senza una parte di consegna e l'update associato
  riportava `Connection error.`. Non sono stati inclusi testo utente, ID,
  destinatari o contenuti dei tool in questa nota.
- La versione `78ed149` non contiene la risposta provider durevole della PR
  #537: il rethrow del provider può uscire da `runTurn` prima che il router
  abbia un risultato da consegnare. La PR #537 su `dev` aveva CI GitHub verde
  (accettazione, verifica e collegamenti) al momento della ricerca; non era
  ancora integrata.
- Il codice in quella PR possiede due retry principali e un backoff a full
  jitter con finestra massima di 8 secondi. Gli SDK hanno i retry disabilitati.
  La lane ausiliaria di memoria condivideva la stessa costante.

## Alternative e confronto

| Opzione | Vantaggio | Costo o controevidenza |
|---|---|---|
| Restare a due retry | Poco tempo e poche richieste aggiuntive | Non basta per la richiesta osservata; il turno può finire senza risposta utile. |
| Dieci retry di trasporto, backoff crescente, limite del turno e spesa invariati | Recupera interruzioni temporanee senza ripetere i tool; il budget è verificabile e persistito | Attese più lunghe e nuove chiamate al modello; tetti temporali e monetari restano vincoli reali. |
| Retry illimitato o rifare il turno | Massima persistenza apparente | Attesa/costo senza limite e rischio di ripetere effetti; respinto. |

Fonti primarie consultate:

- L'[SDK ufficiale OpenAI per Node](https://github.com/openai/openai-node/blob/main/docs/configuration.md)
  riprova due volte gli errori temporanei di connessione e gli status 408, 409,
  429 e 5xx. Muffin non eredita quel retry perché configura `maxRetries: 0`.
- Il [config di Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/config_defaults.py)
  imposta tre retry a livello applicativo per errori API transitori e dichiara
  separato il retry a basso livello dell'SDK. È prior art per un budget
  applicativo esplicito, non prova che tre o dieci siano ottimali per Muffin.
- Un [issue Hermes sul backoff assente](https://github.com/NousResearch/hermes-agent/issues/99342)
  descrive tentativi ravvicinati che peggioravano rate limit e sovraccarico; è
  un report del progetto, non una misura indipendente. Rafforza la necessità di
  backoff, non di un numero specifico.

## Scelta e limiti

L'owner ha scelto dieci retry per la chat interattiva: finestre esponenziali
con full jitter da 500 ms fino a 120 secondi, entro la durata e il budget di
spesa del turno. Il loop scrive il contatore residuo prima di ogni attesa, così
un riavvio non ricomincia da zero. La lane di memoria conserva due retry; le
tool call non acquisiscono un nuovo budget.

La risposta provider esaurita va resa un risultato d'errore Telegram sicuro e
durevole; il replay di quella consegna non deve richiamare il modello. L'evidence
locale identifica il difetto e non è un test di rete live né prova di recupero
del provider. La prova d'accettazione attesa è una suite GitHub che inietta
errori, riavvii e fallimenti di consegna sul percorso reale del gateway.

La scelta va rivista se la suite mostra che i retry si moltiplicano oltre il
limite, che un tool già concluso viene rieseguito, che la spesa eccede i tetti,
o che i turni non riprendono e non spiegano l'esaurimento su Telegram.
