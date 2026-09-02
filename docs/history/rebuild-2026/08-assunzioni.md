# 08 — Assunzioni e scelte implicite (da approvare esplicitamente)

> Il BRIEF chiede di far emergere ogni scelta fatta senza che fosse richiesta. Eccole, raggruppate; ciascuna con la conseguenza se la rifiuti. Quelle già coperte da un verdetto esplicito (01) o da un ADR non sono ripetute.

## Runtime e repo
1. **Node ≥22 + TypeScript strict, ESM** — implicito in V1. Rifiuto → riapre V1.
2. **better-sqlite3 + sqlite-vec + FTS5** come stack storage concreto (non solo "SQLite") — sono i binding già provati in casa. Rifiuto → ricerca alternativa, ritardo M2.
3. ~~**Un solo processo runtime**~~ → **RAFFINATA da ADR-0022**: confermata come numero di processi, ma con due meccanismi che mancavano (gate di priorità foreground, worker_thread per il batch). Vedi §Verifiche di Fase D.
4. ~~**Licenza non decisa da me**~~ → **CHIUSA dall'owner: MIT** (#40, ADR-0019).
5. ~~**Naming file/API in inglese, doc utente in italiano+inglese**~~ → **SUPERATA da ADR-0020** (#41): la regola non è più "entrambe le lingue per la doc utente" ma una lingua per artefatto, mai due per lo stesso contenuto.

## Dati e directory
6. **`~/.muffin/` (XDG-compatibile) come unica casa dei dati utente** — config, rot, db, vault, trace, eval private. Rifiuto → riapre ADR-0011.
7. **Trace su storage locale con retention configurabile** (default: 90 giorni raw, aggregati per sempre) — non deciso dal BRIEF. Impatta introspezione (più retention = più pattern) e disco.
8. **Golden set personale fuori dal repo** (in `~/.muffin/evals/`) e fixtures sintetiche nel repo — conseguenza diretta di "repo pubblico".
9. **Il vecchio `muffin.db` resta archivio read-only per sempre** (mai cancellato dopo la migrazione).

## Modelli e soldi
10. **Riferimenti pinnati iniziali della CI di capability**: frontier = Sonnet 5; consumer-locale = da scegliere con l'eval interna tra GPT-OSS-20b / **Qwen3.6-27B o 35B-A3B** / Gemma-4-26b (06 §2-bis). **Da rivalutare a metà agosto**: se escono i pesi di Qwen 3.8 (27B), è il candidato più forte della fascia. Il pin è una scelta operativa mia: cambia quando vuoi.
11. **Budget default prudenti**: cap spesa API mensile default $80 (profilo A), cap per-tenant gruppo $2/giorno, heartbeat solo se c'è un job armato. Numeri arbitrari miei: dimensionali, non sacri.
12. **Il costo del deep research è on-demand e visibile** (stima prima di partire sopra una soglia) — scelta UX implicita.

## Sicurezza e permessi
13. ~~**Enforcement del RoT via permessi OS**~~ → **RIVISTA** (#44, ADR-0003 §revisione): due tier (codice vs dati), hash+anchor come default con **safe mode** invece del rifiuto di boot, utente OS separato **opt-in** (`--hardened`), `muffin rot reseal` per gli edit legittimi dell'owner.
14. **Trust tier a 4 livelli fissi** (0-3) — una semplificazione deliberata; niente punteggi continui di fiducia in v1 (i punteggi continui sono un invito alla taratura infinita).
15. **L'owner può leggere i tenant dei propri gruppi** (con etichette di provenienza); i membri mai fuori dal proprio. Direzionalità gerarchica, dichiarata — non simmetrica.
16. **Niente firma HMAC per-record in memoria** (SMSR) in v1 — costo/beneficio, rivedibile (03 §5).

## Memoria
17. **Set-valued di default, functional dichiarati** (inversione del default rispetto al Muffin attuale) — lezione ADR-025 incorporata come scelta mia.
18. **`valid_from` mai inferito a "oggi"** se non espresso semanticamente (lezione bug Graphiti) — regola di estrazione implicita.
19. **Niente Neo4j/graph-DB dedicato, mai** — il grafo vive in SQLite relazionale+vec. Se un giorno servisse traversal pesante, prima si misura (il fallimento spreading-activation -44pp su BEAM è un monito contro l'intelligenza gratuita).
20. ~~**Media in v1 = testo + descrizione generata**~~ → **SUPERATA da ADR-0023**: si fanno **entrambe** (pass-through nativo nel turno + descrizione/OCR indicizzabile), perché l'incumbent è già multimodale sull'endpoint già cablato. Video fuori dalla v1.

## Prodotto
21. ~~**La CLI è il connector principale**~~ → **SUPERATA da ADR-0021** (#42): tutte le surface sono connesse insieme; la CLI resta la superficie primaria del sistema (L0-1) ma la **surface di default per l'iniziativa di Muffin è configurabile e di norma non è la CLI**.
22. **Onboarding conversazionale DOPO il bootstrap minimo**: `muffin init` chiede il minimo indispensabile (modello, chiave) in modo non-conversazionale; tutto il resto si configura parlando con Muffin (L0-2). Il "principio inferenza-non-configurazione" parte dal primo giorno.
23. **Parità di contenuto cross-canale** (stessa informazione, forma diversa) come vincolo del renderer — ereditata dalla filosofia esistente, mai messa in discussione nel BRIEF.
24. **Un solo owner per istanza in v1** — multi-owner/famiglia fuori scope.
25. **Il bot nei gruppi risponde quando menzionato/interpellato** (non conversa liberamente) come default v1 — la soglia di intervento libero è materia del gate di proattività post-v1.

## Esecuzione e sandbox (post-A6)
29. **Sandbox OS-level (Seatbelt/bubblewrap), non container/microVM, in v1** — proporzionato a host singolo e già nel DNA del progetto (dipendenza esistente); Firecracker/gVisor/sandbox remoti = opzioni post-v1 per multi-host o "Outposts"-style (brain in un posto, hands in un altro — pattern Devin).
30. **CodeAct non è lo spazio d'azione primario in v1** (tool tipati primari): regge meglio il floor consumer e riduce la superficie che dipende dal solo sandbox. Rivedibile con evidenza.
31. **Niente ispezione TLS dell'egress in v1** — nessun harness la fa di default; compensazione: allowlist per-capability strette + audit. Il credential-masking via proxy è l'evoluzione dichiarata.
32. **Prerequisito Linux dichiarato: `bubblewrap` + `socat` + il permesso di creare user namespace non privilegiati** — senza, le capability exec degradano ad ASK (mai silenziosamente unsandboxed). **Il terzo elemento non è teorico**: verificato sul VPS di produzione attuale (2026-08-04, Ubuntu 24.04.4 LTS) che `bwrap` e `socat` sono installati **ma `kernel.apparmor_restrict_unprivileged_userns = 1`** — il default di Ubuntu 24.04+, che blocca proprio ciò che bubblewrap usa. Un check che si ferma a "il binario c'è" dà una risposta falsa: `muffin doctor` deve **eseguire** un bwrap di prova come l'utente di servizio, non cercare il binario nel PATH.

## Post-Fase C (scelte fatte risolvendo le critiche)
33. **Rendering offline con libreria SVG→PNG**, nessun browser: chiude insieme l'egress non mediato (C1-1) e il secondo processo pesante (C2-#11). Se un giorno servisse HTML/CSS arbitrario, torna in discussione — ma con la rete disabilitata per costruzione.
34. **Canary automatico del cricchetto rimandato**: v1 = diff + approvazione owner. Serve una baseline che oggi non esiste.
35. **OTel: si adottano i nomi, non l'SDK** — trace JSONL+SQLite scritti in proprio finché non esiste un consumatore esterno.
36. **MCP: protocollo sì, UX di scoperta/marketplace no** in v1.
37. **Ordine strangler** (M2 e M4 prima di M3): il nuovo Muffin diventa quello quotidiano prima di essere completo.
38. **La scala del taint resta 0-3 ovunque** (dato e policy la stessa scala), ma `maxTaint` si dichiara solo quando diverge dal default della classe di rischio — cerimonia via, scala no.
39. **Numeri del floor scelti da me**: N=10, X=15, Y=32K, cap 40 iterazioni. Dimensionali e rivedibili, non sacri.

## Verifiche di Fase D (assunzioni messe alla prova dell'evidenza)
- **#3 (un solo processo runtime) — confermata ma raffinata** (B1, ADR-0022): nessuno dei 6 peer è davvero mono-processo senza eccezioni, ma nessuno dei loro motivi per separare vale per noi (SQLite embedded, single-owner). Aggiunti i due meccanismi che mancavano: gate di priorità foreground e `worker_thread` per il batch pesante. Il limite accettato ("un crash ferma tutto") resta, con systemd a riavviare.
- **Modello consumer di riferimento — da rivalutare a metà agosto** (B2): il "Qwen 3.8 27B" **non esiste ancora**; i pesi sono annunciati per metà agosto 2026. Se escono, è il candidato più interessante della fascia; se slittano, si sceglie tra Qwen3.6-27B/35B-A3B, GPT-OSS-20b e l'incumbent Gemma-4.
- **Multimodale — costa meno del previsto** (B2): l'incumbent è già multimodale su immagine e video sullo stesso endpoint già cablato. La lettura di immagini non è un modello in più: è un percorso già pagato.
- **Licenze open-weight — nuovo rischio da monitorare** (B2): MiniMax H3 esclude UE/USA/UK/Corea anche per pesi locali. La licenza si rilegge a ogni adozione, non si eredita dalla famiglia.

- **Media (B3, ADR-0023)**: in ingresso si fanno **entrambe** le cose che nessun sistema fa insieme (pass-through nativo nel turno + descrizione/OCR indicizzabile per la memoria); in uscita **immagine e testo, mai immagine al posto del testo** (WCAG 1.4.5). Pipeline `satori`→`resvg-js`, grafici via Vega-Lite. **Video fuori dalla v1**, dichiarato. Vincolo scoperto: Telegram `getFile` scarica max 20 MB.
- **Librerie con sorprese** (B3): `pdf-parse` 2.x ha una dipendenza nativa; `xlsx` su npm è fermo al 2022 (SheetJS ha lasciato il registro); `exceljs` non ha release dal 2023; `fluent-ffmpeg` è archiviato. Da verificare all'integrazione, non da assumere.

## Decisioni owner del 2026-08-04 (chiudono punti che erano aperti)
40. **Licenza MIT** (ADR-0019) — con il vincolo operativo che ne consegue: nessuna dipendenza GPL/AGPL, verificata in CI.
41. **Lingua** (ADR-0020): inglese per codice, commit, README/ARCHITECTURE, help e messaggi della CLI, descrizioni di tool e skill; italiano per persona, prompt, ADR e documenti di design. Mai lo stesso contenuto in due lingue.
42. **Surface** (ADR-0021): tutte connesse insieme, una di default per l'iniziativa di Muffin, ogni job schedulato sceglie il proprio target. Telegram non è privilegiato.
43. **Due gate** (04 §3): MVP = M0→M5 con memoria; cutover del vecchio = MVP + introspezione + gruppi + migrazione verificata + una settimana in parallelo.
44. **RoT rivisto** (ADR-0003, revisione): due tier (codice vs dati), safe mode invece di rifiuto del boot in single-user, `muffin rot reseal` per gli edit legittimi dell'owner, utente OS separato opt-in.
45. **Nome**: resta Muffin; pacchetto npm scoped e attenzione al binario (`/usr/bin/muffin` esiste su Linux Mint — l'installer rileva e propone alternativa).

## Processo
26. **Ogni modulo chiude con PR + review** (umana o Muffin-assistita con gate umano) — il flusso di lavoro attuale del progetto, assunto come costituzionale anche per il nuovo repo.
27. **Il blueprint stesso vive nel nuovo repo** (`docs/blueprint/` → migrato) e gli ADR nuovi continuano la numerazione da `adr/0001`.
28. **Cadenza di revisione dei prezzi/modelli**: ogni chiusura di modulo o 60 giorni, quello che viene prima (06 va ri-datato).
