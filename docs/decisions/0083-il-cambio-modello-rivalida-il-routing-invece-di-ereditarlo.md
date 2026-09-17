# ADR-0083 — Il cambio modello rivalida il routing invece di ereditarlo

**Stato:** accettato · 2026-09-18 · chiude #501 (con #500 per l'attivazione: vedi sotto).

## Contesto

Sull'installazione dell'owner, `provider.routing.only: ["alibaba"]` scritto per
Qwen è sopravvissuto al passaggio a Gemma/`:free`. `muffin model` cambiava il
solo slug: ogni richiesta reale diventava impossibile, mentre i modelli nuovi
funzionavano su altri provider. Il guasto è strutturale, non un refuso:
selezione modello, routing, reasoning e default sono persistiti come
impostazioni indipendenti e permanenti, mentre sono decisioni dipendenti dal
modello.

Ricerca peer del 18/09 (tutti con lo stesso scheletro, nessuno con `if` di
famiglia nel loop): LiteLLM/OpenClaw/OpenRouter camminano liste
alias→deployment con fallback; le capability sono dati scoperti live
(`get_supported_openai_params`, `ModelProfile`←models.dev,
`model-settings.yml`, cataloghi curati); al cambio si rivalida e non si
eredita (Claude Code rifiuta prima di salvare, Hermes azzera `base_url`,
Codex blocca gli override non fidati, Aider avvisa e ignora i knob non
supportati).

## Decisione

Un resolver canonico puro (`core/config/model-resolve.ts`), stessa semantica
dietro `muffin model`, `muffin update` e (domani) il probe `doctor --online`:

1. **Pin di identità vs manopole di policy.** `only`/`order`/`ignore` nominano
   macchine e si rivalidano al cambio famiglia; `dataCollection`,
   `quantizations`, `sort`, `requireParameters` nominano vincoli dell'owner e
   non si toccano mai qui. È la «distinzione deterministica» che #501 chiedeva
   in alternativa alla provenance da mantenere — e non richiede migrazioni di
   schema per il passato, perché vale anche senza marcatore.
2. **Solo con evidenza positiva.** Cade ciò che risulta non servire il modello
   nuovo (endpoint vivi OpenRouter); senza evidenza (offline, senza chiave,
   risposta illeggibile) si tiene tutto e lo si dice. `only` svuotato si
   elimina (fail-open), mai lasciato come divieto totale.
3. **Marcatore `provider.routingForFamily`.** Scritto solo con evidenza viva,
   mai senza: permette a `doctor` (check `model routing`, offline, che tace
   quando non può provare) e all'update di *dire* l'era dei pin. Riscrivere lo
   stesso slug rivalida — il rimedio di doctor funziona davvero.
4. **Attivazione (#500).** Verificata, non riscritta: la corsia main si
   riaggancia a caldo (`refreshMainModel` come `prepareTurn`), la light legge
   l'oggetto config condiviso a ogni chiamata. Nessun reset di DB/memoria per
   cambiare modello.

Fuori da questa slice, registrati come complementi: il probe di capability
`doctor --online` (#523, che userà lo stesso resolver), i preset di prodotto
(#524), la misura reasoning/sampling per famiglia (#498 — nessuna temperatura
toccata qui), requested-vs-resolved per la spesa (#499).

## Alternative considerate

- **Provenance per campo (`routingSource: owner|installer`).** Respinta per
  ora: oggi nessuno scrive `routing` tranne la mano dell'owner, quindi il
  marcatore classificherebbe tutto come ignoto e la distinzione
  identità/policy fa già il lavoro senza nuova superficie di schema. Si
  rivaluta quando sarà l'onboarding a suggerire routing (#524).
- **Rifiutare il salvataggio come Claude Code.** Respinto: `muffin model`
  deve funzionare offline («irraggiungibile ≠ inesistente»); il rifiuto
  bloccherebbe una scelta valida senza rete.
- **Riparazione distruttiva offline.** Respinta: senza evidenza si tiene e si
  avvisa. La direzione sicura è non rompere ciò che funziona.

## Cosa può smentire la scelta

- Un endpoint che serve il modello ma non compare negli endpoint (tag
  diversi dai pin): il pin cade ingiustamente — allargare il match, non
  togliere la rivalidazione.
- `warn` di doctor su setup sani (split main/light di famiglie diverse con
  pin condivisi): il marcatore va reso per-corsia.
- Il probe #523 che chiude più casi del confronto per-famiglia: diventa la
  fonte di evidenza primaria, il resolver resta il consumatore.
