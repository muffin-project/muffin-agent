# ADR-0046 — Identità e contenuto sono due piani

**Stato:** accettato · 2026-08-16 · direttiva owner

## Contesto

Una surface porta nello stesso pacchetto due cose che hanno poteri opposti:

- evidenza autenticata su **chi** ha prodotto l'evento;
- contenuto che il modello deve interpretare.

Confonderle permette due famiglie di attacco. La prima è l'impersonazione: nome,
username, bio, foto o stanza assomigliano all'owner e diventano autorità. È già
successo nel connector Telegram in una forma più sottile: il codice confrontava
la chat — la stanza — invece della persona. Oggi `parseUpdate` usa `from.id`,
richiede una chat privata e ha un test di cablaggio contro l'impersonazione, ma
la regola non è ancora una proprietà obbligatoria di ogni surface.

La seconda è la prompt injection indiretta. Il veicolo non è solo la prosa di
una pagina web: può essere una bio, un display name, un filename, il titolo di
una stanza, metadata, testo dentro un'immagine, OCR, audio, una trascrizione o
la descrizione di un tool. “Lo ha mandato l'owner” non prova che l'owner ne sia
l'autore: può aver inoltrato o allegato contenuto esterno.

ADR-0044, ancora non integrata su `slice/taint-in-ingresso`, chiude una parte del
problema rendendo obbligatorio il tier sui risultati dei tool e assegnando tier
2 al disco. Non definisce il confine delle surface, né impedisce che un nuovo
campo arrivi al modello come stringa senza fonte.

## Decisione

### 1. L'autorità usa solo identità di trasporto stabile e autenticata

Ogni connector che può produrre `owner` dichiara quale tuple identifica il
soggetto: `(connector, issuer/installazione, subject-id)`. Il subject-id deve
essere opaco, stabile secondo il contratto della piattaforma e autenticato dal
trasporto. Non sono segnali d'autorità: chat id, destinazione di delivery,
username, display name, nome, bio, foto, room title, messaggio, allegato o una
deduzione del modello.

Il binding nasce da pairing nel control plane locale. Vive nel Root of Trust,
separato dalla destinazione a cui consegnare. Cambiarlo richiede re-pairing
esplicito e auditato dal control plane e invalida il binding precedente. Non
esiste un tool conversazionale che lo modifica. Una surface che non offre un
subject stabile autenticato non può produrre un principal owner: resta member
o non viene abilitata per capability owner-only.

### 2. Tutto ciò che viene letto attraversa un parser tipizzato

Ogni campo che può diventare visibile al modello viene normalizzato in un tipo
chiuso prima dell'assemblaggio del context. Il blocco porta almeno: `kind`,
fonte/provenienza, media type e trust tier. La regola comprende testo, caption,
quote e forward, nomi e bio, username, room metadata, filename e file metadata,
immagini e loro descrizioni/OCR, audio e trascrizioni, pagine web, risultati e
descrizioni di tool.

Un formato sconosciuto o una estrazione impossibile non cade su byte/stringa raw:
viene rifiutato o messo in quarantena con un esito visibile. Ogni derivato porta
il massimo tier delle fonti. Inoltrare, riassumere, descrivere, trascrivere o
spostare non lava la provenienza.

### 3. Parsing non significa fiducia

Il parser separa ruoli e rende la provenienza non omissibile; non riconosce in
modo affidabile tutte le iniezioni. Ogni valore parsato resta dati potenzialmente
avversari, delimitati nel prompt. Si assume che l'iniezione possa convincere il
modello comunque: taint, capability, resource, budget e policy continuano a
essere assegnati fuori dal modello e il kernel contiene gli effetti.

## Conseguenze

- `Principal.owner.externalId` è obbligatorio; il registry multi-surface deve
  rendere obbligatoria anche l'origine autenticata del binding.
- `ownerChatId` o equivalenti restano routing di consegna, mai autenticazione.
- Il binding Telegram corrente deve uscire dalla config ordinaria e diventare
  stato protetto prima che B15 sia chiusa.
- Il transport tipato non può esporre una borsa di stringhe. Aggiungere un campo
  model-visible richiede tipo, parser, provenance/tier e scenario ostile.
- OCR, vision e trascrizione non sono “sanificatori”: sono trasformazioni che
  ereditano taint.
- I test di una surface partono dall'ingresso di produzione e mutano sia il
  subject-id sia i metadata. Un test solo sul parser non prova il wiring.

## Alternative scartate

- **“La chat privata basta.”** Chiunque può aprire una chat privata con un bot;
  la stanza non prova la persona.
- **Confrontare username o display name.** Sono contenuto scelto dall'utente,
  modificabile e spesso non unico.
- **Lasciare i metadata fuori dal prompt.** Riduce una superficie oggi e non
  definisce la regola per quando nome, bio o filename diventano utili domani.
- **Sanitizzare le istruzioni sospette.** Non esiste un classificatore completo;
  trasforma un confine di sicurezza in una decisione cognitiva fallibile.
- **Ereditare sempre il tier del mittente.** Lava un allegato o forward esterno
  solo perché attraversa l'account dell'owner.
- **Passare raw e chiedere al modello di trattarlo come dati.** È una convenzione
  di prompt, cioè esattamente il layer che il threat model assume compromettibile.

## Stato dell'implementazione e falsificazione

Telegram prova già la parte stretta di identità: `from.id`, chat privata,
pairing fail-closed e test contro display-name/chat impersonation. Non prova il
Root-of-Trust del binding né un envelope universale per metadata e multimodale;
B15 e B16 restano blocker in `M5-BIS.md`.

La decisione è falsa o incompleta se accade uno di questi casi:

- cambiare solo nome, bio, foto o stanza cambia il principal;
- un nuovo connector può costruire `owner` senza subject autenticato;
- un campo raggiunge il modello senza tipo, fonte o tier;
- OCR, summary, vision o trascrizione abbassano il tier;
- un formato unsupported viene passato raw o ignorato dichiarando successo;
- una richiesta conversazionale può rebindare l'owner.
