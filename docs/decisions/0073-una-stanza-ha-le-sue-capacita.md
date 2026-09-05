# ADR-0073 — Una stanza ha le sue capacità, e la prima è scrivere

**Stato:** proposto · 2026-09-04 · direzione owner, ricerca `muffin-nei-gruppi-2026-09-04.md` §3 e §5

## Contesto

Direzione owner (04/09): in un gruppo specifico Muffin deve poter *«gestire
file, creare file, web search, web fetch, multi step, loop — shell no, vault
sì»*. Oggi un membro raggiunge `documents.read`, `sys.http` (lettura),
`memory.*`, `surface.reply`; **tutto il resto è `hostOnly`**
(`agent/capability-gaps.test.ts`). Non è un interruttore da girare, per tre
ragioni misurate dalla ricerca:

1. **Non esiste uno spazio della stanza.** `resolveWorkspace(home, cwd)` è uno
   per installazione (ADR-0059), e `fs_write` è `hostOnly`: un workspace per
   tenant senza un tool che ci scriva non serve, e riaprire `fs_write` ai
   membri è la Combinazione C applicata al disco.
2. **Non esiste una scrittura deliberata.** I soli produttori di scritture
   durevoli sono automatici (ingestione allegati, episodio di ogni turno).
   «Muffin, salva questo» è una capability nuova per *qualunque* tenant,
   owner incluso. La richiesta reale dell'owner (*«magari salverà link da
   una parte»*) è questa, non un filesystem.
3. **Gli ask di un membro sono `deny`.** Da ADR-0071 un non-owner che compone
   byte in uscita viene negato, non interrogato: non c'è nessuno a cui
   chiedere. Aprire capacità a una stanza senza un approvatore le rende
   tutte «allow o niente».

## Decisione (proposta)

**1. La capacità sta nel tenant, nella policy sigillata.** `rot/policy.json`
accetta `tenants: { "<tenantId>": { grants: [...] } }` con un elenco
esplicito di capability id che in quella stanza smettono di essere
`hostOnly` — tighten-only nel senso inverso: un grant può solo **aggiungere**
a una stanza nominata, mai togliere a `host`, mai `sys.shell`, mai `rot.*`,
mai `outward.*` (la lista chiusa in `matrix.ts`). Nessun grant per
`group:*` in blocco: una stanza alla volta, per nome, e `doctor` le elenca.

**2. Lo spazio della stanza è il suo vault, non un filesystem.** La prima
capability che una stanza riceve è `vault.write`: *«salva questo»* — un
link, un testo, un allegato già ingerito — nel vault **del tenant**, che
`documents.read` già legge per tenant. Riga di effetto propria (`vault`), non
`memory`: non eredita l'`ALLOW` a ogni taint della porta. Reversibile con un
giornale del vault (`draft` come `fs_write`), perché è la prima scrittura
deliberata del sistema e va disfabile. `fs_*` resta `hostOnly`: un gruppo non
ha un disco.

**3. `sys.search` per stanza, con la sua spesa.** Con il grant, `sys.search`
in quella stanza risponde a `perTenantDailyUsd` (già esiste) e la query di
un membro resta soggetta a ADR-0071 come oggi — cioè composta, cioè negata —
**a meno che** il grant non lo dica: `grants: ["sys.search:composed"]`. È
la sola eccezione alla provenienza e va scritta per nome, perché è
esattamente il canale che §6.1 aveva misurato aperto.

**4. L'approvatore è l'owner, effimero, dentro la stanza.** Un `ask` nato
in un turno di stanza con grant va all'owner come **messaggio effimero** nel
gruppo stesso (Bot API 10.2/10.3: il bot è admin, può mandarlo a un membro
in qualunque momento), con i pulsanti della coda durevole (D12). Mai agli
admin del gruppo: la ricerca ha scartato la Combinazione C e il vecchio
Muffin non l'ha mai fatta — *nominava* gli admin, non li ascoltava. Se
l'owner non è nella stanza (F4 garantisce che allora Muffin non c'è),
l'`ask` è `deny`, come oggi.

**5. `todo` e `wait` sono del turno, non della stanza.** Sono primitive del
runtime (readiness §«wait e todo»), e in una stanza con grant seguono la
sessione della stanza — un topic ha la sua (ADR/F3). Nessun grant separato.

## Conseguenze

- Il kernel guadagna una dimensione (tenant → grant) e la perde la sola riga
  `hostOnly`: `decide.ts` legge `hostOnly && !grantedTo(tenant)`. Una
  mutazione che ignora il grant deve far cadere una prova per stanza.
- La spesa di una stanza è già tettata; il grant non la cambia.
- F8 (proattività) non dipende da questa ADR e non la richiede.

## Cosa la falsifica

Se, con `vault.write` in una stanza di prova, l'owner continua a chiedere
«un file» e non «salva questo», il punto 2 è sbagliato e va riaperto verso un
workspace per tenant. Se gli ask effimeri restano senza risposta per giorni,
il punto 4 è un divieto travestito e va ridisegnato.
