import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import type { SkillInfo } from '../../core/skills/skills.js';
import type { RegisteredTool } from '../loop.js';

/**
 * skill_read — levels 2 and 3 of progressive disclosure.
 *
 * A dedicated door instead of widening fs_read's scope: the fs tools are
 * confined to the working directory by design, and skills live in the home.
 * This tool reads SKILL.md (activation) or a bundled file (references/,
 * assets/) and nothing else — the path is resolved against the skill's own
 * directory and refused if it lands outside it, symlinks included.
 *
 * Skill bodies are instructions on purpose — installed and audited by the
 * owner, tier 1, not fenced. What IS reported is which skills loaded and which
 * were skipped, at boot, so "installed" and "active" cannot drift silently.
 */
export const skillCapability: CapabilityDecl = {
  id: 'skill.read',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  maxTaint: 1,
  resourceKind: 'none',
  policyArgs: ['name'],
  hostOnly: true,
};

export const skillSpec: ToolSpec = {
  name: 'skill_read',
  description:
    'Read a skill. With just the name, returns its SKILL.md (activate the skill by following it). ' +
    'With file, returns that bundled file from the skill directory (references, assets).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, as listed' },
      file: { type: 'string', description: 'Optional path relative to the skill directory' },
    },
    required: ['name'],
  },
};

const skillArgs = z.object({
  name: z.string().min(1).max(64),
  file: z.string().min(1).max(500).optional(),
});

const MAX_SKILL_FILE_BYTES = 512 * 1024;

export function makeSkillTool(skills: readonly SkillInfo[]): RegisteredTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    capability: skillCapability.id,
    spec: skillSpec,
    // Every refusal below is `tier: 0`: they are this file's own sentences,
    // written before any skill file was opened. The one path that opens a file
    // is the one at the bottom, and it is the one that carries a tier.
    handler: (args) => {
      const parsed = skillArgs.safeParse(args);
      if (!parsed.success) {
        return { content: 'invalid arguments: name is required', isError: true, tier: 0 };
      }
      const skill = byName.get(parsed.data.name);
      if (!skill) {
        const known = [...byName.keys()].join(', ') || '(nessuna)';
        return {
          content: `skill sconosciuta: ${parsed.data.name}. Installate: ${known}`,
          isError: true,
          tier: 0,
        };
      }

      const requested = parsed.data.file ?? 'SKILL.md';
      const candidate = join(skill.dir, requested);
      // Both sides resolved, always: the skill dir itself may sit behind a
      // symlink (macOS /var does), and a bundled symlink may point out.
      let real: string;
      let realRoot: string;
      try {
        realRoot = realpathSync(skill.dir);
        real = realpathSync(candidate);
      } catch {
        return { content: `file non trovato: ${requested}`, isError: true, tier: 0 };
      }
      const escape = relative(realRoot, real);
      if (escape === '..' || escape.startsWith('..') || isAbsolute(escape)) {
        return { content: `il percorso esce dalla skill: ${requested}`, isError: true, tier: 0 };
      }
      if (!existsSync(real)) {
        return { content: `file non trovato: ${requested}`, isError: true, tier: 0 };
      }

      const content = readFileSync(real);
      if (content.length > MAX_SKILL_FILE_BYTES) {
        return {
          content: `${requested} è ${content.length} byte: oltre il limite di lettura (${MAX_SKILL_FILE_BYTES}). Le skill grandi vanno spezzate in file richiamati al bisogno.`,
          isError: true,
          // Refused on the length, and the bytes go no further than this branch.
          tier: 0,
        };
      }
      // `tier: 1`, which this file's own docstring has claimed since it was
      // written and which the return value did not carry. The omission was not
      // cosmetic: `agent/loop.ts` raises the turn's taint only when `tier` is
      // present, so a skill body — text this file classifies as *instructions*,
      // by design — entered context leaving taint at 0. And taint 0 is exactly
      // the condition `core/policy/decide.ts` requires to auto-allow `sys.shell`
      // in hardened mode, so a turn could read instructions and then reach the
      // shell without the owner being asked once.
      //
      // Tier 1 and not 3, and not fenced: these are owner-installed and
      // owner-audited files, not somebody else's web page. The point is that
      // "the owner wrote every word in this context" stops being true, which is
      // the question the shell gate is actually asking.
      return { content: content.toString('utf8'), tier: 1 };
    },
  };
}
