# Telegram: prima il risultato

Base `dev@53c7eb57`. Il gateway compilato, con modello e Bot API simulati,
ha riprodotto B13: per una risposta costruita da due ricerche in memoria,
la bozza mostrava i passi e il messaggio finale li riteneva nel blocco
«Processo», con le query. In un gruppo il processo può creare messaggi
durevoli prima del risultato. La critica dell'owner del 22/11 è sul default
di chat, non sul valore delle evidenze operative.

| Alternativa | Evidenza e limite | Scelta |
| --- | --- | --- |
| Tenere il registro collassato o spostarlo sotto la risposta | [Grok Bot](https://docs.x.ai/grok-bot/chat-and-collaboration) documenta attività nel transcript. Muffin collassa già il registro in privato; è proprio la forma giudicata estranea alla conversazione. Nei gruppi resta rumore durevole. | Non adottata come default. |
| Rimandare tutto a un elenco di task o a un Mini App | [Dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) documenta il dettaglio del singolo task; [Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) separa Tasks, Make e conversazione, che fa emergere esiti e decisioni. Telegram non ha quelle superfici nell'app del bot. | Non introdurre un archivio parallelo per la sola presentazione. |
| Usare presenza e bozza native, consegnare risultato o decisione | [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/#mobile-friendly-progress-defaults) documenta dettagli tool spenti per default su Telegram. La Bot API documenta [typing](https://core.telegram.org/bots/api#sendchataction), [bozza con Stop](https://core.telegram.org/bots/api#sendrichmessagedraft), [tastiere e callback](https://core.telegram.org/bots/api#inlinekeyboardmarkup), e [limiti di chat e gruppo](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this). | Usare le primitive già cablate. Il processo tecnico resta nelle tracce e nel journal dietro la chat. |

Sono fonti ufficiali, non una prova su account nei prodotti dei peer.

**Falsificatore:** il giro multi-tool in DM deve mostrare vita mentre lavora,
poi un solo risultato durevole senza registro, anche con fallback testuale.
Gruppo e topic non ricevono bolle di passo. Una domanda di approvazione deve
restare leggibile e attribuibile all'azione giusta, col pulsante funzionante.
Il riavvio non deve duplicare la consegna o l'effetto. Il profilo è CRITICAL
per la verifica delle cuciture con approvazione e consegna; il cambio è di
presentazione e non ridisegna le regole che autorizzano l'azione.

## Evidenza della candidata locale

- B13 sul gateway compilato: due chiamate a strumenti, stato nella bozza con
  Stop e un unico risultato durevole senza query dello strumento o registro.
- Nel topic (#744) digitazione e un risultato nel topic d'origine, niente
  bozza né edit di progresso. Nei test del connettore: streaming mentre il
  provider è ancora aperto, fallback testuale e Stop nativo.
- D12 e #746: domanda esatta, pulsanti, risoluzione della domanda giusta e
  riuso del messaggio a fine turno. #783 e #598: approvazione dopo riavvio e
  consegna di un obiettivo differito al destinatario originale.

Gateway e storage reali in isolamento, Bot API e provider di prova. Non
osservato: rendering del client reale con questa candidata. Installazione
dell'owner e bot in servizio non coinvolti.
