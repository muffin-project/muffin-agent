import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import { paths } from '../core/config/config.js';

/**
 * The persona reaches the turn.
 *
 * Asserted through `buildRuntime` — the production assembly — and not against
 * `buildSystemPromptBlocks` directly, because the thing that was wrong was
 * never the function: `voice.md` was written, shipped, installed by `muffin
 * init` and opened by nobody. A test of the builder in isolation would have
 * passed for months while every rule in that file was unreachable. This is the
 * wiring test, and it is the shape practice §5 asks for.
 *
 * 2026-08-17 (A2/A3, `slice/identita`): `defaults/persona.md`, `defaults/voice.md`
 * and `defaults/rot/identity.md` stopped being templates and became the
 * owner's real, authored text (commit c090dce). Several assertions here used
 * to depend on the *shape* of a template — empty headings, HTML comments
 * meant for a human editor, a placeholder sentence — none of which the real
 * files carry any more. Where the mechanism (`authored()` in
 * `agent/context/assemble.ts`) still needs exercising, the fixture now writes
 * its own synthetic content instead of relying on defaults/ happening to be
 * template-shaped — the same pattern the "keeps a section" test already used
 * correctly. One of these was found silently passing for the wrong reason
 * while fixing the rest: `'Sei il mio secondo cervello'`, the sentence a test
 * injected into `## Chi sei\n`, is *also* verbatim real prose at
 * `identity.md:11` — so the injection was a no-op (the real heading is
 * `## Chi sei per me\n`) and the assertion passed on pre-existing content
 * regardless. Fixed below with a marker string that cannot coincidentally
 * already be in the file.
 */

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-persona-'));
  // No turn runs, so the key is never used — the check stays model-free.
  runInit({ home, apiKey: 'sk-persona-never-called' });
  return home;
}

