# ADR-0093 — La domanda di approvazione è un passo del turno

**Stato:** accettato · 2026-09-29 · evidenza:
`docs/evidence/approvazione-nel-processo-2026-09-29.md` (database
dell'installazione viva, 29/09/2026; accettazione D12). Rovescia il punto 1
della §5 di `docs/evidence/forma-delle-superfici-2026-09-03.md`.

## Contesto

`forma-delle-superfici-2026-09-03` aveva già misurato il difetto: la domanda
di approvazione su Telegram era un **canale a parte** — un messaggio autonomo
con la tastiera (`approvatoreTelegram`) mentre la trascrizione del turno
scriveva la stessa attesa come passo `⏸`. Le sue tre raccomandazioni sono
state attuate nel tempo: la tastiera si toglie per costruzione
(`editMessageReplyMarkup` esplicito), il passo si risolve (`resolveAsk`), il
turno ripreso riacquista `onDelta`/`onProgress` (`attachStream`). La §5
raccomandava però di **mantenere** il messaggio autonomo: cancellarlo avrebbe
tolto la traccia di un pulsante premuto.

Il 29/09/2026 l'owner ha guardato un turno che aveva chiesto **nove**
approvazioni (tutte `sys.shell`, tutte concesse): nove bolle residue sopra la
risposta, accanto al messaggio del turno con il `Processo` collassato. La
traccia c'era — nel registro e nel passo — e il costo era il rumore. La
richiesta: la domanda va **convertita nella sezione Processo**, non lasciata
come bolla a sé.

## Decisione

1. **La domanda è un passo del turno, sul messaggio del turno.** Quando una
   trascrizione viva può ospitarla, `Transcript.ask()` apre il messaggio vero
   del turno — anche in una stanza che preferirebbe la bozza, perché i
   pulsanti non vivono su un'anteprima effimera — scrive la domanda come passo
   `waiting` **visibile**, e le attacca la tastiera. Da lì in poi il turno vive
   su quel messaggio: la risposta che si forma lo edita e la consegna finale
   lo ripiega nel `details`.
2. **La tastiera viaggia con ogni edit finché è viva**, e si toglie per
   costruzione quando l'owner risponde (`resolveAsk`) o il turno si ferma
   (`stop`): la pagina ufficiale non promette cosa fa un edit che omette
   `reply_markup`.
3. **Il contenuto della domanda resta nel Processo.** `resolveAsk` non
   sostituisce più il passo con la sola parola «consentito»: appende il
   verdetto al contenuto (prompt, descrizione, comando, taint), che la
   consegna finale collassa nel `details`. La traccia che la §5 temeva di
   perdere è **dentro** il messaggio, non in una bolla separata.
4. **In DM la consegna di un turno con domanda è un edit a blocchi dello
   stesso messaggio** (processo in `details`, risposta nativa): la forma che
   il turno avrebbe avuto come invio nuovo, applicata al messaggio che esiste
   già. Una bolla sola per turno, sempre.
5. **Ripiego garantito.** Se nessuna trascrizione viva può ospitare la
   domanda (processo riavviato fra domanda e risposta, turno ripreso da
   un'altra lane, trascrizione spenta da un rifiuto), `approvatoreTelegram`
   manda il messaggio autonomo con la tastiera sull'ultimo pezzo, come prima:
   la domanda non resta mai muta, e `handleCallback` sa distinguere i due casi
   (`approvalSulTurno`) — sul ripiego edita e chiude la bolla, sulla
   trascrizione lascia fare a `resolveAsk`.
6. **Il vocabolario è uno.** `connectors/telegram/approval.ts` possiede
   `askHtml`/`askPlain`/`askKeyboard` e il ripiego; la trascrizione e
   l'approvatore dicono le stesse parole, e la bolla autonoma non è una
   seconda resa da mantenere allineata a mano.

## Alternative considerate

- **Cancellare la bolla dopo la decisione** (`deleteMessage`): respinto —
  rompe l'invariante «Nothing is deleted» della trascrizione e la §5 della
  memo 03/09 (un pulsante premuto che sparisce è indistinguibile da uno mai
  arrivato). La forma scelta non cancella niente: ripiega.
- **Lasciare la bolla e toglierle solo la tastiera** (la §5 del 03/09):
  respinto dall'owner con la misura — nove bolle per un turno.
- **Mandare la domanda come bozza** (`sendMessageDraft`): respinto — una
  bozza è effimera e non porta pulsanti.
- **Stato d'invito o id del messaggio nel database**: non necessario — la
  trascrizione viva è per chat (una lane, un turno), e il ripiego copre i
  casi in cui non c'è.

## Cosa può smentire la scelta

- Client Telegram che rifiutano `reply_markup` su un edit di messaggio rich a
  blocchi: la tastiera non arriverebbe e il ripiego non scatterebbe (il send è
  riuscito). Se accade, `ask()` deve verificare la tastiera con una chiamata
  dedicata e ripiegare.
- Un turno che chiede due approvazioni con lo stesso nome prima che la prima
  torni: il passo è deduplicato per capability, e la seconda domanda
  riuserebbe lo stesso passo — se la misura mostrasse il caso, la chiave va
  estesa con l'id dell'approvazione.
- Un edit del processo che perde la tastiera nonostante `reply_markup`
  esplicito: la pagina ufficiale non promette la semantica, quindi la
  verifica è sul campo; in quel caso si passa a riattaccarla dopo ogni edit
  (una chiamata in più per finestra).

## Complementi (non in questa slice)

- Pulizia delle approvazioni orfane (tre righe del 14/09, turni `done`):
  nessun turno le attende, ma restano nel registro.
- Un `ask` su una superficie senza pulsanti (CLI) non passa da qui: il
  vocabolario condiviso è Telegram-only finché non serve altrove.
