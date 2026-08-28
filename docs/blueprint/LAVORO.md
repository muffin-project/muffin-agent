# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo. E tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Le ultime otto slice sono nate tutte allo stesso
modo: pilotando il REPL vero dentro **tmux** (`capture-pane` rende lo schermo;
`script` registra i byte e fa concludere il falso), o misurando su tracce e WAL
invece che sullo schermo. Nessuna è nata leggendo il codice.

**28/08 (#219 → #224).** `npm run build` era `tsc --noEmit` e mi ha fatto
misurare due volte il binario di ieri. Ctrl+J spediva invece di andare a capo
(Node consegna `\n` come `enter`). Il prompt si ripeteva: `persona.md` 7.528 →
4.629 byte, e `prompt show --eco` misura l'eco. Le righe di lavoro dicono su
cosa (sette ricerche diverse erano sette righe identiche). Muffin non sapeva
che giorno fosse: `## Questo turno` porta ora momento, fuso+offset, superficie,
con chi parli, modello e profilo. `gateway status` e `rot harden` davano rimedi
diventati falsi dopo #217.

**Peer da guardare sempre**, e soprattutto gli agenti personali continui:
openclaw, hermes, pi, odysseus, opencode, codex, claude, gemini. Letti finora:
Hermes (`stable`/`context`/`volatile`, offset UTC argomentato), OpenClaw
(`## Temporal Context`, `## Authorized Senders`, owner id hashato), Codex
(`<permission_profile>`, world state).

## Le tre decisioni aperte, tutte dell'owner

1. **Instradamento** (`config.provider.routing`, da #221). Oggi 0% di cache:
   OpenRouter manda al più economico dei 12 provider a monte, che non onora i
   breakpoint. Con `only: ["alibaba"]` la cache prende il 95% dal secondo turno
   e costa **meno** (~$0.0009 contro ~$0.0031 a turno). Ma è cinese, e
   `dataCollection: "deny"` non l'ha mai deciso nessuno: oggi `identity.md` e i
   ricordi vanno a chi costa meno senza vincoli su chi può tenerseli.
2. **`muffin rot harden`** — serve `sudo`, e da lì i reseal servono `sudo`.
   Finché non è fatto, `sys.shell` chiede **sempre** conferma.
3. **C8, note vocali**: whisper.cpp locale o un'API. Decide se la voce
   dell'owner esce di casa.

## Cosa manca per usarlo davvero

Muffin oggi è **solo terminale**: `surfaces.enabled = ["cli"]`, un solo segreto
(`provider_api_key`). Servono, dall'owner: **token bot Telegram** (senza,
niente telefono), **chiave Tavily** (senza, `web_search` non si registra),
**billing CI**.

## Aperto, non bloccante

**Prossimo grosso, con evidenza dai peer:** dichiarare i **permessi** nel
prompt. Oggi il kernel rifiuta al momento della chiamata e il modello impara
per rifiuto — incluso il tetto di taint (`defaultMaxTaint` medium/high = 1),
per cui «leggi, calcola, scrivi» è rifiutato *sempre* e nessuno gli dice
perché. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`.
Va nella coda volatile, perché il taint cambia dentro il turno. Lì nasce anche
l'hashing degli identificatori: oggi nessun `externalId` arriva al prompt.

**PR ferme:** #186 (undo riallinea il turno, CRITICAL, terzo giudizio mai
girato, CONFLICTING) e #192 (docs, CONFLICTING).

**Community:** esiste solo come forma di stringa (`community:${slug}` in
`TenantId`). Nessuna macchina: né appartenenza, né raggruppamento fra
superfici, né memoria condivisa. Promessa nel tipo, non capability.

**Altro:** la cache non prende fra un turno e l'altro (vedi decisione 1);
`pricing.ts` sottostima 5 famiglie su 8; ADR su «il REPL è un client del
gateway?»; socket v2; `possibly_sent` non distingue crash da in-volo.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
