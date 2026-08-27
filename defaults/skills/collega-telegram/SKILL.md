---
name: collega-telegram
description: Collega Muffin a Telegram, o ripara un collegamento che non funziona. Usala quando l'owner chiede di parlarti da Telegram, dice che il bot non risponde, o quando `muffin surface list` mostra telegram spento o senza token/owner.
metadata:
  origine: procedura reale di questo repo, non generica
---

# Collegare Telegram

Serve perché senza questo Muffin esiste solo nel terminale: il gateway resta
vivo, ma non ha una superficie da cui l'owner possa scrivergli quando non è
davanti alla macchina.

## Prima di tutto: guarda dove sei

```
muffin surface list
```

La riga `telegram` dice già quale dei tre pezzi manca — token, owner, o
l'abilitazione. Non ripartire da capo se ne manca uno solo.

## I tre pezzi, in quest'ordine

**1. Il token del bot — lo fa l'owner, non tu.**

Il token nasce da @BotFather su Telegram (`/newbot`, un nome, uno username che
finisce per `bot`). È un segreto: non chiederlo in chat, non scriverlo in un
file, non passarlo come argomento di un comando. Chiedi all'owner di eseguire
lui questo, e di incollare il token quando glielo chiede:

```
muffin secret set telegram_token --persist
```

Il valore arriva da stdin o dal prompt nascosto, mai da `argv` — quindi non
finisce nella cronologia della shell. `--persist` lo scrive fuori dal database,
così sopravvive a un `restore`.

**2. L'abilitazione — questa puoi eseguirla tu.**

```
muffin surface enable telegram
```

Il comando verifica il token contro il server vero prima di scrivere
qualsiasi cosa: se risponde male, il problema è il token, non la config.

**3. L'accoppiamento — chi scrive non è ancora l'owner.**

Uno sconosciuto che manda un messaggio al bot non diventa owner. Il comando
stampa un codice di pairing; l'owner lo manda al bot da Telegram e da quel
momento il suo chat id è l'owner. Se l'owner conosce già il proprio chat id
può saltarlo:

```
muffin surface enable telegram --owner <chat-id>
```

## Verifica, non assumere

```
muffin surface list
```

Deve dire `● telegram · token presente · owner <id>`. Se dice `MANCANTE`,
manca davvero: non riportare "fatto".

Poi il canale vero: chiedi all'owner di scriverti un messaggio da Telegram e
di confermare che è arrivata una risposta. Una superficie abilitata che nessuno
ha mai usato non è una superficie collegata.

## Se non risponde

- `muffin doctor` — dice se il gateway è vivo e supervisionato. Una superficie
  abilitata senza gateway non riceve niente.
- `muffin gateway status` — se il processo non c'è, `muffin gateway install`
  lo mette sotto il supervisore della macchina.
