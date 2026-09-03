# Muffin home (`~/.muffin`)

This document owns the **semantic map and ownership rules** for one Muffin
installation's home directory. Exact filenames and paths are executable authority
in `core/config/config.ts`; schemas own the contents they parse.

The repository and the Muffin home are deliberately different trust domains:

- **repository** = shared product/source/design truth, safe to collaborate on;
- **Muffin home** = one owner's live installation state, secrets, memory and
  runtime evidence; never commit it to Git.

`MUFFIN_HOME` may relocate the installation, but the semantic contract remains
the same.

## 1. Why one home exists

Muffin intentionally keeps personal/runtime state under one root so backup,
export, inspection and eventual “delete everything about me” operations have one
boundary. This is more important for this product than splitting state across
XDG config/data/cache roots.

An agent diagnosing a real installation should start by asking **which class of
state it needs**, not by recursively dumping the entire home into model context.
The home contains secrets and private memory.

## 2. Semantic layout

The current code maps these major classes under the home:

```text
~/.muffin/
├── config.json                 owner-editable installation configuration
├── muffin.db                   canonical SQLite runtime/memory state
├── rot/                        sealed Root of Trust material
├── defaults-manifest.json      provenance of defaults copied at init
├── prompt-nonce                stable installation prompt-fence nonce
├── persona.md                  shared Muffin persona copied into the install
├── voice.md                    owner-specific learned voice, mutable by ratchet
├── models/                     replaceable local model assets (for example Whisper)
├── vault/                      private owner data/files managed by Muffin
├── traces/                     retained execution/diagnostic traces
├── sessions/                   session-local/durable session material
├── secrets/                    secret-store backing material where applicable
├── undo/                       pre-effect undo snapshots, grouped by turn
└── gateway.stopped             deliberate-stop semaphore for supervision
```

This tree is a **semantic orientation**, not a second path registry. When code
adds/removes/renames a path, update this document only if the semantic layout or
ownership contract changed; do not hand-copy every internal cache/temp file.

## 3. Ownership classes

### A. Sealed authority — `rot/`

Contains rules the running agent must not be able to silently loosen: identity,
policy/budget/egress or other Root-of-Trust material defined by the current RoT
code. Runtime write paths must obey the ratchet/reseal design rather than editing
these files as ordinary configuration.

**Diagnostic rule:** inspect hashes/verification/declared policy before contents
when possible. A divergent RoT is itself evidence.

### B. Owner configuration — `config.json`

Human-readable, schema-validated configuration for provider/model/surfaces and
other installation choices that are *not* Root-of-Trust rails. Exact fields and
migration semantics belong to `core/config/config.ts`.

**Diagnostic rule:** parse through Muffin's loader/doctor where possible instead
of assuming a field means what its name suggests. Do not paste secret values into
research artifacts.

### C. Canonical durable state — `muffin.db`

The database is live evidence, not repository truth. It may contain turns,
memories, jobs, approvals, spend and other private operational state.

For dogfood analysis:

- prefer aggregate/count/shape evidence before raw content;
- record the build/commit and a database snapshot hash when conclusions depend
  on a copied snapshot;
- quote the minimum private content necessary and redact when writing durable
  research;
- never “fix” a runtime symptom by mutating the owner's database from a research
  session unless the owner explicitly chose a migration/repair path.

### D. Private content — `vault/`, memory-bearing DB/session material

Treat as owner data, not as convenient test fixtures. Reading it can change the
security/privacy character of a turn even when the read is local.

A coding agent should inspect only what is required to falsify its current claim.

### E. Secrets — `secrets/` and external secret backends

Secret contents are never normal diagnostic context. Prefer presence, reference,
backend health and permission checks. A system that requires showing the model a
secret in order to prove the secret system works is designed incorrectly.

### F. Operational evidence — `traces/`, gateway claim/state, sessions

These answer “what actually happened?” and are often more valuable than prose
when debugging loops, approvals, memory injection, provider calls or crashes.
Keep retention and privacy boundaries explicit.

### G. Replaceable assets — `models/`, copied defaults/persona

These are machine/install assets, not canonical personal knowledge. Their loss
may degrade a capability but should not silently redefine identity, memory or
security policy.

### H. Effect recovery — `undo/`

Undo snapshots are safety-critical evidence tied to an effect/turn. Lifecycle,
retention and cleanup must not be treated like generic cache housekeeping.