describe('persona in the system prompt', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-persona-ws-'));

  it('carries the voice rules into the prompt the loop actually gets', () => {
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;

    // Three rules from three different sections of voice.md: a formatting rule,
    // an honesty rule, and the emoji ceiling. If the file is not read, none of
    // them can be in here.
    expect(prompt).toContain('Niente meta-commentary');
    expect(prompt).toContain('Niente azioni simulate');
    expect(prompt).toMatch(/15% dei messaggi/);
  });

  it('gives a fresh install a character, without the owner having written a word', () => {
    // The comment that used to sit here said `identity.md` ships empty and that
    // therefore `persona.md` alone had to carry the whole floor. That stopped
    // being true at commit c090dce — the file-level docstring above says so, and
    // the two contradicted each other for months. Measured 28/08/2026 on a real
    // `runInit` home: `defaults/rot/identity.md` ships 4.928 bytes of authored
    // pact and reaches the prompt.
    //
    // It matters because it decides where a floor is allowed to live. On
    // 28/08 `persona.md` lost a third of its text to de-duplication, and the
    // honesty rule below was one of the sentences cut — it is asserted here
    // still, because the guarantee is about the *prompt*, not about which file
    // pays for it. If `identity.md` ever ships empty again, this goes red, and
    // that is the correct place for it to go red.
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;

    expect(prompt).toContain('Sono Muffin');
    // Two load-bearing promises: a second perspective with memory, not a mirror
    // of whatever was just said — and honest about whether an action happened.
    expect(prompt).toMatch(/seconda prospettiva con memoria/);
    expect(prompt).toMatch(/Non fingi di ricordare, aver visto, controllato, eseguito/);
    expect(prompt).toMatch(/Non descrivi un lavoro come completato se non lo è/);
    // The said/inferred discipline the memory layer enforces in SQL.
    expect(prompt).toContain('quello che ho inferito');
  });

  it("puts the owner's file after the shared one, so it reads as an overlay", () => {
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    const shared = prompt.indexOf('Sono Muffin');
    const owner = prompt.indexOf('Non mi dai ragione');
    // Both present before comparing: indexOf returns -1 when absent, and -1 is
    // less than everything, so the ordering assertion alone would pass loudest
    // exactly when the persona had gone missing.
    expect(shared).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(-1);
    expect(shared).toBeLessThan(owner);
  });

  it('strips HTML-comment scaffolding meant for the human editor, not the model', () => {
    // Neither shipped file carries a template comment any more — identity.md
    // is the owner's real text (0 occurrences of `<!--`, checked 2026-08-17).
    // Constructed here so the stripping mechanism in `authored()` stays tested
    // independently of what defaults/ happens to contain today.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    const original = readFileSync(identity, 'utf8');
    writeFileSync(
      identity,
      `${original}\n\n<!-- MARCATORE-SOLO-PER-UMANI: riscrivi questa sezione. -->\n\nMARCATORE-DOPO-COMMENTO resta.\n`,
    );
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    expect(prompt).not.toContain('MARCATORE-SOLO-PER-UMANI');
    expect(prompt).toContain('MARCATORE-DOPO-COMMENTO resta');
    // The authored content already in the file is untouched by the stripping.
    expect(prompt).toContain('Non mi dai ragione per farmi contento');
  });

  it('drops a heading the owner has left empty', () => {
    // An untouched template used to carry empty headings by construction; the
    // real identity.md answers all of its own, so this constructs one rather
    // than relying on the shipped file having an unfilled section. A bare
    // title with nothing under it would otherwise read to the model as a
    // section it is expected to have opinions about.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(identity, `${readFileSync(identity, 'utf8')}\n\n## MARCATORE-SEZIONE-VUOTA\n`);
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    expect(prompt).not.toContain('MARCATORE-SEZIONE-VUOTA');
  });

  it('keeps a section as soon as the owner writes in it', () => {
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      readFileSync(identity, 'utf8').replace(
        '## Chi sei per me\n',
        '## Chi sei per me\n\nMARCATORE-SCRITTO-DALLOWNER.\n',
      ),
    );
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    expect(prompt).toContain('MARCATORE-SCRITTO-DALLOWNER');
    expect(prompt).toContain('## Chi sei per me');
  });

  it('survives a home where the persona files are actually gone', () => {
    // This used to write an EMPTY file, which takes the readFileSync path and
    // never reaches the existsSync guard — so the test's name, comment and
    // assertion all described a case it did not construct. Removing that guard
    // left the whole suite green. It is the one line every pre-existing install
    // depends on: they have no persona.md, and without it boot throws ENOENT.
    const home = bootHome();
    rmSync(paths(home).voice);
    rmSync(paths(home).persona);
    expect(existsSync(paths(home).voice)).toBe(false);
    expect(() => buildRuntime(home, workspace)).not.toThrow();
  });

  it('keeps the owner name out of the pure-muffin files', () => {
    // PRACTICES.md#research-is-evidence-not-authority: persona.md and voice.md ship to every install and must
    // carry no fact about a specific owner. identity.md is this owner's own
    // pact — it lives in the Root of Trust exactly because it is personal —
    // and is allowed to name him (it does, at identity.md:86). This used to
    // check the whole owner prompt for the name, which broke the day
    // identity.md stopped being an empty template: the owner's name reaches
    // the owner prompt legitimately now, through identity.md. Reading the two
    // pure-muffin files directly is the claim that is actually supposed to hold.
    const home = bootHome();
    expect(readFileSync(paths(home).persona, 'utf8')).not.toMatch(/Giusto/);
    expect(readFileSync(paths(home).voice, 'utf8')).not.toMatch(/Giusto/);
  });

  it('keeps a heading whose answer lives only in a subsection', () => {
    // "Unfilled" means "nothing before the next heading of any level", so a
    // parent answered only in `###` subsections must not be deleted and its
    // children orphaned. Constructed synthetically: identity.md's own headings
    // all carry direct content now, so reusing one would not isolate this
    // branch of `authored()` from "kept because of direct content".
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      `${readFileSync(identity, 'utf8')}\n\n## MARCATORE-SOLO-SOTTOSEZIONE\n\n### Sotto\n\nMARCATORE-CONTENUTO-FIGLIO\n`,
    );
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    expect(prompt).toContain('## MARCATORE-SOLO-SOTTOSEZIONE');
    expect(prompt).toContain('MARCATORE-CONTENUTO-FIGLIO');
  });

  it('drops the whole tail rather than leak it when a comment is unterminated', () => {
    // One missing `-->` and the comment-stripping regex matches nothing, so an
    // orphaned `<!--` would otherwise sail straight into the prompt — cutting
    // from the opener is the fail-safe direction (losing authored text is
    // recoverable; shipping scaffolding as identity is what this exists to
    // stop). Constructed synthetically, per the class docstring above.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    const original = readFileSync(identity, 'utf8');
    writeFileSync(
      identity,
      `${original}\n\n<!-- MARCATORE-COMMENTO-NON-CHIUSO senza terminatore\nAncora testo dopo.\n`,
    );
    const prompt = buildRuntime(home, workspace).deps.systemPrompts.owner;
    expect(prompt).not.toContain('MARCATORE-COMMENTO-NON-CHIUSO');
    expect(prompt).not.toContain('Ancora testo dopo');
    // Everything authored before the orphan comment survives the cut.
    expect(prompt).toContain('Non mi dai ragione per farmi contento');
  });
});
