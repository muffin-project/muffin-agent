import { readFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { describe, expect, it } from 'vitest';
import { attachEventIntelligence } from '../agent/event-intelligence.js';
import { connectServer } from './mcp/connect.js';
import { SandboxExecutor } from './sandbox/executor.js';

/**
 * The copy that matters is the one the production file resolves, not the
 * top-level import. A nested vulnerable pin fails this even when the root
 * package is already patched.
 */
function packageJson(specifier: string, fromFile: string): string {
  const found = findPackageJSON(specifier, pathToFileURL(fromFile));
  if (typeof found !== 'string') throw new Error(`could not resolve ${specifier} from ${fromFile}`);
  return found;
}

function resolvedVersion(specifier: string, fromFile: string): string {
  const pkg = JSON.parse(readFileSync(packageJson(specifier, fromFile), 'utf8')) as {
    version?: string;
  };
  if (typeof pkg.version !== 'string') {
    throw new Error(`no version for ${specifier} from ${fromFile}`);
  }
  return pkg.version;
}

function atLeast(version: string, floor: string): boolean {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
  const got = parse(version);
  const want = parse(floor);
  for (let i = 0; i < 3; i++) {
    const delta = (got[i] ?? 0) - (want[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

type PatchedZod = {
  unknown: () => { superRefine: (check: () => void) => unknown };
  array: (element: unknown) => {
    max: (limit: number) => { safeParse: (value: unknown) => { success: boolean } };
  };
};

describe('runtime advisory floors on the production resolvers', () => {
  it('connectServer loads an MCP client at or above the 2.3.0 advisory floor', () => {
    expect(typeof connectServer).toBe('function');
    const from = fileURLToPath(new URL('./mcp/connect.ts', import.meta.url));
    const version = resolvedVersion('@modelcontextprotocol/client/stdio', from);
    expect(atLeast(version, '2.3.0')).toBe(true);
  });

  it('embedded event intelligence resolves patched zod and stops before element reads', () => {
    expect(typeof attachEventIntelligence).toBe('function');
    const caller = fileURLToPath(new URL('../agent/event-intelligence.ts', import.meta.url));
    const embedded = packageJson('mcp-event-intelligence/embedded', caller);
    expect(atLeast(resolvedVersion('zod', embedded), '4.6.6')).toBe(true);
    expect(atLeast(resolvedVersion('@modelcontextprotocol/server', embedded), '2.3.0')).toBe(true);

    // Same bound the embedded host kit publishes on trigger events and where-clauses.
    const { z } = createRequire(embedded)('zod') as { z: PatchedZod };
    let seen = 0;
    const parsed = z
      .array(
        z.unknown().superRefine(() => {
          seen += 1;
        }),
      )
      .max(32)
      .safeParse(Array.from({ length: 40 }, () => ({ n: 1 })));
    expect(parsed.success).toBe(false);
    expect(seen).toBe(0);
  });

  it('the sandbox executor resolves patched zod and its config schema still accepts the off-network shape', () => {
    expect(typeof SandboxExecutor).toBe('function');
    const from = fileURLToPath(new URL('./sandbox/executor.ts', import.meta.url));
    const sandboxPkg = packageJson('@anthropic-ai/sandbox-runtime', from);
    expect(atLeast(resolvedVersion('zod', sandboxPkg), '4.6.6')).toBe(true);
    const parsed = SandboxRuntimeConfigSchema.safeParse({
      network: { allowedDomains: [], deniedDomains: ['*'] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    });
    expect(parsed.success).toBe(true);
  });
});
