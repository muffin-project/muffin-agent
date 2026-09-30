# Profili modello owner fuori dal release tree

**Decisione che questo documento deve cambiare:** #764 — un profilo installato
dall'owner deve sopravvivere a `muffin update` (nativo) e alla sostituzione
dell'immagine (Docker), vivendo nello stato persistente e non nel release tree.

**Osservato su** `dev` @ `2bd71e59` (2026-09-30, ricerca delegata read-only;
riproduzione in `/tmp/muffin-764/`, clone + worktree, nessuna scrittura nel
repo). Una `muffin update` reale non è stata eseguita: ogni anello è stato
esercitato **col comando che update stesso lancia**, e `runUpdate` letto per
intero non contiene altri passi che copino file owner nel release.

## Il difetto, confermato

La catena (file:riga):

- `package.json:19` — `cp agent/profiles/*.json dist/agent/profiles/`: i profili
  arrivano in `dist` **solo dall'albero compilato** (il `prepare` gira con cwd
  = directory del release, `cli/update.ts:519-521`).
- `agent/profiles/profile.ts:222` — `loadProfiles()` senza directory esplicita
  legge **accanto al modulo compilato**; ogni lettore di produzione usa quel
  default: `agent/runtime.ts:609` (`buildRuntime` — gateway, REPL, `muffin run`),
  `agent/runtime.ts:1220` (hot model switch), `agent/comandi.ts:209` (`/think`),
  `cli/doctor.ts:393`. (`cli/repl.ts:6` è un import morto.)
- `cli/update.ts:1057` — il release è `git worktree add <dir> <sha>`: **solo
  l'albero del commit**; `:1149-1153` — `pruneOldReleases` fa `rm -rf` dei
  release non più tenuti.
- Docker (#729): `build.sh` costruisce da `git archive HEAD` (untracked mai nel
  contesto), `/opt/muffin` è root-owned e l'immagine si sostituisce intera;
  README: «rebuild the image».

Osservato (comandi reali, output essenziale):

```
# profilo owner non tracciato nel checkout (agent/profiles/owner-lan.json)
cp agent/profiles/*.json dist/agent/profiles/          # nel checkout → lo porta
# nel release che update costruisce (git worktree add .releases/<sha> <sha>):
  dist/agent/profiles/{consumer-local,frontier}.json   # owner-lan NON c'è
# loader vero dal dist del release nuovo:
  profiles: consumer-local, frontier;  selectProfile("my-lan-model") -> conservative
# stesso file copiato a mano nel dist del release IN ESECUZIONE:
  profiles: …, owner-lan;              selectProfile("my-lan-model") -> owner-lan
  # funziona oggi; perso al prossimo update (directory fresca), rm -rf due update dopo
```

**Il semaforo verde che mente:** `muffin doctor` stampa
`✓ model profile  my-lan-model -> conservative` (`cli/doctor.ts:396`): il
ricadere sul pavimento di capability dopo l'update **si presenta come salute**.
Nessuna provenance, nessun perché.

## Le sette domande dell'issue (sintesi)

1. **Directory separata?** [E] È un problema di ownership, non di
   rappresentazione: schema già dichiarativo, un solo parser, tutti i lettori
   passano da una funzione il cui unico assunto rigido è la directory default.
   La directory deve stare fuori dal release tree su entrambi i percorsi; la
   home persistente esiste su entrambi (`core/config/config.ts:349-353`;
   Docker `MUFFIN_HOME=/muffin/home`). [D] Alternativa difendibile: sezione
   `profiles` in `config.json` (OpenClaw-shaped) — più piccola in file ma
   lega un profilo rotto al boot della config.
2. **Campi sicuri vs pavimenti?** [E] Nessun campo è authority:
   `maxToolsExposed` è un **troncamento** dei tool registrati
   (`agent/loop/engine.ts:373-380`); la policy decide comunque ogni chiamata
   (`core/policy/decide.ts:139,145-150,153,213`); i tetti di spesa sono RoT
   (`defaults/rot/budgets.json`). «Un profilo owner non può concedere
   capability» è già strutturalmente vero. [D] Clamp di `execution.*` /
   `toolResultBudgetChars`: raccomandato non clampare in v1.
3. **Sealing RoT?** [E] La home è già **deny-write per l'agente** per default
   (`core/rot/guards.ts:95`, `p.home` primo in `denyWrite`); un profilo
   manomesso può al massimo *tuning entro l'autorità* (più tool visibili —
   comunque policy-gated; deadline più lunghe — spesa comunque RoT-gated).
   [D] Raccomandato: **directory home non sigillata** (precedente `voice.md`,
   `config.ts:387`); il sealing è scelta owner legittima per
   tamper-evidence, non un requisito del threat model.
