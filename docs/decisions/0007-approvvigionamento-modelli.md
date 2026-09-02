# ADR-0007 — Approvvigionamento modelli: API a consumo + profilo locale first-class; abbonamenti consumer esclusi

**Contesto.** Tre economie possibili (API, locale, abbonamento consumer via harness). ToS verificati alla fonte: Anthropic, OpenAI e Google vietano l'uso automatizzato/headless dei piani consumer fuori dai client ufficiali; enforcement Anthropic documentato (1,45M ban H2-2025, appelli al 3,3%) — A5 §4. Hardware locale sotto shortage DRAM (prezzi +70-90%, previsto fino al 2028); sweet spot = classe MoE 20-35B-A3B.

**Decisione.** Default: API a consumo (config B/A di 06 §4). Profilo locale consumer opzionale ma **first-class**: stesso floor in CI di capability, degradazione dichiarata, mai "local-first" come etichetta. L'abbonamento consumer non è un asse supportato dal runtime headless (resta legittimo per l'owner l'uso interattivo dei client ufficiali, fuori da Muffin).

**Alternative scartate.** *Abbonamento consumer via harness* (pattern ohmo): violazione ToS esplicita con enforcement reale; costruire un progetto pubblico su una violazione strutturale è un rischio esistenziale, non un trade-off. *Solo locale*: capability al floor per tutto + hardware d'ingresso rincarato; contraddice "dare al sistema la possibilità di fare le cose davvero". *Solo frontier*: 3-5× il costo per lavoro che non lo richiede.

**Conseguenze.** Più facile: legalità e prevedibilità dei costi; la privacy si compra dove rende di più (estrazione/consolidamento locale, config C). Più difficile: chi installa deve avere una chiave API o un server locale — il wizard lo dichiara subito con il costo stimato (mai scoperto a metà).

**Reversibilità.** Alta: è config + un adapter. Segnali di revisione: un vendor apre un piano flat *programmatico* ufficiale (riapre l'asse abbonamento); un open-weight consumer passa il floor con costo totale sotto l'API per il volume dell'owner (sposta il default su locale).
