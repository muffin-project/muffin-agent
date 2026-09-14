# ADR-0077 — Il bot Telegram privato risponde solo all’owner

**Stato:** accettato · 2026-09-14 · decisione dell’owner

## Contesto

ADR-0063 descrive il filtro dei messaggi di gruppo e dice che il principal
`owner` — una DM — non passa dal gate. Il codice applica però la stessa regola
a qualunque DM: `apreUnTurno()` restituisce `true` appena vede `isPrivate`.
`identify()` distingue correttamente l’owner da un membro, ma il gate non
consuma questa identità. In produzione, quindi, un mittente sconosciuto può
raggiungere il modello con un principal `member` e una sessione separata.

## Decisione

Questo è un bot personale a owner singolo. Un DM Telegram apre un turno solo se
la stessa identità autenticata dal transport è il principal `owner`. Mittenti
sconosciuti, anonimi o non appaiati vengono scartati senza risposta, comandi,
modello, strumenti, sessione o scrittura in memoria. Dopo la decisione, il
payload grezzo del DM scartato viene rimosso dalla riga attiva dell’inbox.

La fase di pairing resta prima del gate: un codice pendente valido può ancora
legare l’owner. Il pairing non autorizza altri mittenti. La regola dei gruppi
di ADR-0063 resta invariata: tenant separati e gate su comando, menzione o reply.

## Alternative considerate

- **Prompt di pairing al mittente sconosciuto.** OpenClaw usa il pairing come
  default per i DM e ignora i messaggi fino all’approvazione. È una soluzione
  valida per bot che vogliono ammettere nuovi utenti, ma qui manderebbe comunque
  una risposta a chiunque trovi il bot. L’owner ha chiesto silenzio per ogni
  altro account.
- **Disabilitare tutti i DM Telegram.** Chiuderebbe anche la conversazione
  privata dell’owner; è più ampio del confine richiesto.
- **Lasciare che il modello decida.** Rimetterebbe l’autorizzazione nel modello,
  aggiungendo costi e un percorso di injection prima del kernel.

La forma peer è documentata nelle [regole DM di OpenClaw](https://docs.openclaw.ai/gateway/security/access-control):
pairing, allowlist, open e disabled sono scelte esplicite; un mittente
sconosciuto non viene elaborato in pairing/allowlist. Muffin usa l’identità
owner già sigillata e sceglie il blocco silenzioso, coerente con questo bot a
owner singolo.

## Conseguenze e falsificatore

Il filtro vive prima di `remember`, `command` e `work`, quindi una regressione
deve essere osservabile sul percorso completo d’ingresso. Il test di cablaggio
deve fallire se una DM non-owner chiama il modello, invia qualsiasi risposta,
crea un turno, chiama la memoria o lascia il testo nel payload attivo
dell’inbox. I DM owner e i messaggi di gruppo esistenti devono continuare a
seguire i rispettivi percorsi.

Gli update vengono prima registrati durevolmente per non perdere l’offset
Telegram; il testo sconosciuto è quindi presente nell’inbox soltanto prima che
il gate lo scarti. La cancellazione logica non equivale a cancellazione forense
dei byte già scritti nei journal SQLite.
