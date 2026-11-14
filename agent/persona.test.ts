import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths } from '../core/config/config.js';
import { buildRuntime } from './runtime.js';

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

  it('carries the sealed identity into the prompt, and leaves the voice examples in the skill', () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace);
    const prompt = runtime.deps.systemPrompts.owner;
    runtime.close();

    expect(prompt).toContain('Il registro segue il momento');
    expect(prompt).toContain('Non fingi di ricordare, aver visto, controllato, eseguito');
    // The catalogue names the skill. The body — the 15% emoji ceiling — does not ride along.
    expect(prompt).toContain('voce');
    expect(prompt).not.toMatch(/15% dei messaggi/);
    expect(prompt).not.toContain('Niente meta-commentary');
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

    expect(prompt).toContain('Sei Muffin');
    expect(prompt).toMatch(/seconda prospettiva con memoria/);
    expect(prompt).toMatch(/Non fingi di ricordare, aver visto, controllato, eseguito/);
    expect(prompt).toMatch(/Non descrivi un lavoro come completato se non lo è/);
    expect(prompt).toContain("Un'inferenza resta un'inferenza");
  });

  it('states who Muffin is before the limits, in the one sealed file', () => {
    const home = bootHome();
    const runtime = buildRuntime(home, workspace);
    const prompt = runtime.deps.systemPrompts.owner;
    runtime.close();
    const who = prompt.indexOf('Sei Muffin');
    const limits = prompt.indexOf('Non mi dai ragione');
    expect(who).toBeGreaterThan(-1);
    expect(limits).toBeGreaterThan(-1);
    expect(who).toBeLessThan(limits);
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

  it('survives a home that has no persona.md and no voice.md', () => {
    const home = bootHome();
    expect(existsSync(paths(home).voice)).toBe(false);
    expect(existsSync(paths(home).persona)).toBe(false);
    const runtime = buildRuntime(home, workspace);
    expect(runtime.deps.systemPrompts.owner).toContain('Il registro segue il momento');
    runtime.close();
  });

  it('keeps the owner name out of the shipped identity and the voice skill', () => {
    // The sealed pact may name the owner once he writes it. The copy we ship,
    // and the skill every install receives, must not.
    const home = bootHome();
    expect(readFileSync(join(paths(home).rot, 'identity.md'), 'utf8')).not.toMatch(/Giusto/);
    expect(readFileSync(join(home, 'skills', 'voce', 'SKILL.md'), 'utf8')).not.toMatch(/Giusto/);
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
