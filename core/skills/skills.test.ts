import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeSkillTool } from '../../agent/tools/skill.js';
import { discoverSkills, parseSkill, skillsPromptSection } from './skills.js';

const ctx = { tenant: 'host', principal: { kind: 'owner', connector: 'cli' } } as const;

function homeWithSkill(name: string, content: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-skills-'));
  const dir = join(home, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return home;
}

const VALID = `---
name: brief-mattina
description: >-
  Prepara il brief della mattina. Usala quando l'owner chiede
  il riassunto della giornata.
license: MIT
---
# Brief

Leggi il calendario, poi rispondi in tre righe.
`;

describe('parseSkill', () => {
  it('parses the standard six fields, folded YAML description included', () => {
    const out = parseSkill(VALID, 'brief-mattina', '/x');
    expect(out).toMatchObject({ name: 'brief-mattina' });
    if (!('problem' in out)) {
      expect(out.description).toContain('riassunto della giornata');
      expect(out.ignoredKeys).toEqual([]);
    }
  });

  it('a name that does not match the directory is refused, not repaired', () => {
    const out = parseSkill(VALID, 'altra-dir', '/x');
    expect(out).toHaveProperty('problem');
    expect(String((out as { problem: string }).problem)).toContain('non combacia');
  });

  it('missing frontmatter is a named problem, never a silent empty load', () => {
    const out = parseSkill('# solo body\n', 'x', '/x');
    expect(out).toHaveProperty('problem');
  });

  it('a non-standard key is ignored and named, not fatal', () => {
    const withExtra = VALID.replace('license: MIT', 'license: MIT\nargument-hint: "<data>"');
    const out = parseSkill(withExtra, 'brief-mattina', '/x');
    expect(out).toMatchObject({ ignoredKeys: ['argument-hint'] });
  });

  it('an oversized description fails with the field named', () => {
    const big = `---\nname: x\ndescription: ${'a'.repeat(1100)}\n---\nbody`;
    const out = parseSkill(big, 'x', '/x');
    expect(String((out as { problem: string }).problem)).toContain('description');
  });
});

describe('discoverSkills', () => {
  it('loads the valid, reports the broken, and never confuses the two', () => {
    const home = homeWithSkill('brief-mattina', VALID);
    const brokenDir = join(home, 'skills', 'rotta');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), 'niente frontmatter');
    const scan = discoverSkills(home);
    expect(scan.skills.map((s) => s.name)).toEqual(['brief-mattina']);
    expect(scan.problems.length).toBe(1);
    expect(scan.problems[0]).toContain('rotta');
  });

  it('an absent skills directory is simply empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-skills-'));
    expect(discoverSkills(home)).toEqual({ skills: [], problems: [] });
  });
});

describe('skillsPromptSection', () => {
  it('lists metadata and names the activation mechanism', () => {
    const home = homeWithSkill('brief-mattina', VALID);
    const section = skillsPromptSection(discoverSkills(home).skills);
    expect(section).toContain('brief-mattina —');
    expect(section).toContain('skill_read');
  });

  it('is absent when no skill is installed — no empty scaffolding in the prompt', () => {
    expect(skillsPromptSection([])).toBe('');
  });
});

describe('skill_read', () => {
  function toolFor(home: string) {
    return makeSkillTool(discoverSkills(home).skills);
  }

  it('returns the body on activation and bundled files on demand', async () => {
    const home = homeWithSkill('brief-mattina', VALID);
    writeFileSync(join(home, 'skills', 'brief-mattina', 'REFERENCE.md'), 'dettagli qui');
    const tool = toolFor(home);
    const body = await tool.handler({ name: 'brief-mattina' }, ctx);
    expect(body.isError).toBeUndefined();
    expect(body.content).toContain('tre righe');
    const ref = await tool.handler({ name: 'brief-mattina', file: 'REFERENCE.md' }, ctx);
    expect(ref.content).toBe('dettagli qui');
  });

  it('an unknown skill answers with what IS installed', async () => {
    const home = homeWithSkill('brief-mattina', VALID);
    const out = await toolFor(home).handler({ name: 'inventata' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('brief-mattina');
  });

  it('a path that climbs out of the skill is refused', async () => {
    const home = homeWithSkill('brief-mattina', VALID);
    writeFileSync(join(home, 'segreto.txt'), 'non leggermi');
    const out = await toolFor(home).handler({ name: 'brief-mattina', file: '../../segreto.txt' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain('non leggermi');
  });

  it('a symlink pointing outside the skill is refused too', async () => {
    const home = homeWithSkill('brief-mattina', VALID);
    writeFileSync(join(home, 'segreto.txt'), 'non leggermi');
    symlinkSync(join(home, 'segreto.txt'), join(home, 'skills', 'brief-mattina', 'link.txt'));
    const out = await toolFor(home).handler({ name: 'brief-mattina', file: 'link.txt' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain('non leggermi');
  });
});
