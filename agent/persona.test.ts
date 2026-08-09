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
 * `buildSystemPrompt` directly, because the thing that was wrong was never the
 * function: `voice.md` was written, shipped, installed by `muffin init` and
 * opened by nobody. A test of the builder in isolation would have passed for
 * months while every rule in that file was unreachable. This is the wiring
 * test, and it is the shape practice §5 asks for.
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
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;

    // Three rules from three different sections of voice.md: a formatting rule,
    // an honesty rule, and the emoji ceiling. If the file is not read, none of
    // them can be in here.
    expect(prompt).toContain('Niente meta-commentary');
    expect(prompt).toContain('Niente azioni simulate');
    expect(prompt).toMatch(/15% dei messaggi/);
  });

  it('gives a fresh install a character, without the owner having written a word', () => {
    // identity.md ships empty on purpose. Before persona.md existed, that meant
    // a first run had three bullet points and a set of formatting rules where
    // the personality should be — which is what "it feels like a mockup" was.
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;

    expect(prompt).toContain('Sono Muffin');
    // The two load-bearing promises: complement the owner's memory rather than
    // echo it, and never claim a capability the turn does not actually have.
    expect(prompt).toMatch(/la completo dove è debole/);
    expect(prompt).toMatch(/i tool di questo turno/);
    // And the said/inferred discipline the memory layer now enforces in SQL.
    expect(prompt).toContain('Detto e dedotto');
  });

  it("puts the owner's file after the shared one, so it reads as an overlay", () => {
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;
    const shared = prompt.indexOf('Sono Muffin');
    const owner = prompt.indexOf('Non mi dai ragione');
    // Both present before comparing: indexOf returns -1 when absent, and -1 is
    // less than everything, so the ordering assertion alone would pass loudest
    // exactly when the persona had gone missing.
    expect(shared).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(-1);
    expect(shared).toBeLessThan(owner);
  });

  it('does not hand the model the instructions written for the owner', () => {
    // Both persona files ship as templates whose HTML comments address a human:
    // "Questo file è tuo. Scrivilo com'è." Injected verbatim, that scaffolding
    // became the identity on a fresh install — the agent was given a page about
    // how someone should write its character, and nothing else.
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;

    expect(readFileSync(join(paths(home).rot, 'identity.md'), 'utf8')).toContain('Questo file è tuo');
    expect(prompt).not.toContain('Questo file è tuo');
    expect(prompt).not.toContain('Riscrivile, tagliale, ribaltale');
    // The authored content of the same file is still there.
    expect(prompt).toContain('Non mi dai ragione per farmi contento');
  });

  it('drops the sections the owner has not filled in yet', () => {
    // An untouched template carries three empty headings. A bare title with
    // nothing under it reads as a section the model should have opinions about.
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;

    expect(prompt).not.toMatch(/##\s*Chi sei\s*\n/);
    expect(prompt).not.toMatch(/##\s*Il limite che ti do io/);
  });

  it('keeps a section as soon as the owner writes in it', () => {
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      readFileSync(identity, 'utf8').replace(
        '## Chi sei\n',
        '## Chi sei\n\nSei il mio secondo cervello, non il mio portavoce.\n',
      ),
    );

    const prompt = buildRuntime(home, workspace).deps.systemPrompt;
    expect(prompt).toContain('Sei il mio secondo cervello');
    expect(prompt).toContain('## Chi sei');
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

  it("ships no personal name to an install that is not the author's", () => {
    // The voice file was written for one owner and named him three times. It
    // was inert while nothing read it; wiring it into the prompt shipped his
    // private register to every install — PRACTICES §9, violated by the change
    // that routes the file rather than by the file.
    const home = bootHome();
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;
    expect(prompt).not.toMatch(/Giusto/);
  });

  it('keeps a heading whose answer lives in its subsections', () => {
    // "Unfilled" meant "nothing before the next heading of any level", so a
    // parent answered in `###` subsections was deleted and its children
    // orphaned. identity.md ships such a heading.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      readFileSync(identity, 'utf8').replace(
        '## Come ti comporti quando è difficile\n',
        '## Come ti comporti quando è difficile\n\n### Quando non sai\n\nLo dici.\n',
      ),
    );
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;
    expect(prompt).toContain('## Come ti comporti quando è difficile');
    expect(prompt).toContain('Lo dici.');
  });

  it('drops the whole block rather than leak it when a comment is unterminated', () => {
    // One missing `-->` and the regex matches nothing, putting the owner-facing
    // scaffolding back into the identity — the precise defect this function
    // exists to prevent, one character away.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(identity, readFileSync(identity, 'utf8').replace('-->', ''));
    const prompt = buildRuntime(home, workspace).deps.systemPrompt;
    expect(prompt).not.toContain('Questo file è tuo');
  });
});
