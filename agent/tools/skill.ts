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
    handler: (args) => {
      const parsed = skillArgs.safeParse(args);
      if (!parsed.success) {
        return { content: 'invalid arguments: name is required', isError: true };
      }
      const skill = byName.get(parsed.data.name);
      if (!skill) {
        const known = [...byName.keys()].join(', ') || '(nessuna)';
        return { content: `skill sconosciuta: ${parsed.data.name}. Installate: ${known}`, isError: true };
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
        return { content: `file non trovato: ${requested}`, isError: true };
      }
      const escape = relative(realRoot, real);
      if (escape === '..' || escape.startsWith('..') || isAbsolute(escape)) {
        return { content: `il percorso esce dalla skill: ${requested}`, isError: true };
      }
      if (!existsSync(real)) {
        return { content: `file non trovato: ${requested}`, isError: true };
      }

      const content = readFileSync(real);
      if (content.length > MAX_SKILL_FILE_BYTES) {
        return {
          content: `${requested} è ${content.length} byte: oltre il limite di lettura (${MAX_SKILL_FILE_BYTES}). Le skill grandi vanno spezzate in file richiamati al bisogno.`,
          isError: true,
        };
      }
      return { content: content.toString('utf8') };
    },
  };
}
