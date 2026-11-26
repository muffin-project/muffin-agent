import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0114: no LLM-callable tool module may import the registry's `commit`
 * path, or the privileged sinks that a settings write would go through.
 * The conversational tool, when it arrives, talks only to a propose facade
 * that calls `plan` — never `commit`, `saveConfig`, `writeAuthoritativeSecret`
 * or `widenEgressForCapability`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(ROOT, 'agent', 'tools');

const FORBIDDEN_MODULES = [
  /(?:^|\/)actions-commit\.js$/,
  /(?:^|\/)actions-approval\.js$/,
  /(?:^|\/)actions-commit\.ts$/,
];

const FORBIDDEN_NAMES_BY_MODULE: ReadonlyArray<{ name: string; module: RegExp }> = [
  { name: 'commit', module: /(?:^|\/)actions(?:-commit)?\.js$/ },
  { name: 'saveConfig', module: /(?:^|\/)config\.js$/ },
  { name: 'writeAuthoritativeSecret', module: /(?:^|\/)config\.js$/ },
  { name: 'widenEgressForCapability', module: /(?:^|\/)egress-writer\.js$/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) yield path;
  }
}

function stripTypeOnly(source: string): string {
  return source
    .replace(/^\s*import\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '')
    .replace(/^\s*export\s+type\s+[\s\S]*?;(?=\s*(?:\n|$))/gm, '');
}

function importedModules(source: string): string[] {
  const body = stripTypeOnly(source);
  const specs: string[] = [];
  const staticRe = /import\s*(?:([\s\S]*?)\s+from\s*)?['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reexportRe = /export\s+(?:\*|\*\s+as\s+[\w$]+|\{([^}]*)\})\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of body.matchAll(staticRe)) {
    specs.push(match[2] ?? '');
  }
  for (const match of body.matchAll(dynamicRe)) specs.push(match[1] ?? '');
  for (const match of body.matchAll(reexportRe)) specs.push(match[2] ?? '');
  return specs;
}

function namedImports(
  source: string,
): Array<{ names: string[]; module: string; namespace: boolean }> {
  const body = stripTypeOnly(source);
  const out: Array<{ names: string[]; module: string; namespace: boolean }> = [];
  const re =
    /import\s+(?:(\*\s+as\s+[\w$]+)|(?:[\w$]+\s*,\s*)?\{([^}]*)\}|[\w$]+)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of body.matchAll(re)) {
    const namespace = match[1] !== undefined;
    const raw = match[2] ?? '';
    const names = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !/^type\s+/.test(entry))
      .map((entry) => (entry.split(/\s+as\s+/)[0] ?? entry).trim());
    out.push({ names, module: match[3] ?? '', namespace });
  }
  return out;
}

describe('settings registry layering (ADR-0114)', () => {
  it('no module under agent/tools/ imports commit or privileged settings sinks', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const path of walk(TOOLS)) {
      scanned += 1;
      const source = readFileSync(path, 'utf8');
      const rel = relative(ROOT, path);
      for (const spec of importedModules(source)) {
        if (FORBIDDEN_MODULES.some((re) => re.test(spec))) {
          violations.push(`${rel} imports ${spec}`);
        }
      }
      for (const imp of namedImports(source)) {
        if (imp.namespace && FORBIDDEN_NAMES_BY_MODULE.some((f) => f.module.test(imp.module))) {
          violations.push(`${rel} namespace-imports ${imp.module}`);
          continue;
        }
        for (const rule of FORBIDDEN_NAMES_BY_MODULE) {
          if (rule.module.test(imp.module) && imp.names.includes(rule.name)) {
            violations.push(`${rel} imports ${rule.name} from ${imp.module}`);
          }
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
