# EU AI Act + GDPR — panorama per il design (NON consulenza legale)

> Scout 2026-08-09 (muffin-scout). Fonti primarie (EUR-Lex Reg. 2024/1689,
> artificialintelligenceact.eu, giurisprudenza CGUE, guidance) + analisi terze
> marcate. **Non è consulenza legale**: serve un avvocato prima di un rilascio
> pubblico, specie sui due punti irrisolti in fondo. Le date sono al 2026-08-09.

## Bottom line

muffin-agent, usato dall'owner per sé, self-hostato **senza backend gestito dal
maintainer**, è verosimilmente:
- **Fuori scope come "deployer"** — Art. 3(4) esclude esplicitamente l'uso
  personale non professionale (specchio testuale della household exemption GDPR).
- **Non high-risk** — nessuna delle 8 categorie Annex III calza, TRANNE
  "sorveglianza/valutazione lavoratori" → **confine esplicito da non attraversare**
  (mai un "Muffin for teams" che valuta dipendenti).
- **Non GPAI provider** — gli obblighi Art. 53 cadono su chi produce il modello
  (Google/Gemma, Anthropic), non su chi lo chiama via API o lo scarica.

## L'unico obbligo davvero in gioco: Art. 50 (trasparenza)

Orizzontale (vale anche per minimal-risk): il sistema che interagisce con persone
fisiche deve rendere chiaro che **è un'IA** ("a meno che non sia ovvio"). In vigore
dal **2 ago 2026**, **NON toccato** dal rinvio Digital Omnibus (che sposta solo
l'high-risk Annex III al 2027). **La nostra architettura HITL draft-by-default lo
soddisfa di fatto**: è sempre l'owner umano a premere invio verso terzi, non
l'agente in autonomia. Sanzioni Art. 50: fino a 15M€ / 3% fatturato.

## Cos'è GIÀ coperto nel blueprint (non è un gap)

- Cancellazione GDPR per-attore (Art. 17) → `02-ontologia.md §7` (eccezione
  esplicita all'append-only), `ADR-0005` (provenienza/taint → cancellazioni mirate).
- `~/.muffin/` come perimetro unico backup/export/cancellazione → `ADR-0011`.
- **Zero telemetria esterna** → `03-threat-model.md`. **Doppio beneficio scoperto**:
  non solo privacy-by-design, ma **riduce l'esposizione del maintainer OSS a
  joint-controller** — la letteratura fonda la joint-controllership dei produttori
  proprio sul backend-cloud che tratta i dati; **nessun canale verso il maintainer
  = taglia l'aggancio principale**. Da mettere a verbale esplicitamente.
- Household exemption gruppi + Lindqvist (C-101/01) + Ryneš (C-212/13) + anti-dossier
  `§I-9` → `ADR-006/010/011/080` (produzione).
- Licenza MIT, no vendorizzazione modelli → `ADR-0019`.
- Kernel permessi/taint/sandbox → matcha/supera le raccomandazioni del **Garante
  olandese** (least privilege, vetting, test prompt-injection — vedi sotto).

## Gap reali (piccoli, da mettere a verbale)

1. **EU AI Act era del tutto assente** dai doc — questo report lo colma; va un ADR.
2. **Onboarding**: `ADR-0029` copre solo la meccanica; **zero avviso** che se il
   self-hoster esce dall'uso personale (community con terzi, uso professionale)
   **perde la household exemption** e diventa controller a pieno titolo (DPIA
   inclusa). Un avviso onesto costa poco e protegge l'utente OSS.
3. **Confine Annex III** mai scritto come vincolo AI-Act-motivato ("mai sorveglianza
   lavoratori").
4. **Art. 50 verso terzi non-owner**: quando arriverà la feature community, disclosure
   esplicito "sono un'IA" (Telegram marca i bot come BOT → argomento "ovvio", ma
   mai testato legalmente).
5. **Lane fully-local (Gemma/Ollama)** = l'unica config che **chiude del tutto** il
   trasferimento a un processor terzo (OpenRouter/Anthropic restano soggetti a GDPR
   a prescindere dall'esenzione dell'utente) → argomento in più per tenerla solida.

## Il campo è legalmente irrisolto (segnale forte, esterno)

Il **Garante olandese (AP)**, 12 feb 2026, ha nominato OpenClaw come "Trojan Horse"
e ha chiesto chiarimento UE se questi agenti autonomi rientrino nell'AI Act,
dichiarando che *"gli obblighi GDPR restano in vigore indipendentemente dallo status
open-source"*. **Nessun competitor** (Hermes/OpenClaw/Khoj/Goose) ha uno stance
dedicato su AI Act; su GDPR il massimo è Khoj ("mai fuori dal device") e Hermes
(`privacy.redact_pii` prima di inviare ai provider). → Niente standard di settore da
copiare; la nostra direzione (kernel + zero-telemetria) è già pari o superiore.

## Due punti DAVVERO irrisolti (per l'avvocato, pre-rilascio)

1. Se il self-hosting "for own use" del **maintainer stesso** lo renda tecnicamente
   "provider" AI-Act anche senza commercializzare.
2. Se/quando l'onboarding debba avvisare esplicitamente dell'uscita dalla household
   exemption.

## Sources
- EUR-Lex Reg. (UE) 2024/1689 · artificialintelligenceact.eu (Art. 2/3/5/6/50/53, Annex III)
- CGUE C-101/01 (Lindqvist), C-212/13 (Ryneš) · GDPR Art. 2(2)(c) + Recital 18, Art. 17
- Digital Omnibus (accordo 7 mag 2026): Gibson Dunn, White & Case, DLA Piper
- Garante NL (AP) 12 feb 2026: AIActBlog.nl, ppc.land, BABL AI, privacy-web.nl
- Competitor: hermes-agent/SECURITY.md, docs.khoj.dev/privacy
