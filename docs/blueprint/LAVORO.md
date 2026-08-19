# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (19/08/2026):**

- **#81 `slice/docs-authority` — STANDARD, draft, mergeable.** Refactor della
  knowledge/workflow architecture. Il branch è **19 commit avanti / 0 indietro**
  da `dev`. Oltre ai documenti modifica due consumer eseguibili del repository
  harness: SessionStart ora inietta solo questo handoff; `riconcilia.mjs` verifica
  solo `LAVORO ↔ Git/GitHub`. Per questo non è più FAST puro.
- **#78 `slice/inbound-unit` — CRITICAL, open.** Telegram
  `update_id → one durable turn`; il branch è ancora **4 avanti / 4 indietro** da
  `dev`. Prima dell'integrazione deve incorporare il `dev` corrente e rifare
  evidence pertinente + judge CRITICAL.

**Chiuso come superseded:** #73 `slice/product-open-source-direction`. Le
decisioni valide sono state assorbite nelle authority di #81; le draft originali
e la research sono preservate in `docs/history/product-direction-2026-08-18/` e
`docs/blueprint/research/`.

**Truth-maintenance blocker separato:** M5 contiene ancora claim/sintesi stale
(esempio già verificato: vecchio «blocco 1 chiuso» vs `recall-speaker` ancora
aperto). Non correggere M5 per far sembrare completa #81: la riconciliazione
riga-per-riga è un task evidence-driven distinto.

**Next action di #81:** eseguire sul checkout locale i test mirati dei consumer
workflow (`inject-state.test.ts`, `riconcilia.test.ts`), leggere il diff finale,
verificare `node .claude/riconcilia.mjs` sul GitHub live e aggiornare il body PR
alla scope/profile reale. Se passa, #81 può uscire da draft e integrarsi come
STANDARD; nessun fresh judge CRITICAL è richiesto.

**Owner decision richiesta da #81:** nessuna.
