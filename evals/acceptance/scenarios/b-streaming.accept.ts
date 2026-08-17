import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';

/**
 * B11 · Streaming — the real binary, not a substituted `Provider`.
 *
 * `agent/loop.test.ts`, `cli/repl.test.ts` and `connectors/telegram/
 * {presence,streaming}.test.ts` already prove the mechanism in detail —
 * per-delta buffering, the rate limit, the byte-identical guarantee, the
 * fallback on a broken stream, each with fine-grained control this harness
 * cannot offer (a spawned child's stdout arrives here as one concatenated
 * string, not as the individual `process.stdout.write` calls those tests
 * inspect directly). What only *this* scenario proves is that the whole
 * stack — `cli/main.ts`'s own argv parsing, the `--stream` flag, `runRepl`,
 * the real `openai-compat` adapter's SSE parsing — actually holds together
 * across a real process boundary, talking to a real (if local) socket, the
 * same standard `provider.ts`'s own docstring sets for the rest of this
 * suite.
 *
 * `--stream` rather than relying on TTY autodetection: a spawned child's
 * stdout is a pipe, never a TTY, so the flag exists precisely for this case
 * (`cli/main.ts`'s own `streamOverride` docstring) — the acceptance
 * equivalent of "a script that still wants the progressive text".
 */
describe('acceptance · B11 · streaming', () => {
  scenario(
    'B11',
    async () => {
      const finalText = 'ciao dal muffin finto, questa risposta è arrivata in streaming';
      const inst = await install({ main: [{ text: finalText }] });
      try {
        const run = await inst.muffin(['repl', '--stream'], 'raccontami qualcosa\n');
        if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);

        // The real SSE round trip happened: the fake provider's own record of
        // what it received is the ground truth, not an assumption from the
        // answer arriving correctly — a non-streaming fallback would produce
        // the exact same final text, and this is the line that tells the two
        // apart.
        const seen = inst.provider.main();
        if (seen.length !== 1) throw new Error(`atteso 1 chiamata al modello, arrivate ${seen.length}`);
        if (seen[0]!.stream !== true) throw new Error('la richiesta non ha mai chiesto stream:true — --stream non ha acceso lo streaming');

        // The finished answer reached stdout, byte for byte — the same
        // guarantee cli/repl.test.ts checks in-process, now through the
        // compiled CLI and a real child process.
        if (!run.out.includes(finalText)) {
          throw new Error(`la risposta finita non è in stdout:\n${run.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
