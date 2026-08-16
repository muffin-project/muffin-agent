# Muffin — Vision

> **Stato: VIVO · aggiornato 2026-08-16 · decisioni tecniche in ADR-0045/0046.**
> Questa è la nord-stella di prodotto. `docs/THESIS.md` espone la scommessa;
> `docs/blueprint/04-roadmap.md` decide l'ordine; `docs/blueprint/STATE.md` dice
> cosa esiste davvero oggi.

## Cosa diventa

Muffin è un agente personale continuo che l'owner esegue sotto il proprio
controllo. Non coincide con un'app, una chat, un device o un modello: quelli sono
porte sostituibili. L'unità che continua è un solo agente, con identità, memoria,
lavoro in corso, stato e limiti che attraversano tutte le superfici.

L'ambizione di prodotto è diventare l'interfaccia primaria al mondo digitale e,
dove esistono sensori o attuatori affidabili, a quello fisico. Il criterio non è
quante integrazioni possiede: è quali interfacce l'owner non deve più aprire
direttamente senza perdere controllo, comprensione o possibilità di intervenire.

## Il principio

**I tuoi dati, il tuo agente, la tua continuità.** Nessun cloud obbligatorio e
nessun vendor può cancellare l'identità o la memoria. Il calcolo può spostarsi da
un modello locale a un'API e da un computer a un altro; il substrato resta
sovrano e portabile.

## Tre assi

Muffin **fa** — porta avanti lavoro reale, anche lungo, usando primitive
contenute e risultati verificabili.

Muffin **capisce** — distingue episodi, credenze e provenienza; riconosce
andamenti e silenzi senza trasformare un'inferenza in un fatto.

Muffin **è presente** — resta raggiungibile mentre il lavoro è in volo, osserva
ciò che ha il diritto di osservare, riprende dopo una morte del processo e sa
quando aspettare, tacere, interrompere, chiedere, rivedere o abbandonare.
Presenza non significa attività continua: il default può essere il silenzio.

## Quattro stati, non un blob

- **Evidenza**: cosa è successo, append-only.
- **Credenze e modello della persona**: cosa Muffin ritiene vero e perché, con
  tempo e provenienza.
- **Stato del mondo**: cosa vale adesso fuori dall'agente — risorse, processi,
  disponibilità e condizioni osservate — con freschezza esplicita. Non è memoria
  episodica e non è una credenza permanente.
- **Stato del lavoro**: turni, job, attese, piani, esiti e consegne ancora dovute.

Il confine è concettuale prima che di schema. Non nasce una tabella generica
finché non esiste un consumer concreto che dimostri quali campi servono.

## Autonomia guadagnata

Conoscere meglio l'owner non dà a Muffin più permessi. La familiarità migliora
l'interpretazione; la sicurezza resta nel kernel e nel Root of Trust.

La supervisione può comprimersi solo su evidenza osservabile: stessa capability,
stessa classe di risorsa e contesto, esiti ripetutamente corretti, effetto
reversibile o recuperabile. Ogni concessione è locale, visibile, revocabile,
scade e regredisce quando fallisce. Non esiste un punteggio globale di fiducia e
il modello non è mai arbitro della propria sicurezza.

## Una sola entità, molte porte

CLI, Telegram, Discord, voce, speaker, pendant e sensori sono superfici. Ognuna
dichiara cosa può ricevere e consegnare; nessuna possiede una memoria, una
persona o una policy separata. Un device nuovo vale se rende più naturale
raggiungere lo stesso agente, non se crea un altro agente da sincronizzare.

Una porta non decide chi è l'owner da ciò che vede scritto: lo riconosce da un
identificatore stabile autenticato e pairato. Tutto il resto — testo, nomi, bio,
metadata, file, immagini e derivati — è contenuto da parsare con provenienza e
taint, mai autorità e mai implicitamente fidato.

## Il test

La visione fallisce se cambiare modello o superficie spezza la continuità. E
fallisce se, dopo mesi di uso, Muffin accumula dati ma non sostituisce nemmeno
una relazione diretta dell'owner con app, terminali o pannelli. Il primo test
vicino resta più semplice e più duro: quattordici giorni di uso reale, senza
tornare indietro per un blocker del Gate 1.