## 4. Repository ↔ home boundary

What belongs in Git:

- schemas and migrations;
- default templates;
- current architecture/security contracts;
- code that interprets the home;
- redacted/aggregate dogfood evidence when it changes a decision;
- tests/evals for home migration, inspection, backup/restore and policy.

What does **not** belong in Git:

- `muffin.db` from a real owner;
- owner identity/profile/memory;
- API keys/tokens or secret-store bytes;
- private vault/session/trace contents;
- machine-specific PIDs/locks/semaphores as durable project state.

The repository should contain enough semantics and tooling that another agent can
understand a home without committing the home itself.

### Una casa che invecchia riceve lo stesso i default nuovi (03/09/2026)

**Invariante:** un default spedito arriva anche in una casa nata prima che
quel default esistesse, e ciò che l'owner ha scritto non viene mai
sovrascritto.

Fino a questa data non era vero, e non era vero in silenzio. `muffin update`
sposta il **codice**, `runInit` semina una casa **nuova**, e nessuno
riconciliava una casa **esistente** con i default aggiunti dopo la sua
nascita. Misurato sull'installazione dell'owner: il repository spediva due
skill in `defaults/skills/`, il suo `defaults-manifest.json` elencava **un**
file — `persona.md` — e `~/.muffin/skills` non esisteva; quindi
`skillsPromptSection` tornava stringa vuota, il modello non sentiva mai la
parola «skill» e `skill_read` era un tool senza niente da leggere. La suite
era verde: una casa di test la crea `runInit` da zero, e quindi ha già tutto.
Il difetto non era delle skill — qualunque default futuro (una policy, un
template) avrebbe fatto la stessa fine.

La riconciliazione vive in `reconcileDefaults` (`cli/adopt.ts`), gira dentro
`muffin update` sull'albero `defaults/` della release **nuova**, e ha una sola
porta di scrittura: **installa soltanto ciò che manca**. Un file presente non
viene mai sostituito da solo — nemmeno uno mai toccato dall'owner: quello
resta `muffin adopt`, un verbo che si digita. Un file presente e diverso non
si tocca e si dichiara. Dentro `rot/` non si scrive mai: copiare nel sigillo
fa divergere l'hash e manda l'installazione in safe mode, quindi lì il
percorso resta `muffin init`, che copia e risigilla nello stesso giro.
`muffin doctor` lo dice comunque, per chi non ha ancora aggiornato.

Su una casa antecedente al registro, «mai installato» e «installato e poi
modificato» si distinguono **solo** quando il file è assente: lì non c'è
ambiguità e non c'è niente da perdere. Per un file presente decide la regola 2
di `core/config/defaults-drift.ts` (la storia Git), e quando neanche quella sa
rispondere la direzione sicura è non toccare.

## 5. Agent diagnostic workflow

When work depends on the installed agent:

1. identify the exact home (`MUFFIN_HOME` or default);
2. run/read `muffin doctor` and gateway/build inspection first;
3. establish which build produced the observed state;
4. inspect only the relevant state class (config, DB rows, trace, process, RoT);
5. correlate runtime evidence with the production code path on the same/current
   commit;
6. record only durable, privacy-safe evidence in `docs/evidence/`;
7. propose a repair in code/migration/tooling rather than an undocumented manual
   edit whenever the defect can recur.

A copied `muffin.db` is a snapshot. A running home can change while inspected.
State conclusions must name which one they refer to.

## 6. Design pressure for future primitives

New persistent subsystems must declare where they live and why. In particular,
future background-task/service support should not hide process ownership in shell
side effects. A durable process/service primitive needs an inspectable registry
or supervisor representation with owner/task origin, identity, logs, health,
restart policy, cancellation and cleanup semantics.

Likewise, future memory/person-model work should keep installation-private state
in the home while keeping schemas, promotion rules, evals and semantic contracts
in the repository.

## 7. A home is healthy when it is explainable

The target is not aesthetic folder purity. It is that an owner or fresh agent can
answer:

- what is canonical versus derived/replaceable;
- what the running agent may write;
- what is sealed against it;
- what contains private data or secrets;
- what is safe to delete/rebuild;
- what needs backup/restore guarantees;
- what evidence explains a runtime failure;
- which repository code interprets each class.

When a new directory cannot answer those questions, its design is incomplete.
