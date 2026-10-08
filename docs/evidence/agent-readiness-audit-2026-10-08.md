# Cosa manca a Muffin per essere un vero agente — audit 2026-10-08

**Domanda.** Non "cosa manca al runtime", ma: cosa impedirebbe oggi di vivere
14 giorni usando esclusivamente Muffin, e cosa lo dimostrerebbe?

**Metodo.** Riletti il 2026-10-08: `THESIS.md` (i tre falsificatori),
`VISION.md` (le cinque domande post-DAY-1), `ROADMAP.md` (il dogfood come
finestra di osservazione, non sprint), `critical-path.md` e
`requirements-status.md` (una sola riga non-READY: A11 `? PARZIALE`).
Spazzate le 72 issue aperte per temi e aggancio DAY-1; riesaminata tutta
l'evidenza datata d'uso reale (ultimo dogfood datato: 29/09/2026, nulla dopo).

## 1. Il test della tesi, applicato oggi

La tesi è falsificabile in uso. Applicata a HEAD:

1. *Cambiare modello o superficie cambia chi è l'agente?* — Non misurato dopo
   agosto. La baseline character (04/09) esiste, ma nessuna misura dice se il
   passaggio qwen→altro o CLI→Telegram cambi identità, memoria o obblighi.
2. *La storia sopravvive alla riscrittura dell'harness?* — Architetturalmente
   sì per disegno (canonical vs derived vs harness, migrazioni, backup); mai
   provato da una riscrittura reale con verifica semantica post-migrazione.
3. *Mesi d'uso tolgono interfacce dirette all'owner?* — **È il buco.** Non
   esiste un ledger dei fallback (cosa l'owner apre ancora direttamente:
   mail, calendario, browser, altro agente) — la domanda primaria della
   roadmap non ha un solo conteggio datato.

## 2. Le cinque domande della vision: stato delle evidenze

| Domanda | Evidenza d'uso reale |
|---|---|
| Cosa gestisci ancora direttamente (fallback)? | **Zero conteggi.** Solo prosa d'audit e un episodio Tavily non verificato. |
| Che lavoro promesso viene dimenticato (loop-closure rate)? | Meccanismi sì (continuable, code), tasso no: 8 righe `continuable` ferme dal 19/09, un deferral di 9 giorni in `gateway.err`, nessun N promessi / M chiusi / K persi. |
| Quanto interrompe a vuoto (precisione)? | **Zero misure live.** H2/H5 restano `EXPERIMENT` con kill criteria ma senza numeratore/denominatore; eredità negativa sola (heartbeat legacy REJECTED). |
| Quale meccanismo rende più capace vs sembra intelligente? | Solo bench (costo/qualità reasoning su Pi, e2e passi). H1/H3/H6 `UNTESTED`, H4 un'istanza stretta. Nessun valore dogfood sulle metriche §6 di COGNITIVE-DESIGN. |
| Cosa fallisce per dispositivo sbagliato? | **Zero.** I Node sono direzione dichiarata, nessun episodio "dato sul dispositivo sbagliato". |

Uso intenso via Telegram/CLI è provato fino al 30/09 (DB, turni, filo reale).
Dopo il 29/09 l'evidenza datata è solo builder (bridge, lane, AppArmor,
installer): **nessuno sta misurando la vita dell'agente adesso.**

## 3. Cosa manca, in ordine

1. **La corsa di 14 giorni con fallback ledger.** Non è una feature: è
   l'esperimento che manca. Bloccata da (2). Senza, ogni riga READY resta una
   claim sulla macchina, non sull'agente — la lezione del 03/09 (B11/B13 verdi
   su harness, rotte per l'owner).
2. **A11: installazione e persistenza su ferro reale** (#654). Unica riga
   non-READY. Lato branch risolto (#869 mergiata); lato VPS mancano chiave
   provider, finestra di reboot e via alla rimozione — poi la corsa può partire.
3. **Capability reachability sotto carico** (#854 in flight: rebase autore,
   poi giudice e integrazione). Un tool autorizzato troncato dal cap è il
   "capability miss" quotidiano che rimanda a un'altra interfaccia.
4. **Integrità dell'accumulo di memoria** (776: S1 atterrata, reconciler da
   fare; 858/859 authority e provenance di forget/proactive). Quattordici
   giorni di memoria che si corrompe (narrazione del modello, snapshot che
   decade) sono peggio di nessuna memoria.
5. **Verità dell'unattended** (#598: slice atterrate, silent-resume incluso).
   Il dogfood deve provare il comportamento needs-owner, non solo il resume.
6. **Eval flywheel** (#852): lo strumento che trasforma il ledger in gate di
   regressione. Senza, ogni osservazione muore in un documento.
7. **Misure, non meccanismi**: burden taint/approval a regime, precisione
   delle interruzioni, envelope di 14 giorni (provider vuoti, resume dopo
   restart senza doppi effetti, spesa vs cap). H2/H5 e i §6 cognitivi
   aspettano numeratori, non codice.

## 4. Cosa NON costruire (con trigger di ritorno)

Breadth per interfacce (mail/calendario/browser/computer come capability,
#853/#855/#856/#521, estensioni/Skills/MCP #672/#673/#725, Node oltre il
minimo, discovery generalizzata oltre #469, multi-Home, plugin framework):
il ledger decide, non la lista. La roadmap congela la crescita cognitiva
durante la finestra; la tesi chiede uso prima di primitive. Ogni voce resta
dove ROADMAP.md la mette finché un dolore contato non la promuove.

Residuals dichiarati, non blocchi: sink memoria s7 aperto con ragione (ADR-0069),
carve-out node_modules del pre-scan, tripwire macOS/Linux del replacement
mid-command, reseal single-user indistinguibile (B15), D6 `hasParams`, E5
recovery manuale, #657 core.hooksPath.

## 5. Addendum 2026-10-08 — enabling-minimum breadth prima del ledger

Obiezione dell'owner accolta: senza un minimo di breadth la corsa non può
partire, e il suo ledger del giorno 1 direbbe solo "manca tutto". La regola
del §4 si raffina in due tempi, non si cancella:

- **Breadth abilitante minima PRIMA del giorno 1**: al massimo 1–3 capacità,
  fetta più sottile possibile, solo quelle senza cui i 14 giorni non possono
  partire. Lo decide l'owner (solo lui conosce le sue giornate). Aperte ora:
  email read-only (#871), calendario read+create (#872), spike browser via
  MCP senza nuovo core (#873), più la verifica end-to-end di tutta la breadth
  esistente compreso il self-knowledge (#874, compone con #854).
- **Breadth guidata DAL ledger DOPO**: tutto il resto si costruisce solo su
  dolore contato — e il ledger parla già al giorno 3–4, non aspetta il 14.

Il resto dell'audit resta valido: meccanismi misurati, deferral fermi,
residuals dichiarati.

## 6. Criteri di falsificazione di questo audit

- Se il ledger conta ≥1 fallback/giorno su una capability, quella capability
  entra nel prossimo lavoro prima di qualunque deferral.
- Se 14 giorni su installazione provata danno zero fallback con memoria e
  proattività integre, DAY-1 è chiusa davvero e questo audit è superato.
- Se A11 resta l'unica riga non-READY per altri 30 giorni, il collo di
  bottiglia non è tecnico ma operativo — e va trattato come tale.
