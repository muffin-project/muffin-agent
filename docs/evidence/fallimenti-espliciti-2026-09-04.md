# Ogni fallimento importante è esplicito e recuperabile? — la sintesi di E5

**Perché una sintesi e non un sottosistema.** La riga E5 era COMPOSITE per
scelta: *«non creare un "E5 subsystem": chiudere B6/ASK/delivery/
scheduled-work e poi fare una synthesis integrata delle classi residue»*.
Le parti sono chiuse (D12, B8, B10-errori, E1, B7 fra oggi e ieri). Questa
è la sintesi: per ogni classe di guasto, **cosa vede l'owner**, **come si
recupera**, **quale scenario lo prova sul binario vero**.

| classe | cosa vede l'owner | recupero | prova |
|---|---|---|---|
| processo morto a metà turno | al riavvio la riga del turno viene **nominata**, non persa | il supervisore riparte e il gateway finisce il turno | A1, B5 |
| SIGKILL fra «prendo il job» e «apro il turno», o fra «finito» e «segnato» | mai due esecuzioni, mai zero | il bind durevole decide chi ha già fatto cosa | B7 |
| consegna su un canale non connesso | `failed:<perché>` sulla riga, **mai** `sent` | il prossimo drain riprova senza ricalcolare la risposta | B8 |
| Telegram rifiuta a metà consegna (400) | la parte resta `rejected` con la ragione; `possibly_sent` se il processo muore durante il tentativo | il turno successivo la completa; `possibly_sent` è terminale e visibile, mai silenziosamente `pending` | B10-errori, `delivery.ts` |
| tetto di spesa (mensile, per job) | il turno **non parte** e lo dice; il job scrive una riga `budget` e consegna il motivo sul suo canale | alzare il tetto, o `jobs cap` | E1 |
| approvazione senza nessuno che possa darla (headless) | `exit 3` con **la risorsa intera** nel motivo | rilanciare interattivo, o rispondere dal pulsante Telegram (coda durevole) | D10 terzo blocco, D12 |
| risorsa negata dal kernel | un `tool_result` con `resource_denied` e la ragione, che il modello legge | il modello riformula; l'owner vede la traccia | D6, D10, `link-copiato-non-e-composto.test.ts` |
| tool che fallisce | `tool_result` `isError` con `retryable` dichiarato; il modello lo dice invece di inventare | riprova se `retryable`, altrimenti lo riporta | character eval `tool-fails` (pass), `agent/loop.ts` |
| giudice della memoria illeggibile | spiegato su `muffin memory review`, non ripetuto a pappagallo | rieseguire l'estrazione | E5 (scenario) |
| file del Root of Trust manomesso | `muffin doctor` lo **nomina** con il rimedio | `muffin rot reseal` dopo aver guardato | A5 |
| aggiornamento che fallisce (`npm ci`) | la release nuova viene cancellata, **il codice in esecuzione non è toccato** | rifare `muffin update` | A6; osservato dal vivo il 04/09 (`prepare` rotto) |
| sandbox assente | `shell_run` non viene nemmeno offerto; `sys_inspect` e `doctor` dicono perché | installare bwrap/seatbelt | D4, E7 |
| rete assente | log datato «polling fallito … rete tornata dopo Ns»; backoff, mai un loop stretto | automatico | #383, `gateway.err` del 04/09 |
| modifica sbagliata su disco | `muffin undo` mostra cosa farebbe, con `--yes` rimette; turno e memoria **marcati** | `undo`, `annulla-<turno>` | D3, D11 |
| verdetto del gate preso su host conteso | `CI-LOCAL DISCARDED`, exit 2 | rifare da soli | #424 |

## Cosa resta implicito, dichiarato

- **Timeout di un turno**: il tetto c'è (`--timeout`), l'esito è
  `interrupted` e viene descritto (`describeInterrupted`); non ha uno
  scenario suo — è coperto di sponda da B5. Non blocca: il modo di fallire è
  esplicito, manca solo la prova dedicata.
- **Provider che risponde 5xx a metà stream**: retry con backoff nel client;
  la prova è unitaria, non sul binario. Idem.
- **Disco pieno durante una scrittura di memoria**: da oggi (#425) non spegne
  la superficie; l'episodio viene perso **con una riga di log**, non
  silenziosamente. Non è ancora «recuperabile» (non c'è coda di ritento) ed
  è la classe più debole di questa tabella.

La domanda di E5 — *esplicito e recuperabile* — ha oggi una risposta per
ogni classe che l'uso reale ha prodotto, e le tre classi sopra hanno il
modo di fallire esplicito e il recupero dichiarato come manuale o assente.
Questo è ciò che la riga chiedeva; il resto nasce dall'uso, non da qui.
