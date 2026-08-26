import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from '../../core/config/config.js';
import type { Principal } from '../../core/policy/types.js';
import { buildRuntime, type Runtime } from '../runtime.js';
import { tenantClass, visibleTools } from './assemble.js';

/**
 * The prompt is a function of the tenant, and the tool list is a function of the
 * principal.
 *
 * Asserted through `buildRuntime` — the production assembly — for the same
 * reason `persona.test.ts` is: what was wrong here was never the builder. The
 * defect was that `buildSystemPrompt` took no tenant at all, so a group turn
 * received, byte for byte, the owner's prompt: the owner's private pact from
 * `identity.md`, and the persona section that tells the agent to *elicit
 * personal facts* one at a time — in the one tenant whose memory is not the
 * owner's.
 */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'muffin-assemble-ws-'));

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-assemble-'));
  // No turn runs, so the key is never used — the check stays model-free.
  runInit({ home, apiKey: 'sk-assemble-never-called' });
  return home;
}

function boot(home: string): Runtime {
  return buildRuntime(home, WORKSPACE);
}

const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const MEMBER: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:-100',
  externalId: '77',
};

describe('which class a turn belongs to', () => {
  it('gives the host tenant to the owner class and every other tenant to the group class', () => {
    expect(tenantClass(OWNER, 'host')).toBe('owner');
    expect(tenantClass(MEMBER, 'group:telegram:-100')).toBe('group');
    expect(tenantClass(MEMBER, 'community:amici')).toBe('group');
  });

  it('sends the host work of the autonomous principals to the owner class', () => {
    // The scheduler and the observing spine run on the host, for the owner, on
    // the owner's own memory. A group prompt there would make the daily brief
    // talk to its owner as a guest in someone else's room.
    expect(tenantClass({ kind: 'system', source: 'scheduler' }, 'host')).toBe('owner');
    expect(tenantClass({ kind: 'system', source: 'consolidation' }, 'host')).toBe('owner');
    expect(tenantClass({ kind: 'agent', role: 'dev' }, 'host')).toBe('owner');
  });

  it('falls to the group class whenever either half is not host work', () => {
    // Two independent conditions, each failing towards the narrower prompt. A
    // member carrying the host tenant is not constructible through any
    // connector today; if one ever builds it, the answer must not be "here is
    // the owner's identity file".
    expect(tenantClass(MEMBER, 'host')).toBe('group');
    expect(tenantClass(OWNER, 'group:telegram:-100')).toBe('group');
    expect(tenantClass({ kind: 'system', source: 'scheduler' }, 'group:telegram:-1')).toBe('group');
  });
});

describe('the owner-class prompt does not move', () => {
  /**
   * sha256 of the owner-class prompt of a fresh `muffin init` home.
   *
   * This is the cache pin, and it is deliberately brittle. Splitting the prompt
   * by class is worthless if the owner's half shifts by a byte: every session
   * that has a warm prefix goes cold, silently, and behaviour changes with it.
   *
   * When this fails after an intentional edit to `defaults/persona.md`,
   * `defaults/voice.md` or `defaults/rot/identity.md`, that is the test doing
   * its job — re-capture the hash in the same commit as the edit, so the cache
   * invalidation is a thing someone decided rather than a thing that happened.
   *
   * Note that the three files named above are not the only inputs: `WORK_RULES`
   * in `assemble.ts` is a fourth, and it is the one the re-capture below moved.
   *
   * Re-captured 2026-08-26 (`slice/come-lavori`): three rules added to
   * `WORK_RULES`, each closing a gap the runtime does not close on its own —
   * see that constant's docstring for which trace produced which rule. The
   * assembly order is unchanged. Previous pin, for the record:
   * `7dbab742425de4af2b473f7e509a72e82cb501ddc2d3e50527e700f1f6740c53`.
   *
   * Re-captured 2026-08-17 (`slice/identita`, A2/A3): commit c090dce replaced
   * the three template files with the owner's real, authored text (persona.md
   * and voice.md rewritten, identity.md filled in for the first time) — that
   * hash was that text through the *unchanged* assembly order, not a new
   * mechanism. 22,477 chars / 22,772 UTF-8 bytes, against 11,498 chars before
   * (roughly double — see the PR body for the full before/after and the
   * `group` class' smaller delta). Pin before that one:
   * `3ebf2cfc307bdda5c73fff6ed4d60d5a9db2eceffac754164b220a86214cabf2`.
   */
  const OWNER_PROMPT_SHA_AT_SPLIT =
    'a83e22ce2ab67a953c1c0b1af96c38a67ff5271593d903d1ca87c728724cde73';

  it('is byte-identical to the single prompt that preceded the split', () => {
    const runtime = boot(bootHome());
    try {
      const sha = createHash('sha256')
        .update(runtime.deps.systemPrompts.owner, 'utf8')
        .digest('hex');
      expect(sha).toBe(OWNER_PROMPT_SHA_AT_SPLIT);
    } finally {
      runtime.close();
    }
  });
});