4. **Upgrade shipped vs override owner?** [E] Con shipped letti dal release e
   owner letti dalla home, gli shipped si aggiornano a ogni release **per
   costruzione**: il freeze di `defaults/` (copy-once + drift,
   `core/config/defaults-drift.ts:297`, `cli/adopt.ts:273-313`) non può
   verificarsi. Il solo pinning è *per match*. [D] Owner = candidati
   aggiuntivi, mai rimpiazzi.
5. **Duplicati/malformati?** [E] Oggi: ordine per nome file + first-match-wins
   (`profile.ts:225,254-259`); il match shadowed è silenzioso; il malformato è
   già drop-and-say (boot lines `runtime.ts:1326-1332`, doctor
   `doctor.ts:395-420`). [D] Raccomandato: owner-first, shipped scartato a
   parità di `name` e la collisione **nominata** via `onProblem`; la
   coerenza cross-file sta in `doctor`, non nel loader.
6. **Provenance?** [D] Minimum: la riga del profilo risolto in `doctor` e
   `sys_inspect` guadagna la sorgente (`conservative | shipped (<file>) |
   owner (<file>)`) + file vincente + droppati/shadowed nominati; serve che
   `loadProfiles` restituisca l'origine. `/think` già distingue le sue due
   sorgenti (`agent/comandi.ts:263-267`): precedente a un campo di distanza.
   Le quattro stringhe di rimedio che citano il solo percorso release
   (`doctor.ts:411,419`, `agent/tools/inspect.ts:225`,
   `agent/tools/capability-status.ts:57`) vanno aggiornate.
7. **Peer** (fonti primarie lette 2026-09-30): Claude Code (output styles in
   `~/.claude/output-styles` e settings gerarchici; floor «stricter wins»),
   OpenClaw (config unica user-owned, rifiuto del boot su schema invalido,
   `modelPolicy.allow` come authority sulla scelta), Hermes (profili = home
   separate; `hermes update` sincronizza skill bundled **senza mai
   sovrascrivere quelle modificate dall'utente**, e lo riporta). Convergenza:
   preset durevoli = stato utente fuori dall'albero dell'app; nessuno li usa
   come authority da plugin.

## Decision table

| | Candidata | Pro | Contro |
|---|---|---|---|
| **A** | directory duale: `loadProfiles` legge anche `<home>/profiles/*.json`, owner-first, stesso parser, provenance in doctor/sys_inspect | la più piccola che soddisfa tutti gli invarianti con macchinario esistente (un loader, un parser, il guard home, una superficie diagnostica); la home è deny-write per l'aguto dal giorno uno; backup/GDPR gratis (ADR-0011: «one thing to back up») | superficie di shadowing da nominare (Q5/Q6); l'owner crea la directory a mano in v1 |
| **B** | `profiles` dentro `config.json` (forma OpenClaw) | un file, un confine zod, uno scrittore | blast radius al boot: un profilo rotto può brickare la config (OpenClaw rifiuta il boot); array di glob in un file che il runtime riscrive |
| **C** | niente profili owner: il punto di estensione resta maintainer-only | zero superficie | falsificato dal bisogno misurato (l'osservazione di @stefanod83); i tre peer contrari; ADR-0011 già implica stato owner oltre il repo |

**Scelta proposta: A**, con B come ripiego se la ownership a file singolo
vince operativamente, C esclusa. Falsificatori di A: il profilo owner
sopravvive a un `muffin update` reale e a una sostituzione immagine; una
`shell_run` che scrive in `<home>/profiles` è negata dal guard
(`core/sandbox/home-not-workspace.test.ts` da estendere); malformato/duplicato
droppato e nominato; `maxToolsExposed=10^9` resta capped ai tool registrati e
la policy nega comunque `neverAtRuntime`.

## Cosa resta al maintainer (fermarsi prima del codice)

1. Path e sealing: `<home>/profiles/` non sigillata (raccomandato) vs `rot/`
   sigillata.
2. Precedence e policy duplicati (owner-first + ritiro nominato del shipped
   omonimo).
3. Clamp o no dei pavimenti `execution.*`/budget (raccomandato: no in v1).
4. Proiezione Docker: entrypoint copia anche gli shipped nella home volume
   (precedente whisper, `entrypoint.sh:45-51`) o shipped letti dal release.
5. Semantica di rollback su profilo: il parser è già leniente in entrambe le
   direzioni (campi sconosciuti stripped, mancanti default) — confermare che
   «lenient» sia la risposta intesa.
6. La slice di implementazione è **CRITICAL** (confine owner/runtime):
   red-first, wiring, mutazioni, judge fresco.
