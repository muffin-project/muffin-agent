import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { runUpdate } from '../../../cli/update.js';
import { EXIT_STOPPED } from '../../../core/gateway/service.js';
import { install, type Install, type Run } from '../harness.js';
import type { RecordedRequest } from '../provider.js';
import { scenario } from '../scenario.js';

/**
 * A · Installation and lifecycle.
 *
 * Real installs, real second launches, real tampering — against the process
 * an owner actually runs, never `runInit`/`buildRuntime` called by hand.
 */

/**
 * Polls `muffin gateway status` until its exit code matches. Local rather
 * than reaching for `harness.ts`'s `until`: that helper takes a synchronous
 * `check`, and this condition is a whole child process — spawning one ten
 * lines here beats reshaping shared infrastructure for a single caller.
 */
async function pollGatewayStatus(inst: Install, wantCode: 0 | 1, timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await inst.muffin(['gateway', 'status']);
    if (r.code === wantCode) return r;
    if (Date.now() > deadline) {
      throw new Error(`\`gateway status\` non ha mai risposto ${wantCode} (ultimo: ${r.code})\n${r.out}${r.err}`);
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
}

/** The pid `describe()` (cli/gateway.ts) prints in `attivo · pid 1234 · dal …`. */
function pidFrom(statusOut: string): string {
  const match = /pid (\d+)/.exec(statusOut);
  if (!match) throw new Error(`nessun pid nell'output di \`gateway status\`:\n${statusOut}`);
  return match[1]!;
}

/**
 * Recursive content hash of a directory — A9's evidence that the real home
 * is untouched by `init --local`, instead of trusting that nothing *should*
 * have written there.
 */
function hashDir(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      const st = statSync(full);
      hash.update(full);
      if (st.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

describe('acceptance · A · installazione e ciclo di vita', () => {
  scenario(
    'A1',
    async () => {
      // Owner directive (DAY-1 requirement A1, this slice's mandate): continuity belongs
      // to Muffin, not to the gateway's pid. The property this proves: a real
      // gateway process, SIGKILLed, is replaced by a second one that resumes
      // a suspended turn and fires a due job — each exactly once — with
      // status/doctor honest throughout, then stops on request for real.
      //
      // `MUFFIN_GATEWAY_TICK_MS` (cli/gateway.ts) is what keeps this under the
      // suite's usual budget without touching HEARTBEAT_MS itself: the real
      // beat is 30s, and this scenario needs two of them.
      const inst = await install({
        main: [
          { tool: { name: 'wait', args: { seconds: 3600, why: 'aspetto un evento' } } },
          { text: 'ecco il tuo brief' },
          { text: 'fatto, sono tornato' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        // --- (a) two pieces of durable work, neither due yet ---------------
        //
        // A turn that suspends on `wait`, straight from the CLI — no gateway
        // involved, same shape as B3. An hour out is "clearly not due yet",
        // not a real wait: backdated below, once no gateway is alive to race.
        const suspended = await inst.muffin(['run', '--session', 'a1-recovery', '--timeout', '20', 'avvisami fra un’ora']);
        if (suspended.code !== 6) {
          throw new Error(`atteso exit 6 (sospeso) dal turno che aspetta, ricevuto ${suspended.code}\n${suspended.err}`);
        }
        const waitTurnId = inst.db((db) => (db.prepare(`SELECT id FROM turns`).get() as { id: string } | undefined)?.id);
        if (!waitTurnId) throw new Error('nessuna riga turns dopo il turno sospeso');

        // A job due tomorrow-ish — same `jobs add` + backdate shape as B8,
        // `--channel cli` so delivery is real and observable on stdout rather
        // than B8's own (unrelated) "consegna remota da cablare" gap.
        const added = await inst.muffin(['jobs', 'add', '--cron', '0 8 * * *', '--channel', 'cli', 'manda il brief']);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);
        const jobId = inst.db((db) => (db.prepare(`SELECT id FROM jobs`).get() as { id: string } | undefined)?.id);
        if (!jobId) throw new Error('nessuna riga jobs dopo `jobs add`');

        // --- (b) the first gateway: a real process, a real claim -----------
        //
        // Neither the turn nor the job is due yet, so whatever this process's
        // own ticks find before it dies is nothing — deliberately. The window
        // this scenario must stay outside of is "job executed but markRan not
        // yet called" (riga B7, decision `job_fires`, owned elsewhere): racing
        // a kill against a real HTTP round trip to the fake provider could
        // land inside it by chance, and the only way to rule that out for
        // certain — rather than get lucky — is for nothing to be due while
        // this process is alive to fire it.
        const victim = inst.spawnRaw(['gateway', 'run']);
        const firstUp = await pollGatewayStatus(inst, 0);
        const firstPid = pidFrom(firstUp.out);

        // --- (c) SIGKILL -----------------------------------------------------
        //
        // No handler, no drain, no `finally` — the shape B5 already proves on
        // a turn, here on the gateway process that owns the claim itself.
        victim.kill();
        await victim.exited;

        // --- (d) pid morto = claim libero, subito ---------------------------
        //
        // `heldBy` (core/lock/durable.ts) judges liveness before staleness, so
        // this does not wait out STALE_AFTER_MS (five minutes) — a crash frees
        // the claim on the very next read.
        await pollGatewayStatus(inst, 1);

        // Only now — with no gateway alive to race — make both pieces of
        // durable work due. Same direct-SQL shape B8 already uses for
        // `next_fire_at`; `wake_at` gets the same treatment for the same
        // reason: a real hour-long wait shortened to a few seconds is exactly
        // the kind of thing a slow CI runner turns into a flake.
        const past = new Date(Date.now() - 60_000).toISOString();
        const backdate = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          backdate.prepare(`UPDATE turns SET wake_at = ? WHERE id = ?`).run(past, waitTurnId);
          backdate.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(past, jobId);
        } finally {
          backdate.close();
        }

        // --- (e) restart — what a supervisor would do -----------------------
        const gw2 = await inst.gateway();
        try {
          // The job fires on the very first tick (`serve()` ticks once at
          // boot, precisely so a fire that came due while nothing was running
          // does not wait out a full interval) — before the suspended turn,
          // whose resume needs a *later* tick once this one frees the shared
          // model lane (`Gateway.tick` runs the scheduler, then the turn lane,
          // on the same beat — never both at once).
          await gw2.waitFor(/⏰ ecco il tuo brief/, 15_000);
          await gw2.waitFor(/nessun indirizzo di risposta/, 15_000);

          const state = inst.db((db) => ({
            turnRows: (db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n,
            waitTurn: db.prepare(`SELECT status, delivery, turn_outcome FROM turns WHERE id = ?`).get(waitTurnId) as
              | { status: string; delivery: string | null; turn_outcome: string | null }
              | undefined,
            jobTurn: db.prepare(`SELECT status, delivery, turn_outcome FROM turns WHERE id != ?`).get(waitTurnId) as
              | { status: string; delivery: string | null; turn_outcome: string | null }
              | undefined,
            job: db.prepare(`SELECT last_run_at, next_fire_at FROM jobs WHERE id = ?`).get(jobId) as {
              last_run_at: string | null;
              next_fire_at: string;
            },
          }));

          // Exactly once, both directions: two rows total (the resumed one +
          // the job's fresh one), never zero and never a duplicate of either.
          if (state.turnRows !== 2) {
            throw new Error(`atteso 2 righe in turns (il turno ripreso + quello del job), trovate ${state.turnRows}`);
          }
          if (state.waitTurn?.status !== 'done' || state.waitTurn.delivery !== 'undeliverable') {
            throw new Error(`il turno sospeso non risulta ripreso e contabilizzato una sola volta: ${JSON.stringify(state.waitTurn)}`);
          }
          if (state.jobTurn?.status !== 'done' || state.jobTurn.delivery !== 'sent') {
            // This is B8's own "consegna genuina su superficie connessa" half,
            // proved here for real: `--channel cli` reaches `cliSurface`, which
            // is always connected (L0-1), so `sent` — not "consegna remota da
            // cablare" — is the honest outcome for this channel.
            throw new Error(`il turno del job non risulta consegnato: ${JSON.stringify(state.jobTurn)}`);
          }
          if (state.job.last_run_at === null) throw new Error('il job non risulta eseguito (last_run_at nullo)');
          if (Date.parse(state.job.next_fire_at) <= Date.now()) {
            throw new Error(`next_fire_at non è avanzato oltre ora (markRan lo ricalcola da ora, non dal vecchio orario): ${state.job.next_fire_at}`);
          }
          // The delivered text reached stdout exactly once — not a second
          // time from a duplicate fire. Mutation-tested (see the PR): this is
          // the assertion that goes red when the job's claim is disabled.
          const deliveries = gw2.stdout().split('⏰ ecco il tuo brief').length - 1;
          if (deliveries !== 1) throw new Error(`il testo del job è comparso ${deliveries} volte su stdout, non 1`);

          const upAgain = await inst.muffin(['gateway', 'status']);
          if (upAgain.code !== 0) throw new Error(`atteso status exit 0 dopo il riavvio, ricevuto ${upAgain.code}\n${upAgain.out}`);
          const secondPid = pidFrom(upAgain.out);
          if (secondPid === firstPid) throw new Error(`atteso un pid diverso dal primo gateway (${firstPid}), trovato lo stesso`);

          const doctor = await inst.muffin(['doctor']);
          if (doctor.code === 2) throw new Error(`doctor in fail dopo il riavvio:\n${doctor.out}`);
        } finally {
          // --- (f) drain-and-stop, exit code included -----------------------
          const exitCode = await gw2.stop();
          if (exitCode !== EXIT_STOPPED) {
            throw new Error(`atteso EXIT_STOPPED (${EXIT_STOPPED}) da un gateway drenato via SIGTERM, ricevuto ${exitCode}`);
          }
        }
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );
});

/**
 * A2/A3 · identity + persona reach the real system prompt, and `prompt show`
 * does not describe them from a second, parallel assembly.
 *
 * One install, one real `muffin run` against the fake provider, one real
 * `muffin prompt show` — shared across both rows in `beforeAll` because they
 * are two readings of the *same* evidence (DAY-1 requirement A2 "sa chi è e quali
 * limiti ha" is `identity.md`'s claim, A3 "il comportamento è definito" is
 * `persona.md`'s), not two independent turns. Every marker is read from the
 * files this install actually wrote under `inst.home` — never from
 * `defaults/`, which is only the seed `muffin init` copies from once.
 */
describe('acceptance · A2/A3 · identity + persona wiring', () => {
  let inst: Install;
  /** The real request the fake provider received for the one turn this suite runs. */
  let sent: RecordedRequest;
  /** `muffin prompt show` on the very same home, after the turn. */
  let shown: string;

  const IDENTITY_MARKER = 'Non mi dai ragione per farmi contento.';
  const PERSONA_MARKER = 'Sono una seconda prospettiva con memoria.';
  const VOICE_MARKER = 'Niente meta-commentary';

  beforeAll(async () => {
    inst = await install({ main: [{ text: 'ciao, sono Muffin' }] });
    const run = await inst.muffin(['run', '--timeout', '20', 'ciao']);
    if (run.code !== 0) throw new Error(`turno iniziale: exit ${run.code}\n${run.err}`);

    const mainCalls = inst.provider.main();
    const last = mainCalls[mainCalls.length - 1];
    if (!last) throw new Error('il provider finto non ha registrato nessuna request del lane principale');
    sent = last;

    const promptShow = await inst.muffin(['prompt', 'show']);
    if (promptShow.code !== 0) throw new Error(`muffin prompt show: exit ${promptShow.code}\n${promptShow.err}`);
    shown = promptShow.out;
  }, 30_000);

  afterAll(async () => {
    await inst.cleanup();
  });

  scenario('A2', async () => {
    // The fixture check first: if the installed file itself lost the marker,
    // every assertion below would pass or fail for the wrong reason.
    const installedIdentity = readFileSync(join(inst.home, 'rot', 'identity.md'), 'utf8');
    if (!installedIdentity.includes(IDENTITY_MARKER)) {
      throw new Error(`fixture rotta: l'identity.md installato non contiene "${IDENTITY_MARKER}"`);
    }
    if (!sent.system.includes(IDENTITY_MARKER)) {
      throw new Error(
        `il system prompt che il provider ha ricevuto davvero non contiene identity.md:\n${sent.system.slice(0, 500)}`,
      );
    }
    if (!shown.includes(IDENTITY_MARKER)) {
      throw new Error(`muffin prompt show sulla stessa home non contiene identity.md`);
    }
  });

  scenario('A3', async () => {
    const installedPersona = readFileSync(join(inst.home, 'persona.md'), 'utf8');
    const installedVoice = readFileSync(join(inst.home, 'voice.md'), 'utf8');
    if (!installedPersona.includes(PERSONA_MARKER)) {
      throw new Error(`fixture rotta: il persona.md installato non contiene "${PERSONA_MARKER}"`);
    }
    if (!installedVoice.includes(VOICE_MARKER)) {
      throw new Error(`fixture rotta: il voice.md installato non contiene "${VOICE_MARKER}"`);
    }

    for (const [name, marker] of [
      ['persona.md', PERSONA_MARKER],
      ['voice.md', VOICE_MARKER],
    ] as const) {
      if (!sent.system.includes(marker)) {
        throw new Error(`il system prompt inviato al provider non contiene ${name} ("${marker}")`);
      }
      if (!shown.includes(marker)) {
        throw new Error(`muffin prompt show non contiene ${name} ("${marker}")`);
      }
    }

    // The canonical order (agent/context/assemble.ts buildSystemPromptBlocks):
    // persona, then identity, then voice.
    const iPersona = sent.system.indexOf(PERSONA_MARKER);
    const iIdentity = sent.system.indexOf(IDENTITY_MARKER);
    const iVoice = sent.system.indexOf(VOICE_MARKER);
    if (!(iPersona < iIdentity && iIdentity < iVoice)) {
      throw new Error(
        `ordine canonico violato — atteso persona < identity < voice, trovato persona@${iPersona} ` +
          `identity@${iIdentity} voice@${iVoice}`,
      );
    }

    // The truthfulness claim `prompt show` exists for: byte-identical to what
    // the provider actually received, modulo the one trailing newline the
    // command appends to its stdout (a plain text stream ends with one; the
    // wire request that reached the fake provider does not carry one).
    if (shown !== `${sent.system}\n`) {
      throw new Error(
        "muffin prompt show diverge dal system prompt realmente inviato al provider — non e' più una descrizione fedele",
      );
    }
  });
});

describe('acceptance · A · doctor, backup', () => {
  scenario(
    'A5',
    async () => {
      const inst = await install({ main: [{ text: 'non dovrebbe mai arrivare qui' }] });
      try {
        // Exit 1 on a brand-new install is expected (see A1): unrelated
        // `warn`-level lines exist from day one. What has to be true is that
        // the root-of-trust check itself reads `ok`, so the change after
        // tampering below is attributable to the tamper and nothing else.
        const clean = await inst.muffin(['doctor']);
        if (!/✓ root of trust\s/.test(clean.out)) {
          throw new Error(`doctor non riporta 'root of trust' come ok su un'installazione pulita:\n${clean.out}`);
        }

        // Tamper with a real sealed file — not a fixture doctor was told about,
        // the actual file `muffin init` wrote and sealed a hash of.
        const policyPath = join(inst.home, 'rot', 'policy.json');
        const original = readFileSync(policyPath, 'utf8');
        const tampered = JSON.stringify({ ...(JSON.parse(original) as object), _manomesso_da_test: true }, null, 2);
        writeFileSync(policyPath, tampered);

        const broken = await inst.muffin(['doctor']);
        if (broken.code === 0) {
          throw new Error(`doctor è tornato ok dopo la manomissione — non se ne è accorto:\n${broken.out}`);
        }
        if (!/root of trust/.test(broken.out) || !/policy\.json/.test(broken.out)) {
          throw new Error(`doctor ha trovato *qualcosa* ma non ha nominato il file manomesso:\n${broken.out}`);
        }
        // A problem an owner cannot act on is half a diagnosis. The check must
        // say what to do, not just that something is wrong.
        if (!/rifai|reseal|ripristina/i.test(broken.out)) {
          throw new Error(`doctor ha segnalato la manomissione senza dire come rimediare:\n${broken.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  // Riscritto (slice/journey-lifecycle, riconciliazione 02/09). La versione
  // precedente provava che una `cpSync` grezza della home sopravvive — vera,
  // ma non è la domanda della riga: DAY-1 requirement A8 chiede se *la memoria si
  // salva e si ripristina*, cioè se i verbi `muffin backup`/`muffin restore`
  // (`cli/backup.ts`) funzionano, non se il filesystem sa copiare una
  // directory. `cpSync` non esercita `VACUUM INTO`, `quick_check`, il rifiuto
  // col gateway vivo o il backup-di-cortesia prima del restore — tutte cose
  // che *A8-min* (RETURN S2) ha già chiuso a livello di meccanismo
  // (`cli/backup.test.ts`) e che qui vanno provate sul binario reale: i due
  // comandi, non una copia di file al loro posto. Il contenuto scritto *dopo*
  // il backup deve sparire dal restore (prova che sostituisce, non
  // aggiunge), e il file di backup e la copia-di-cortesia messa da parte dal
  // restore devono esistere per davvero sul disco, non solo comparire in una
  // riga di stdout.
  scenario(
    'A8',
    async () => {
      const inst = await install({
        main: [
          { text: 'segnato: il tuo numero fortunato è 42' },
          { text: 'segnato: la tua squadra del cuore è il Milan' },
        ],
      });
      try {
        const said = await inst.muffin(['run', '--timeout', '20', 'il mio numero fortunato è 42, ricordatelo']);
        if (said.code !== 0) throw new Error(`turno iniziale: exit ${said.code}\n${said.err}`);

        const before = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (before.code !== 0 || !before.out.includes('42')) {
          throw new Error(`prima del backup la ricerca non trova già il contenuto — la fixture è rotta:\n${before.out}`);
        }

        // `muffin backup` — the real verb, not a directory copy.
        const backup = await inst.muffin(['backup']);
        if (backup.code !== 0) throw new Error(`muffin backup: exit ${backup.code}\n${backup.out}${backup.err}`);
        const backupMatch = /backup: (\S+) \(/.exec(backup.out);
        if (!backupMatch) throw new Error(`l'output di \`muffin backup\` non nomina il file prodotto: ${JSON.stringify(backup.out)}`);
        const backupFile = backupMatch[1]!;
        if (!existsSync(backupFile)) {
          throw new Error(`\`muffin backup\` dice di aver scritto ${backupFile}, ma il file non esiste sul disco`);
        }
        if (!backup.out.includes('quick_check ok')) {
          throw new Error(`\`muffin backup\` non dichiara il quick_check sul file prodotto: ${JSON.stringify(backup.out)}`);
        }

        // Written AFTER the backup — the property this proves is that
        // restore *replaces*, not merges: this must vanish once restored.
        const said2 = await inst.muffin(['run', '--timeout', '20', 'la mia squadra del cuore è il Milan, ricordatelo']);
        if (said2.code !== 0) throw new Error(`secondo turno: exit ${said2.code}\n${said2.err}`);
        const midway = await inst.muffin(['memory', 'search', 'Milan']);
        if (midway.code !== 0 || !midway.out.includes('Milan')) {
          throw new Error(`prima del restore la ricerca non trova il contenuto scritto dopo il backup — la fixture è rotta:\n${midway.out}`);
        }

        // `muffin restore <file> --yes` — the real verb.
        const restore = await inst.muffin(['restore', backupFile, '--yes']);
        if (restore.code !== 0) throw new Error(`muffin restore: exit ${restore.code}\n${restore.out}${restore.err}`);
        if (!restore.out.includes('ripristinato')) {
          throw new Error(`l'output di \`muffin restore\` non conferma il ripristino: ${JSON.stringify(restore.out)}`);
        }
        // The courtesy copy `restoreFrom` sets aside before overwriting —
        // real file, not a claim.
        const asideMatch = /db precedente messo da parte: (\S+)/.exec(restore.out);
        if (!asideMatch) {
          throw new Error(`\`muffin restore\` non dichiara la copia messa da parte del db corrente: ${JSON.stringify(restore.out)}`);
        }
        if (!existsSync(asideMatch[1]!)) {
          throw new Error(`la copia-di-cortesia dichiarata (${asideMatch[1]}) non esiste sul disco`);
        }

        // After restore: the pre-backup content is back...
        const after = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (after.code !== 0) throw new Error(`dopo il ripristino la ricerca fallisce: exit ${after.code}\n${after.err}`);
        if (!after.out.includes('42')) {
          throw new Error(`dopo il ripristino il contenuto ante-backup non si ritrova più:\n${after.out}`);
        }
        // ...and the post-backup content is genuinely gone — restore replaced
        // the database, it did not merge into it.
        const afterMilan = await inst.muffin(['memory', 'search', 'Milan']);
        if (afterMilan.out.includes('Milan')) {
          throw new Error(`dopo il ripristino il contenuto scritto DOPO il backup si trova ancora — il restore ha aggiunto, non sostituito:\n${afterMilan.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'A9',
    async () => {
      // Requisito DAY-1 A9 — setup locale pulito di prova (direttiva owner
      // 16/08): `muffin init --local <dir>` deve
      // riusare un segreto persistito attraverso la stessa catena che
      // `locateSecret` già percorre (ADR-0039 decisione 2) — mai copiarlo nella
      // home nuova — e non deve mai poter atterrare sulla home reale, o dentro
      // di essa.
      const inst = await install({ main: [{ text: 'non dovrebbe mai arrivare qui' }] });
      try {
        // (a) Un segreto sul backend *persistent* — isolato dall'harness stesso
        // (`XDG_CONFIG_HOME` nel proprio `install()`, mai quello reale di questa
        // macchina: vedi il docstring di `install` in harness.ts).
        const persisted = await inst.muffin(
          ['secret', 'set', 'provider_api_key', '--persist'],
          'sk-acceptance-persisted-key\n',
        );
        if (persisted.code !== 0) {
          throw new Error(`\`secret set --persist\` non riuscito: exit ${persisted.code}\n${persisted.err}`);
        }

        const beforeHash = hashDir(inst.home);

        // (b) Una seconda home pulita, senza --api-key: la chiave deve venire
        // dalla catena, mai da un prompt o da una copia.
        const localDir = join(inst.workspace, 'local-clean-home');
        const local = await inst.muffin(['init', '--local', localDir]);
        if (local.code !== 0) throw new Error(`\`init --local\` non riuscito: exit ${local.code}\n${local.err}`);
        if (!/api key\s+già presente \(persistent\)/.test(local.err)) {
          throw new Error(`init --local non ha trovato la chiave sul backend persistent:\n${local.err}`);
        }
        if (!local.err.includes(`export MUFFIN_HOME=${localDir}`)) {
          throw new Error(`init --local non stampa la riga per usare la nuova home:\n${local.err}`);
        }
        // Il punto intero della riga: nessuna seconda copia della chiave.
        if (existsSync(join(localDir, 'secrets', 'provider_api_key'))) {
          throw new Error(`init --local ha copiato la chiave nella home locale — non deve mai farlo`);
        }

        // (c) L'installazione locale è reale: doctor la trova sana, guidato
        // come farebbe l'owner dopo `export MUFFIN_HOME=...` — mai contro lo
        // XDG_CONFIG_HOME vero di questa macchina (`muffinAt`, harness.ts).
        const doctor = await inst.muffinAt(localDir, ['doctor']);
        if (doctor.code === 2) throw new Error(`doctor in fail sulla home locale:\n${doctor.out}`);
        if (!/✓ database\s/.test(doctor.out)) {
          throw new Error(`doctor non riporta 'database' ok sulla home locale:\n${doctor.out}`);
        }
        if (!/✓ root of trust\s/.test(doctor.out)) {
          throw new Error(`doctor non riporta 'root of trust' ok sulla home locale:\n${doctor.out}`);
        }

        // (e) --local puntato sulla home reale stessa è rifiutato, prima di
        // scrivere qualunque cosa.
        const rejected = await inst.muffin(['init', '--local', inst.home]);
        if (rejected.code !== 78) {
          throw new Error(`init --local sulla home reale doveva essere rifiutato (78), ricevuto ${rejected.code}:\n${rejected.err}`);
        }
        if (!/rifiuto/i.test(rejected.err)) {
          throw new Error(`init --local sulla home reale non spiega perché rifiuta:\n${rejected.err}`);
        }

        // (d) La home originale non è mai stata toccata, né dalla (b) né dal
        // tentativo rifiutato in (e).
        if (hashDir(inst.home) !== beforeHash) {
          throw new Error(`la home reale (${inst.home}) è cambiata dopo init --local`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});

/**
 * A6 · update: a validated backup is taken before anything is swapped, and
 * data written before the update survives it.
 *
 * `cmdUpdate` (`cli/update.ts`) parses argv and calls `runUpdate` with no
 * overrides — `runUpdate` is the whole mechanism. Spawning `muffin update`
 * as a real child process, the way every other scenario in this file spawns
 * `muffin`, is not available here without an owner-machine side effect:
 * `findCheckoutRoot`'s own docstring says it deliberately walks to the git
 * checkout's **main worktree** (`git worktree list --porcelain`, first
 * line) rather than the worktree this process happens to run in, and
 * `defaultBindirs()` is `~/.local/bin`, `/opt/homebrew/bin`,
 * `/usr/local/bin` — the real ones on this machine. Even `--dry-run` still
 * runs a real `git fetch origin` against that real checkout before it stops.
 * `cmdUpdate` exposes no flag to redirect either, so a spawned `muffin
 * update` from inside this suite would write into the actual repository
 * this agent is running from and could re-point real launcher symlinks —
 * exactly the kind of owner-state mutation this suite's whole isolation
 * model (`harness.ts`'s own docstring: `MUFFIN_HOME`, `XDG_CONFIG_HOME`, a
 * scratch `cwd`) exists to prevent, and that isolation does not reach these
 * two inputs at all.
 *
 * What runs here instead is `runUpdate` itself — imported directly, the
 * exact function `cmdUpdate` calls — redirected at only the two inputs its
 * own doc comments already name as the test seam (`moduleDir`: "Tests point
 * this at a fake checkout"; `bindirs`: "tests point this at a throwaway
 * directory"). Nothing else is faked: `git` is the real default runner
 * (real `spawnSync('git', …)`) against a real, throwaway checkout+origin
 * built with real git commands below; `npmCi` is the real default (`npm
 * ci`) against a real `package.json`+`package-lock.json` with zero
 * dependencies, so it is fast and makes no network call; `smokeTest` is the
 * real default (`node <release>/dist/cli/main.js --help`) against a real
 * committed script that exits 0; `readNewSchemaVersion` is the real default,
 * spawning node to import a real committed `dist/core/db/migrate.js`;
 * `backup` is the real `backupNow`, against the real, populated
 * `$MUFFIN_HOME` this same file's `install()` builds with the real spawned
 * binary. The one thing this scenario cannot exercise is `cmdUpdate`'s own
 * argv parsing and its interactive restart prompt — both are a thin, untyped
 * layer with no logic of their own, unlike the mechanism underneath.
 */
describe('acceptance · A6 · update: backup before swap', () => {
  scenario(
    'A6',
    async () => {
      const inst = await install({ main: [{ text: 'segnato: 42' }] });
      try {
        const said = await inst.muffin(['run', '--timeout', '20', 'il mio numero fortunato è 42, ricordatelo']);
        if (said.code !== 0) throw new Error(`turno iniziale: exit ${said.code}\n${said.err}`);
        const before = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (before.code !== 0 || !before.out.includes('42')) {
          throw new Error(`prima dell'update la ricerca non trova già il contenuto — fixture rotta:\n${before.out}`);
        }

        // --- a real, throwaway git checkout + a real, throwaway "origin" ---
        const root = mkdtempSync(join(tmpdir(), 'muffin-a6-'));
        const originDir = join(root, 'origin.git');
        const seedDir = join(root, 'seed');
        const checkoutRoot = join(root, 'checkout');
        const bindir = join(root, 'bin');
        mkdirSync(bindir, { recursive: true });

        // Never the developer's own global git config (hooks, signing) —
        // only this scratch repo's own commits, with identity passed
        // explicitly per call.
        const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
        const git = (args: string[], cwd: string): void => {
          const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
          if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) è uscito ${r.status}:\n${r.stderr}`);
        };
        const gitOut = (args: string[], cwd: string): string => {
          const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
          if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) è uscito ${r.status}:\n${r.stderr}`);
          return r.stdout.trim();
        };
        const commit = (msg: string): void =>
          git(['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@test.local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg], seedDir);

        const writeSeedRelease = (helpLine: string, schemaVersion: number): void => {
          mkdirSync(join(seedDir, 'dist', 'cli'), { recursive: true });
          mkdirSync(join(seedDir, 'dist', 'core', 'db'), { recursive: true });
          writeFileSync(join(seedDir, 'dist', 'cli', 'main.js'), `process.stdout.write(${JSON.stringify(helpLine)});\nprocess.exit(0);\n`);
          writeFileSync(join(seedDir, 'dist', 'core', 'db', 'migrate.js'), `export function currentSchemaVersion(){ return ${schemaVersion}; }\n`);
        };

        git(['init', '-q', '--bare', originDir], root);
        git(['init', '-q', seedDir], root);
        writeFileSync(join(seedDir, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', type: 'module' }));
        writeFileSync(
          join(seedDir, 'package-lock.json'),
          JSON.stringify({ name: 'scratch', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'scratch', version: '1.0.0' } } }),
        );
        writeSeedRelease('scratch v1 --help\n', 2);
        git(['add', '-A'], seedDir);
        commit('v1');
        git(['remote', 'add', 'origin', originDir], seedDir);
        git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], seedDir);

        git(['clone', '-q', originDir, checkoutRoot], root);
        const oldSha = gitOut(['rev-parse', 'HEAD'], checkoutRoot);

        // Advance "origin" past the checkout — real work for `update` to do.
        writeSeedRelease('scratch v2 --help\n', 3);
        git(['add', '-A'], seedDir);
        commit('v2 — schema v3');
        git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], seedDir);
        const newSha = gitOut(['rev-parse', 'HEAD'], seedDir);
        if (newSha === oldSha) throw new Error('fixture rotta: origin non è avanzato oltre il checkout');

        // A launcher, in the scratch bindir, pointing at the OLD release —
        // exactly what `findOwnedLaunchers` looks for, so the flip is real
        // and observable instead of the "nessun launcher" branch.
        const launcherPath = join(bindir, 'muffin');
        symlinkSync(join(checkoutRoot, 'dist', 'cli', 'main.js'), launcherPath);

        // --- the mechanism itself, real defaults, redirected at the two ----
        //     seams its own comments name for tests.
        const result = runUpdate({ moduleDir: checkoutRoot, home: inst.home, bindirs: [bindir] });
        if (result.code !== 0) {
          throw new Error(`runUpdate non è uscito 0:\n${JSON.stringify(result.steps, null, 2)}`);
        }

        const idx = (name: string): number => result.steps.findIndex((s) => s.name === name);
        const iBackup = idx('backup');
        const iFlip = idx('flip');
        if (iBackup === -1 || iFlip === -1) {
          throw new Error(`passi attesi mancanti fra quelli reali: ${JSON.stringify(result.steps.map((s) => s.name))}`);
        }
        // The property A6 asks for, checked as an order rather than assumed:
        // the backup happens BEFORE the swap, not after and not never.
        if (iBackup > iFlip) {
          throw new Error(`'backup' viene dopo 'flip' invece che prima: ${JSON.stringify(result.steps.map((s) => s.name))}`);
        }
        const backupStep = result.steps[iBackup]!;
        if (!backupStep.done) throw new Error(`il passo di backup non è riuscito: ${backupStep.detail}`);

        const backupMatch = /^(\S+) \(/.exec(backupStep.detail);
        if (!backupMatch) throw new Error(`il passo 'backup' non nomina il file prodotto: ${backupStep.detail}`);
        const backupFile = backupMatch[1]!;
        if (!existsSync(backupFile)) throw new Error(`il backup dichiarato non esiste sul disco: ${backupFile}`);

        // Validated independently of the mechanism's own claim — a real
        // sqlite file, quick_check ok, carrying the content written before
        // the update.
        const backupDb = new DatabaseCtor(backupFile, { readonly: true });
        try {
          const check = backupDb.pragma('quick_check', { simple: true });
          if (check !== 'ok') throw new Error(`quick_check sul backup: ${String(check)}`);
          const row = backupDb.prepare(`SELECT content FROM episodes WHERE content LIKE '%42%' LIMIT 1`).get();
          if (!row) throw new Error('il backup non porta il contenuto scritto prima dell\'update');
        } finally {
          backupDb.close();
        }

        // The swap itself is real: a fresh git worktree at the new commit,
        // and the launcher now resolves into it.
        const releaseStep = result.steps[idx('release')]!;
        const releaseMatch = /worktree creato in (\S+)/.exec(releaseStep.detail);
        if (!releaseMatch) throw new Error(`il passo 'release' non nomina la directory creata: ${releaseStep.detail}`);
        const releaseDir = releaseMatch[1]!;
        const releaseHead = gitOut(['rev-parse', 'HEAD'], releaseDir);
        if (releaseHead !== newSha) throw new Error(`il worktree della release non è al commit nuovo: ${releaseHead}, atteso ${newSha}`);

        const flipTarget = readlinkSync(launcherPath);
        const expectedEntry = join(releaseDir, 'dist', 'cli', 'main.js');
        if (flipTarget !== expectedEntry) {
          throw new Error(`il launcher non punta alla release nuova dopo il flip: ${flipTarget}, atteso ${expectedEntry}`);
        }

        // `defaultReadNewSchemaVersion` really spawned node and imported the
        // release's own compiled migrate.js — not the version this test
        // process itself has loaded.
        const schemaStep = result.steps[idx('schema')]!;
        if (!/v3/.test(schemaStep.detail)) {
          throw new Error(`il passo 'schema' non ha letto v3 dalla release compilata: ${schemaStep.detail}`);
        }

        // The live database was never touched directly by `update` — it was
        // only backed up. Proven on the real binary, same $MUFFIN_HOME,
        // spawned again: the content written before the update is still
        // there after it.
        const after = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (after.code !== 0 || !after.out.includes('42')) {
          throw new Error(`dopo l'update il contenuto scritto prima non si trova più:\n${after.out}`);
        }

        rmSync(root, { recursive: true, force: true });
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );
});

/**
 * A4 · config: `cli/config.ts` is read-only by design (ADR-0036) — the
 * terminal does exactly two things to the installation, the secret and
 * `muffin rot reseal`, and everything else (models, surfaces, language, job
 * text) is a hand-edit of `config.json` that must take effect on its own,
 * with no reseal needed, because `config.json` is explicitly the file
 * ADR-0036 keeps OUT of the seal. This scenario proves both halves of that
 * split are real, not merely documented: an unsealed knob (`models.main`)
 * changes what the real binary sends to the provider the moment the file is
 * saved, and a sealed knob (`rot/budgets.json`) changes what the real binary
 * *does* even before `muffin rot reseal` — reseal is what makes `doctor`
 * stop calling it tampering, never a precondition for the value binding.
 * `muffin config --json` is read after each edit as the owner-facing witness
 * ADR-0036 built for exactly this question ("cosa posso regolare, e dove").
 */
describe('acceptance · A4 · config: hand-edit + reseal, end to end', () => {
  scenario(
    'A4',
    async () => {
      const inst = await install({
        main: [{ text: 'ciao dal modello di partenza' }, { text: 'ciao dal modello cambiato a mano' }],
      });
      try {
        // --- (a) baseline: models.main as `muffin init` wrote it ------------
        const configPath = join(inst.home, 'config.json');
        const baseline = JSON.parse(readFileSync(configPath, 'utf8')) as { models: { main: string } };
        const originalModel = baseline.models.main;

        const first = await inst.muffin(['run', '--timeout', '20', 'ciao']);
        if (first.code !== 0) throw new Error(`turno iniziale: exit ${first.code}\n${first.err}`);
        const firstModelSent = inst.provider.main().at(-1)?.model;
        if (firstModelSent !== originalModel) {
          throw new Error(`il provider finto ha ricevuto model=${firstModelSent}, atteso il valore di config.json (${originalModel}) — fixture rotta`);
        }

        // --- (b) hand-edit config.json — a real, unsealed knob ---------------
        const EDITED_MODEL = 'acceptance-a4-modello-a-mano';
        const edited = { ...baseline, models: { ...baseline.models, main: EDITED_MODEL } };
        writeFileSync(configPath, JSON.stringify(edited, null, 2));

        const knobsAfterEdit = await inst.muffin(['config', '--json']);
        if (knobsAfterEdit.code !== 0) throw new Error(`muffin config --json: exit ${knobsAfterEdit.code}\n${knobsAfterEdit.err}`);
        const knobs = JSON.parse(knobsAfterEdit.out) as Array<{ key: string; value: string; sealed: boolean }>;
        const mainKnob = knobs.find((k) => k.key === 'models.main');
        if (!mainKnob) throw new Error(`muffin config --json non elenca models.main: ${knobsAfterEdit.out}`);
        if (mainKnob.value !== EDITED_MODEL) {
          throw new Error(`muffin config --json mostra ancora il vecchio valore dopo l'hand-edit: ${JSON.stringify(mainKnob)}`);
        }
        if (mainKnob.sealed !== false) {
          throw new Error(`models.main risulta sigillato — non dovrebbe: ADR-0036 lo tiene fuori dal Root of Trust`);
        }

        // The edited value is what the BINARY actually uses next — not just
        // what a reader of config.json would show. No `rot reseal` in
        // between: an unsealed knob must not need one.
        const second = await inst.muffin(['run', '--timeout', '20', 'ciao di nuovo']);
        if (second.code !== 0) throw new Error(`turno dopo l'hand-edit: exit ${second.code}\n${second.err}`);
        const secondModelSent = inst.provider.main().at(-1)?.model;
        if (secondModelSent !== EDITED_MODEL) {
          throw new Error(`il provider finto ha ricevuto model=${secondModelSent}, atteso il valore hand-editato (${EDITED_MODEL})`);
        }
        const doctorAfterUnsealedEdit = await inst.muffin(['doctor']);
        if (doctorAfterUnsealedEdit.code === 2) {
          throw new Error(`doctor va in fail per un hand-edit di un file esplicitamente NON sigillato:\n${doctorAfterUnsealedEdit.out}`);
        }
        if (/root of trust/i.test(doctorAfterUnsealedEdit.out) && !/✓ root of trust\s/.test(doctorAfterUnsealedEdit.out)) {
          throw new Error(`doctor segnala il root of trust come compromesso per un edit di config.json, che non ne fa parte:\n${doctorAfterUnsealedEdit.out}`);
        }

        // --- (c) hand-edit a SEALED file — takes effect immediately, but ----
        //         `doctor` calls it tampering until `muffin rot reseal` runs.
        const budgetsPath = join(inst.home, 'rot', 'budgets.json');
        const budgetsBefore = JSON.parse(readFileSync(budgetsPath, 'utf8')) as { monthlyUsd: number };
        const originalCap = budgetsBefore.monthlyUsd;
        const budgetsTampered = { ...budgetsBefore, monthlyUsd: 0 };
        writeFileSync(budgetsPath, JSON.stringify(budgetsTampered, null, 2));

        // Binds immediately — no reseal needed for the VALUE to take effect
        // (ADR-0036's own worked example: "con il tetto sigillato a 0 il
        // turno si ferma"). This is what tells apart "the seal enforces a
        // real cap" from "the seal is decorative and the real cap is
        // somewhere unsealed can reach".
        const stoppedByCap = await inst.muffin(['run', '--timeout', '20', 'un turno qualsiasi']);
        if (stoppedByCap.code !== 4) {
          throw new Error(`atteso exit 4 (budget) col tetto azzerato a mano, ricevuto ${stoppedByCap.code}\n${stoppedByCap.out}${stoppedByCap.err}`);
        }

        const doctorBeforeReseal = await inst.muffin(['doctor']);
        if (doctorBeforeReseal.code === 0) {
          throw new Error(`doctor non si accorge dell'hand-edit di un file sigillato:\n${doctorBeforeReseal.out}`);
        }
        if (!/root of trust/.test(doctorBeforeReseal.out) || !/budgets\.json/.test(doctorBeforeReseal.out)) {
          throw new Error(`doctor non nomina il file sigillato manomesso:\n${doctorBeforeReseal.out}`);
        }

        // --- (d) `muffin rot reseal` — the real terminal command ------------
        const reseal = await inst.muffin(['rot', 'reseal']);
        if (reseal.code !== 0) throw new Error(`muffin rot reseal: exit ${reseal.code}\n${reseal.out}${reseal.err}`);
        if (!/resealed \d+ files/.test(reseal.out)) {
          throw new Error(`muffin rot reseal non conferma quanti file ha risigillato: ${JSON.stringify(reseal.out)}`);
        }

        const doctorAfterReseal = await inst.muffin(['doctor']);
        if (!/✓ root of trust\s/.test(doctorAfterReseal.out)) {
          throw new Error(`doctor resta in fail sul root of trust dopo \`muffin rot reseal\`:\n${doctorAfterReseal.out}`);
        }

        const knobsAfterReseal = await inst.muffin(['config', '--json']);
        const budgetKnob = (JSON.parse(knobsAfterReseal.out) as Array<{ key: string; value: string; sealed: boolean; source: string }>).find(
          (k) => k.key === 'budgets.monthlyUsd',
        );
        if (!budgetKnob) throw new Error(`muffin config --json non elenca budgets.monthlyUsd: ${knobsAfterReseal.out}`);
        if (budgetKnob.sealed !== true) throw new Error(`budgets.monthlyUsd non risulta sigillato: ${JSON.stringify(budgetKnob)}`);
        if (budgetKnob.value !== '0') {
          throw new Error(`dopo il reseal muffin config --json non mostra il valore hand-editato (0): ${JSON.stringify(budgetKnob)}`);
        }
        if (budgetKnob.value === String(originalCap)) {
          throw new Error(`fixture inutile: il valore originale e quello editato coincidono (${originalCap})`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});

/**
 * A7 · migration: a real, additive migration runs against real, populated
 * data via the real binary — not a fresh install that was simply *born*
 * already at the target shape.
 *
 * `muffin init` calls `stampFresh` (`core/db/migrate.ts`), which stamps
 * every migration's version WITHOUT running its `up()` — correct for a fresh
 * install, and exactly why `install()` alone never exercises the migration
 * this row asks about. This scenario rewinds a real, populated database back
 * to "before migration v3" (deleting only the stamp, the way a real
 * pre-v3 install would simply never have had it — never touching the data
 * migration v3 itself would later change) and lets the real binary discover
 * the pending migration on its own next boot, the same path `agent/
 * runtime.ts`'s `migrate(db, …)` runs on every command that builds a
 * runtime. `rebuildTable`'s CHECK-widening escape hatch (`core/db/
 * migrate.ts`) is proven at the unit level (RETURN S2) but is not reachable
 * here: `MIGRATIONS` today holds only additive `ALTER TABLE`/backfill
 * entries (v2, v3), no migration in the array calls `rebuildTable` — so
 * there is nothing for an acceptance scenario to exercise there yet, and
 * this scenario proves what IS reachable (v3's real backfill, on real data,
 * through the real binary) rather than fabricating a CHECK-widening
 * migration that does not exist in production code.
 */
describe('acceptance · A7 · migration: additive migration on populated data, and the old-code guard', () => {
  scenario(
    'A7',
    async () => {
      const inst = await install({ main: [{ text: 'ciao' }] });
      try {
        const said = await inst.muffin(['run', '--timeout', '20', 'ciao']);
        if (said.code !== 0) throw new Error(`turno iniziale: exit ${said.code}\n${said.err}`);

        const dbFile = join(inst.home, 'muffin.db');
        const now = new Date().toISOString();
        // A fact written the way a pre-v3 install actually would have: BEFORE
        // migration 3 existed, `MemoryStore`'s own write path did not pin
        // identity facts either (`core/memory/ingest.ts`'s
        // `BOOTSTRAP_IDENTITY_PREDICATES` pinning at write time landed in the
        // SAME slice as the migration) — so writing this through today's real
        // ingest pipeline would already arrive pinned, proving nothing about
        // the migration. Inserted directly instead, at exactly the shape
        // `MEMORY_SCHEMA` requires, `pinned = 0` on purpose: this is the row
        // migration v3's backfill exists to find.
        let factId: number;
        {
          const seed = new DatabaseCtor(dbFile);
          try {
            const episodeId = (seed.prepare(`SELECT id FROM episodes ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined)?.id;
            if (!episodeId) throw new Error('fixture rotta: nessun episodio da cui appendere la fact');
            const entityId = seed
              .prepare(`INSERT INTO entities (tenant_id, kind, name, recorded_at) VALUES ('host', 'person', 'owner', ?)`)
              .run(now).lastInsertRowid as number;
            factId = seed
              .prepare(
                `INSERT INTO facts (tenant_id, subject_id, predicate, object_value, recorded_at, episode_id, trust_tier, confidence, origin, extraction_v, pinned)
                 VALUES ('host', ?, 'works_as', 'giardiniere', ?, ?, 0, 0.9, 'said', 1, 0)`,
              )
              .run(entityId, now, episodeId).lastInsertRowid as number;
          } finally {
            seed.close();
          }
        }

        const before = inst.db((db) => ({
          schemaV: (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v,
          fact: db.prepare(`SELECT pinned, tenant_id, trust_tier, origin FROM facts WHERE id = ?`).get(factId) as
            | { pinned: number; tenant_id: string; trust_tier: number; origin: string }
            | undefined,
          factCount: (db.prepare(`SELECT count(*) AS n FROM facts`).get() as { n: number }).n,
          entityCount: (db.prepare(`SELECT count(*) AS n FROM entities`).get() as { n: number }).n,
        }));
        if (!before.fact) throw new Error('fixture rotta: la fact appena inserita non si trova');
        if (before.fact.pinned !== 0) throw new Error(`fixture inutile: la fact è già pinned prima della migrazione (${before.fact.pinned})`);
        if (before.fact.tenant_id !== 'host' || before.fact.trust_tier !== 0 || before.fact.origin !== 'said') {
          throw new Error(`fixture non soddisfa i criteri del backfill di v3: ${JSON.stringify(before.fact)}`);
        }
        if (before.schemaV < 3) throw new Error(`fixture rotta: un'installazione fresca dovrebbe già essere a schema v3, trovato v${before.schemaV}`);

        // --- rewind: this install "has never run migration 3" --------------
        //     Only the stamp goes away — the real, populated data stays
        //     exactly as a pre-v3 install would actually have had it.
        {
          const rewind = new DatabaseCtor(dbFile);
          try {
            rewind.prepare(`DELETE FROM schema_version WHERE version = 3`).run();
          } finally {
            rewind.close();
          }
        }
        const rewoundV = inst.db((db) => (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v);
        if (rewoundV !== 2) throw new Error(`il rewind dello schema_version non ha funzionato: v${rewoundV}`);

        // --- the real binary, migrating real populated data on its own boot -
        // Not asserted to find the fact via recall: it was inserted directly,
        // never embedded, so a miss here says nothing about the migration.
        // What matters is that `buildRuntime` (and inside it, `migrate()`)
        // completes without throwing — "nessun risultato" (1) is a fine
        // outcome, a crash is not.
        const migrated = await inst.muffin(['memory', 'search', 'giardiniere']);
        if (migrated.code !== 0 && migrated.code !== 1) {
          throw new Error(`muffin memory search dopo la migrazione: exit ${migrated.code}\n${migrated.out}${migrated.err}`);
        }

        const after = inst.db((db) => ({
          schemaV: (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v,
          desc: db.prepare(`SELECT description FROM schema_version WHERE version = 3`).get() as { description: string } | undefined,
          fact: db.prepare(`SELECT pinned FROM facts WHERE id = ?`).get(factId) as { pinned: number } | undefined,
          factCount: (db.prepare(`SELECT count(*) AS n FROM facts`).get() as { n: number }).n,
          entityCount: (db.prepare(`SELECT count(*) AS n FROM entities`).get() as { n: number }).n,
        }));
        if (after.schemaV !== 3) throw new Error(`schema non è tornato a v3 dopo il boot: v${after.schemaV}`);
        if (after.desc?.description.includes('fresh install')) {
          throw new Error(`la riga di schema_version resta timbrata "fresh install" — la migrazione non è stata rieseguita per davvero: ${after.desc.description}`);
        }
        // Rows intact — the property an additive migration must have.
        if (after.factCount !== before.factCount) throw new Error(`righe facts cambiate: ${before.factCount} prima, ${after.factCount} dopo`);
        if (after.entityCount !== before.entityCount) throw new Error(`righe entities cambiate: ${before.entityCount} prima, ${after.entityCount} dopo`);
        // The constraint the migration exists for is now active: the owner's
        // identity fact is pinned, unconditionally in context from now on —
        // not merely "the column exists", which a stamp-only fresh install
        // would also show.
        if (after.fact?.pinned !== 1) throw new Error(`la migrazione non ha pinnato la fact attesa: ${JSON.stringify(after.fact)}`);

        // --- old code, newer data: SchemaAheadError, through the real binary
        {
          const bump = new DatabaseCtor(dbFile);
          try {
            bump
              .prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (99, 'finto — dal futuro', ?)`)
              .run(new Date().toISOString());
          } finally {
            bump.close();
          }
        }
        const ahead = await inst.muffin(['memory', 'search', 'giardiniere']);
        if (ahead.code === 0) {
          throw new Error(`il binario ha girato contro uno schema più avanti di sé senza rifiutare (exit ${ahead.code})`);
        }
        if (!/schema v99/.test(ahead.err) || !/più vecchio dei dati/.test(ahead.err)) {
          throw new Error(`il rifiuto non nomina lo schema avanti o la ragione: ${JSON.stringify(ahead.err)}`);
        }
        // Refused before writing anything — the data is exactly as it was.
        const untouched = inst.db((db) => ({
          factCount: (db.prepare(`SELECT count(*) AS n FROM facts`).get() as { n: number }).n,
          entityCount: (db.prepare(`SELECT count(*) AS n FROM entities`).get() as { n: number }).n,
        }));
        if (untouched.factCount !== after.factCount || untouched.entityCount !== after.entityCount) {
          throw new Error(`il rifiuto ha comunque cambiato le righe: prima ${JSON.stringify(after)}, dopo ${JSON.stringify(untouched)}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