describe('what a group turn is allowed to be told', () => {
  it("carries nothing from the owner's identity file", () => {
    // Found while fixing this suite for c090dce (2026-08-17): the injected
    // heading used to be `'## Chi sei\n'`, which does not occur in the real
    // `identity.md` — its heading is `'## Chi sei per me\n'` — so the
    // `.replace()` below was a silent no-op and the two `toContain` assertions
    // on `owner` passed anyway, because "Sei il mio secondo cervello" is *also*
    // verbatim real prose at `identity.md:11`. The test read green for the
    // wrong reason. Fixed to the real heading, with a marker string that
    // cannot coincidentally already be in the file.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      readFileSync(identity, 'utf8').replace(
        '## Chi sei per me\n',
        '## Chi sei per me\n\nMARCATORE-IDENTITY-SOLO-OWNER.\n',
      ),
    );
    const runtime = boot(home);
    try {
      const { owner, group } = runtime.deps.systemPrompts;
      // Present on the owner side, so the absence below is a filter and not a
      // file that failed to load.
      expect(owner).toContain('MARCATORE-IDENTITY-SOLO-OWNER');
      expect(owner).toContain('Non mi dai ragione per farmi contento');
      expect(group).not.toContain('MARCATORE-IDENTITY-SOLO-OWNER');
      expect(group).not.toContain('Non mi dai ragione per farmi contento');
    } finally {
      runtime.close();
    }
  });

  it("never carries persona.md's owner-facing content into the group prompt", () => {
    // 2026-08-17 (`slice/identita`): this used to check for a specific section,
    // "Al primo incontro" — 1,330 characters of the *old template* persona.md
    // that instructed the agent to elicit name and occupation, one piece at a
    // time. Commit c090dce replaced persona.md with the owner's real text,
    // which does not have that section at all any more (a defensible rewrite,
    // not a regression: the historical defect this whole module exists to
    // close was never about that one section — it was `persona.md` reaching
    // the group *at all*, whatever it happens to say this month). So this now
    // asserts the general property directly: three sentences unique to the
    // current `persona.md` (verified absent from `voice.md`, `identity.md` and
    // every hardcoded block in this file) are addressed to the owner and must
    // never reach a stranger.
    const runtime = boot(bootHome());
    try {
      const { owner, group } = runtime.deps.systemPrompts;
      expect(owner).toContain('Sono una seconda prospettiva con memoria.');
      expect(owner).toContain('Mi importa della persona con cui vivo nel tempo');
      expect(owner).toContain('Il mio humour è secco, spontaneo e affettuoso.');

      expect(group).not.toContain('seconda prospettiva con memoria');
      expect(group).not.toContain('Mi importa della persona con cui vivo nel tempo');
      expect(group).not.toContain('Il mio humour è secco, spontaneo e affettuoso');
    } finally {
      runtime.close();
    }
  });

  it('states the guest posture instead of leaving the room undescribed', () => {
    const runtime = boot(bootHome());
    try {
      const { group } = runtime.deps.systemPrompts;
      expect(group).toContain('Sono Muffin');

      // Every phrase below is unique to the group persona. `/ospite/` was the
      // first assertion here and it was theatre: `voice.md` §"Quando parli in
      // gruppo" contains the word, so deleting the entire posture block from
      // the persona left this test — and the whole suite — green. Caught by
      // mutation, which is the only thing that catches this class.
      expect(group).toContain('## Dove sei adesso');
      // `\s+` across the phrases that wrap: the assertion is about the rule
      // being stated, not about where the paragraph happens to break.
      expect(group).toMatch(/non sto costruendo il ritratto di\s+nessuno/);
      expect(group).toMatch(/Quello che so del mio owner non è materiale di conversazione/);
      expect(group).toMatch(/Chi scrive qui non è il mio owner/);
    } finally {
      runtime.close();
    }
  });

  it('reuses the voice file rather than growing a second one for groups', () => {
    const runtime = boot(bootHome());
    try {
      const { owner, group } = runtime.deps.systemPrompts;
      // `voice.md` already knows how to behave in a group, and it is the file
      // whose staleness this repo has already paid for once — shipped, then
      // opened by nobody for months. A separate group voice would recreate
      // exactly that: two files, one of them rarely read.
      expect(group).toContain('Quando parlo in gruppo');
      expect(group).toContain('🧁 è ancora più raro in gruppo');
      // Byte-identical in both classes, not merely present in both.
      const voiceStart = '# Voce';
      expect(group.slice(group.indexOf(voiceStart))).toContain(
        owner.slice(owner.indexOf(voiceStart), owner.indexOf('## Come lavori')).trim(),
      );
    } finally {
      runtime.close();
    }
  });

  it('does not advertise the skills a member cannot open', () => {
    const home = bootHome();
    const skillDir = join(home, 'skills', 'brief-giornata');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: brief-giornata\ndescription: Prepara il brief della giornata.\n---\n# Brief\nTre righe.\n`,
    );
    const runtime = boot(home);
    try {
      // `skill.read` is hostOnly, so the door is shut for a member by the
      // kernel. Listing the skills anyway is the same defect as showing the
      // tool: a catalogue of things the answer will be "no" to.
      expect(runtime.deps.systemPrompts.owner).toContain('brief-giornata');
      expect(runtime.deps.systemPrompts.group).not.toContain('brief-giornata');
    } finally {
      runtime.close();
    }
  });

  it('keeps the operational rules, which are not about the owner', () => {
    const runtime = boot(bootHome());
    try {
      const { group, owner } = runtime.deps.systemPrompts;
      expect(group).toContain('## Come lavori');
      expect(group).toContain('Non fingere di aver fatto');
      // The three rules added on 26/08 are about the turn too, so they belong
      // to both classes — `WORK_RULES` is one constant in both lists, and this
      // pins that it stays that way rather than being forked per class.
      for (const rule of [
        'lo chiede il kernel',
        'chiediti cosa è cambiato',
        'prima di partire',
      ]) {
        expect(group).toContain(rule);
        expect(owner).toContain(rule);
      }
      // Form rules apply everywhere: a second voice for groups is how the two
      // drift, and drift in this file is measured in emoji thresholds.
      expect(group).toContain('Niente azioni simulate');
    } finally {
      runtime.close();
    }
  });
});

