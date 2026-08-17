import DatabaseCtor from 'better-sqlite3';
import { readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
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

describe('acceptance · A · installazione e ciclo di vita', () => {
  scenario(
    'A1',
    async () => {
      // Owner directive (M5-BIS A1, this slice's mandate): continuity belongs
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
 * are two readings of the *same* evidence (M5-BIS: A2 "sa chi è e quali
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

  scenario(
    'A8',
    async () => {
      const inst = await install({ main: [{ text: 'segnato: il tuo numero preferito è 42' }] });
      try {
        const said = await inst.muffin(['run', '--timeout', '20', 'il mio numero fortunato è 42, ricordatelo']);
        if (said.code !== 0) throw new Error(`turno iniziale: exit ${said.code}\n${said.err}`);

        const before = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (before.code !== 0 || !before.out.includes('42')) {
          throw new Error(`prima del backup la ricerca non trova già il contenuto — la fixture è rotta:\n${before.out}`);
        }

        // The backup an owner can actually take today: the whole data root.
        // AGENTS.md is explicit that everything lives under one directory —
        // this scenario is what proves that claim rather than assuming it, by
        // discarding the original entirely and restoring only from the copy.
        const backupDir = `${inst.home}-backup`;
        cpSync(inst.home, backupDir, { recursive: true });
        rmSync(inst.home, { recursive: true, force: true });
        cpSync(backupDir, inst.home, { recursive: true });
        rmSync(backupDir, { recursive: true, force: true });

        const after = await inst.muffin(['memory', 'search', 'numero fortunato']);
        if (after.code !== 0) throw new Error(`dopo il ripristino la ricerca fallisce: exit ${after.code}\n${after.err}`);
        if (!after.out.includes('42')) {
          throw new Error(`dopo il ripristino il contenuto non si ritrova più:\n${after.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
