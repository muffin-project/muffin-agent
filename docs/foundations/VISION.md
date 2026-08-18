# Muffin — Vision

> **Stato: VIVO · aggiornato 2026-08-18 · decisioni tecniche in ADR-0045/0046.**
> Questa è la nord-stella di prodotto. `docs/THESIS.md` espone la scommessa;
> `docs/OPEN-SOURCE-STRATEGY.md` descrive come distribuirla senza cambiarne la
> forma; `docs/blueprint/04-roadmap.md` decide l'ordine; `docs/blueprint/STATE.md`
> dice cosa esiste davvero oggi.

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

La differenza non è semplicemente che Muffin "ha memoria": altri prodotti e
agenti possono avere molta memoria e accesso a fonti personali ricchissime. La
proprietà che deve sopravvivere è che la continuità — storia, provenance,
correzioni, lavoro dovuto, effetti, costituzione e authority — resta trasferibile
e controllata dall'owner quando cambiano provider, modello, surface o macchina.

**L'infrastruttura centrale può semplificare la nascita; non deve essere
necessaria alla vita.** Un installer, un sito, metadata di release o un servizio
di bootstrap possono sparire senza spegnere gli agenti già installati. Runtime,
memoria e database degli owner non dipendono per default da una VPS di Muffin.

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

- **Evidenza**: cosa è successo e da dove arriva.
- **Credenze e modello della persona**: cosa Muffin ritiene vero e perché, con
  tempo e provenienza.
- **Stato del mondo**: cosa vale adesso fuori dall'agente — risorse, processi,
  disponibilità e condizioni osservate — con freschezza esplicita. Non è memoria
  episodica e non è una credenza permanente.
- **Stato del lavoro**: turni, job, attese, piani, esiti e consegne ancora dovute.

Il confine è concettuale prima che di schema. Non nasce una tabella generica
finché non esiste un consumer concreto che dimostri quali campi servono.

La rappresentazione fisica non è l'identità del substrato. Embedding, indici,
summary, ranking e cache sono ricostruibili; la storia canonica, la provenienza,
le decisioni, il work e gli effects non devono dipendere da uno specifico
embedding model o da una specifica versione dello schema SQLite.

## Il cold start non deve fingere di partire da zero

La continuità acquista valore vivendo con l'owner, ma una persona possiede già
anni di storia digitale prima di installare Muffin.

Quando una fonte espone un accesso appropriato, Muffin la collega tramite API,
connector, MCP o altra primitive con provenance esplicita. Quando non esiste un
accesso continuo — o l'owner non vuole concederlo — Muffin può guidare
l'esportazione ufficiale dei dati dalla piattaforma e importarli localmente.

L'importazione accelera la conoscenza, non la falsifica: conserva fonte e tempo
originali e non trasforma un archivio storico in qualcosa che Muffin pretende di
aver osservato oggi.

## Autonomia guadagnata

Conoscere meglio l'owner non dà a Muffin più permessi. La familiarità migliora
l'interpretazione; la sicurezza resta nel kernel e nel Root of Trust.

La supervisione può comprimersi solo su evidenza osservabile: stessa capability,
stessa classe di risorsa e contesto, esiti ripetutamente corretti, effetto
reversibile o recuperabile. Ogni concessione è locale, visibile, revocabile,
scade e regredisce quando fallisce. Non esiste un punteggio globale di fiducia e
il modello non è mai arbitro della propria sicurezza.

## Una sola entità, molte porte

CLI, Telegram, Discord, browser, voce, speaker, pendant e sensori sono superfici
o capability sullo stesso agente. Ognuna dichiara cosa può ricevere e
consegnare; nessuna possiede una memoria, una persona o una policy separata. Un
device nuovo vale se rende più naturale raggiungere lo stesso agente, non se
crea un altro agente da sincronizzare.

Una porta non decide chi è l'owner da ciò che vede scritto: lo riconosce da un
identificatore stabile autenticato e pairato. Tutto il resto — testo, nomi, bio,
metadata, file, immagini e derivati — è contenuto da parsare con provenienza e
taint, mai autorità e mai implicitamente fidato.

## Privacy del compute

Data sovereignty non implica che ogni inferenza debba essere locale. Implica che
l'owner sappia e governi dove vanno i propri dati.

Un provider API è compute ma è anche un destinatario del context. Muffin deve
poter distinguere almeno fra dati autorizzati al cloud e dati che devono restare
locali; un privacy transform locale può ridurre ciò che esce, ma non sostituisce
una policy di routing né il confine strutturale dei secret.

## Il test

La visione fallisce se cambiare modello o superficie spezza la continuità. E
fallisce se, dopo mesi di uso, Muffin accumula dati ma non sostituisce nemmeno
una relazione diretta dell'owner con app, terminali o pannelli.

Durante il dogfood la domanda di roadmap più utile è quindi:

> **Quale parte della mia vita digitale sono ancora costretto a gestire
> direttamente?**

Ogni fallback a un'altra app o agente è evidenza di una capability, qualità o
surface che manca; vale più di una feature inventata a tavolino.

Il primo test vicino resta più semplice e più duro: quattordici giorni di uso
reale, senza tornare indietro per un blocker del Gate 1.