describe('the tool list a principal is shown', () => {
  it('hides every host-only tool from a member', () => {
    const runtime = boot(bootHome());
    try {
      const all = runtime.deps.tools;
      const caps = runtime.deps.capabilities;
      const forMember = visibleTools(all, MEMBER, caps);

      expect(forMember.length).toBeGreaterThan(0);
      expect(forMember.length).toBeLessThan(all.length);
      for (const tool of forMember) {
        expect(caps?.get(tool.capability)?.hostOnly, tool.spec.name).toBe(false);
      }
      // And the shape of the loss is named, not just counted.
      const names = forMember.map((t) => t.spec.name);
      expect(names).toContain('memory_search');
      expect(names).not.toContain('fs_read');
      expect(names).not.toContain('fs_write');
      expect(names).not.toContain('skill_read');
    } finally {
      runtime.close();
    }
  });

  it('hides nothing from the owner, the scheduler or the dev agent', () => {
    const runtime = boot(bootHome());
    try {
      const all = runtime.deps.tools;
      const caps = runtime.deps.capabilities;
      expect(visibleTools(all, OWNER, caps)).toEqual(all);
      expect(visibleTools(all, { kind: 'system', source: 'scheduler' }, caps)).toEqual(all);
      expect(visibleTools(all, { kind: 'agent', role: 'dev' }, caps)).toEqual(all);
    } finally {
      runtime.close();
    }
  });

  it('agrees with the kernel in both directions, without being the kernel', () => {
    // Defence in depth only means something if the two depths agree. The filter
    // is derived from the same declarations `decide.ts:132` reads, so this
    // cross-check fails the moment they diverge — and it reads the real
    // assembled `decide`, never a hand-built one.
    const runtime = boot(bootHome());
    try {
      const { tools, capabilities, decide } = runtime.deps;
      const shown = new Set(visibleTools(tools, MEMBER, capabilities).map((t) => t.spec.name));
      let refused = 0;
      for (const tool of tools) {
        const decision = decide({
          principal: MEMBER,
          tenant: MEMBER.tenantId,
          capability: tool.capability,
          resource: { kind: 'none' },
          args: {},
          taint: 2,
        });
        const hostOnlyRefusal =
          decision.effect === 'deny' && decision.detail === 'host-only capability';
        if (hostOnlyRefusal) refused += 1;
        // Shown ⇒ not refused for being host-only; refused ⇒ not shown.
        expect(shown.has(tool.spec.name), tool.spec.name).toBe(!hostOnlyRefusal);
      }
      expect(refused).toBeGreaterThan(0);
    } finally {
      runtime.close();
    }
  });

  it('hides an undeclared capability from a member rather than betting on it', () => {
    // The kernel answers `no_capability` for everyone, so hiding it from the
    // member costs nothing and keeps the direction of the failure fail-closed.
    const runtime = boot(bootHome());
    try {
      const rogue = { ...runtime.deps.tools[0]!, capability: 'not.declared' };
      const shown = visibleTools([rogue], MEMBER, runtime.deps.capabilities);
      expect(shown).toEqual([]);
      expect(visibleTools([rogue], OWNER, runtime.deps.capabilities)).toEqual([rogue]);
    } finally {
      runtime.close();
    }
  });

  it('filters nothing when there are no declarations to filter by', () => {
    // The degradation is documented on `LoopDeps.capabilities`: absent only so a
    // test can build a minimal deps object. Production always passes it
    // (`agent/runtime.ts`), and the kernel refuses either way.
    const runtime = boot(bootHome());
    try {
      expect(visibleTools(runtime.deps.tools, MEMBER, undefined)).toEqual(runtime.deps.tools);
    } finally {
      runtime.close();
    }
  });
});
