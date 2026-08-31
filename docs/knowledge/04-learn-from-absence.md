# Imparare dall'assenza (silenzio come segnale)

**Stato: VIVO — cablato nel vecchio Muffin (principio + codice + 2 layer di
supporto), NON ancora nel design del blueprint nuovo** (compare solo come riga di
inventario in `docs/blueprint/research/a1-inventario-codebase.md` §Dream cycle). Candidato #1 da
portare avanti esplicitamente.

## Il principio (cognitivo)

*"Ciò che qualcuno smette di dire è spesso più informativo di ciò che dice."*
(`docs/history/foundations/legacy/UNDERSTANDING.md §5`). L'assenza non è mancanza di dato — **è**
un dato. Un tema centrale che scompare segnala un evento narrativo (avoidance,
risoluzione nascosta, tensione). Il cervello lo sa: la sorpresa di ciò-che-manca
è prediction-error tanto quanto la sorpresa di ciò-che-arriva.

**Regola chiave**: il silenzio significativo è il **delta rispetto al pattern
storico**, non il valore assoluto di `last_seen`. Un'entità menzionata ogni 6 mesi
non è "silente" a 3 mesi; una menzionata ogni 2 giorni lo è a 10.

## Il meccanismo (come il vecchio Muffin lo faceva — verificato a codice)

**`src/memory/dream_phase_i.ts` Step I.6 `runStepI6SilenzioDetection`** (WG-6,
ADR-066, shipped 2026-06-11):
1. Per ogni entità con **≥ 3 menzioni** (`SILENCE_MIN_MENTIONS`), calcola
   l'**intervallo medio** tra menzioni dalla storia.
2. Se `now − last_seen > intervallo_medio × 3` (`SILENCE_INTERVAL_MULTIPLIER`) →
   emette un'**osservazione** (Layer riflessivo):
   > `"<entità>" (<tipo>) silente da N giorni. Pattern storico: menzione ogni ~M
   > giorni (K totali). Vale la pena chiederne?`
3. **Cap a pochi silenzi per notte** (rispetta il rate-limit anti-firehose, P-I).

Ogni entità/attributo/edge porta `silent_since` accanto a `last_seen`. Nella
formula di retrieval c'è un termine `silence_penalty` — **che si inverte in boost**
se la query È *sul* silenzio ("che fine ha fatto X?").

## Due layer di supporto

- **Pattern-tipo `silenzio`** (`src/memory/memory_patterns.ts`): "tema centrale che
  scompare pur restando attivo". **Eccezione esplicita alla regola-3-settimane**: i
  pattern silenzio non la richiedono, *"perché l'assenza di dati è il segnale"*.
  Protetti dall'archival automatico (significance-floor).
- **Impegno non mantenuto** (angolo imparentato ma distinto):
  `src/pledge_pipeline.ts` + `pledge_nudge.ts` + `cognition/user_pledge.ts` —
  traccia gli impegni *dell'utente* verso terzi ("ti faccio sapere") e programma un
  nudge se scadono senza seguito. **Dormiente** dietro `PLEDGE_NUDGE_ENABLED=false`
  (cablato end-to-end, solo il flag è spento). Il "pattern che si rompe" generale è
  I.6; il "commitment specifico non onorato" è questo.

## Come mappa sul nuovo Muffin (la spina osservante)

Il silenzio-detection **è** un segnale di **Stadio-1** del cancello a due stadi che
abbiamo disegnato: un timer/soglia deterministico, **zero LLM**, che scatta su
*ciò-che-non-è-successo* (scadenza passata, pattern che si rompe, impegno non
onorato). Fa parte della stessa famiglia degli altri segnali cheap (àncore di
ritmo, eventi di attività). Solo quando scatta, lo Stadio-2 (un LLM) decide *se e
come* dire qualcosa. Quindi: nel nuovo schema, `silent_since` + intervallo-medio
sono metadata sul fatto/entità (il DB ricco li regge), e il "detector di assenza"
è un producer di eventi per l'event-bus di proattività.

**Nota di provenienza**: un'osservazione da-silenzio è **inferita** (bassa
confidenza, `source: inferito`), quindi lo specchio la porta come domanda/ipotesi
("ho notato che non parli più di X — tutto ok?"), mai come asserzione. È
l'antidoto strutturale al vecchio "ho notato" rumoroso: alta soglia (× 3), cap per
notte, e forma-da-ipotesi obbligata dalla provenienza.

## Fonti

`docs/history/foundations/legacy/UNDERSTANDING.md §5` · `src/memory/dream_phase_i.ts` (I.6) ·
`src/memory/memory_patterns.ts` · `docs/pillars/memory/{04_patterns,09_observations,05_episodes}.md`
· `src/pledge_pipeline.ts` · `docs/DECISIONS.md` (ADR-066) · postura anti-firehose:
`docs/foundations/PRINCIPLES.md §P-I`, e `docs/decisions/0028-postura-di-proattivita.md`.
