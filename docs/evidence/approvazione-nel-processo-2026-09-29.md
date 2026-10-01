# La domanda di approvazione come passo del turno — 2026-09-29

Misura in sola lettura su `~/.muffin/muffin.db` e prova sull'harness di
accettazione. Serve ADR-0093; non contiene testo dell'owner.

## 1. Cosa si vedeva

Un turno Telegram del 29/09 (`0ff42477…`, «una storia lunga 10000
caratteri») ha chiesto **nove** approvazioni, tutte `sys.shell`, tutte
concesse. Ogni domanda era un **messaggio a parte** con la tastiera
(`cli/surface.ts#approvatoreTelegram`), editato in `✓ consentito` dopo la
decisione: nove bolle residue sopra la risposta, accanto al messaggio del
turno con il suo `Processo` collassato. Lo screenshot dell'owner ne mostra
quattro prima che il turno continuasse a chiedere.

Il registro lo conferma:

```text
SELECT turn_id, count(*) FROM approvals WHERE asked_at > '2026-09-29' GROUP BY turn_id;
0ff42477… 9        -- decisione: 9 allow, 0 pending; 6 consumate
```

Stato finale del turno: `done` / `answered` / `delivery=sent` alle 16:02.
I turni delle tre approvazioni del 14/09 rimaste `decision IS NULL` sono
`done` da allora: righe orfane, non attese (nessun turno `waiting` in DB).

## 2. Perché era così

`docs/evidence/forma-delle-superfici-2026-09-03.md` §4.2-§4.4 l'aveva già
registrato: due rappresentazioni simultanee della stessa attesa — la riga
`⏸ … aspetto la tua approvazione` dentro il segmento e il messaggio a parte
con la tastiera — e la riga interna che non si risolveva mai. Le tre
raccomandazioni di §5: togliere la tastiera per costruzione (fatto, `api.ts`
manda `reply_markup: {inline_keyboard: []}` esplicito), risolvere il passo
(`resolveAsk`, fatto), restituire `onDelta`/`onProgress` al turno ripreso
(`attachStream`, fatto). La bolla separata, però, restava: la §5 la voleva
mantenuta per non cancellare la traccia di un pulsante premuto. Il 29/09
l'owner ha visto il costo di quella scelta — nove bolle per un turno — e ha
chiesto di ripiegarla nel Processo. ADR-0093 rovescia quel punto: la domanda
diventa un passo del turno, quindi la traccia non si perde e non c'è niente
da cancellare.

## 3. Cosa fa la forma nuova

- `Transcript.ask()` apre il **messaggio del turno** anche in una stanza a
  bozza (la tastiera non vive su un'anteprima effimera), scrive la domanda
  come passo `waiting` visibile e le attacca la tastiera; ogni edit successivo
  la ripassa, perché la pagina ufficiale non promette cosa fa un edit che la
  omette.
- `resolveAsk` toglie la tastiera per costruzione e **conserva il contenuto
  della domanda** nel passo (prompt, descrizione, comando) con il verdetto
  appeso: la consegna finale ripiega tutto nel `details` del Processo.
- La risposta che si forma edita quel messaggio (`messaggioDelTurno`), e la
  consegna in DM è a sua volta un **edit a blocchi** di quel messaggio, non un
  invio nuovo: una bolla sola per turno, anche quando chiede il permesso.
- Se nessuna trascrizione viva può ospitarla (processo riavviato, altra lane,
  trascrizione spenta da un rifiuto), `approvatoreTelegram` manda la bolla
  autonoma come prima: la domanda non resta mai muta, e la tastiera non
  risponde mai a chi non l'ha fatta.

## 4. Prova

- Unit: `transcript.test.ts` (la domanda apre il messaggio vero in DM, la
  tastiera viaggia su ogni edit, `report('ask')` non duplica il passo,
  `resolveAsk` toglie la tastiera e conserva il contenuto, `handoff()` nomina
  quel messaggio, il ripiego quando il send fallisce); `approval.test.ts`
  (vocabolario condiviso e bolla autonoma).
- Accettazione D12 (`b-telegram-journey.accept.ts`): la domanda è il messaggio
  del turno con la tastiera; il click dell'impostore non decide; il click
  dell'owner risolve; la tastiera sparisce con un `editMessageReplyMarkup`
  esplicito e vuoto; la risposta finale è un **edit dello stesso messaggio**
  (stesso `message_id`), a blocchi, con il verdetto dentro il `details`.
- Suite completa verde (unit + accettazione) sul head della slice.
