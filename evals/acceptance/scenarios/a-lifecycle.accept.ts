import { readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { install, type Install } from '../harness.js';
import type { RecordedRequest } from '../provider.js';
import { scenario } from '../scenario.js';

/**
 * A · Installation and lifecycle.
 *
 * Real installs, real second launches, real tampering — against the process
 * an owner actually runs, never `runInit`/`buildRuntime` called by hand.
 */

describe('acceptance · A · installazione e ciclo di vita', () => {
  scenario(
    'A1',
    async () => {
      const inst = await install({ main: [{ text: 'ciao, sono Muffin' }] });
      try {
        const first = await inst.muffin(['run', '--timeout', '20', 'ciao']);
        if (first.code !== 0) throw new Error(`primo avvio: exit ${first.code}\n${first.err}`);
        if (!first.out.includes('ciao, sono Muffin')) {
          throw new Error(`primo avvio non ha risposto come atteso: ${JSON.stringify(first.out)}`);
        }

        // "Al secondo avvio ritrova il suo stato": a brand-new process, same
        // home, no session in common with the first — the boot-level claim
        // (config, root of trust, database) rather than conversational
        // continuity, which is B1's separate claim. `doctor` never calls the
        // model, so a fake-provider exhaustion cannot hide a real boot failure.
        //
        // Exit 1 is expected here, not a failure: a brand-new install has real
        // `warn`-level lines (no vector index yet, consolidation never run,
        // no gateway installed) that doctor is right to surface even though
        // nothing is broken. Exit 2 (`fail`) is the level that would mean the
        // second launch could not find what the first one wrote.
        const second = await inst.muffin(['doctor']);
        if (second.code === 2) {
          throw new Error(`il secondo avvio non trova un'installazione sana: exit ${second.code}\n${second.out}`);
        }
        if (!/✓ root of trust/.test(second.out) || !/✓ database/.test(second.out)) {
          throw new Error(`il secondo avvio non conferma di aver ritrovato config/rot/db intatti:\n${second.out}`);
        }

        // The one turn that did run is on the durable record ADR-0042 built —
        // not something that only looks persistent from inside one process.
        const turnCount = inst.db((db) => (db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n);
        if (turnCount !== 1) throw new Error(`atteso 1 turno registrato, trovati ${turnCount}`);
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
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
