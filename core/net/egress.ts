import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/config.js';

/**
 * The egress allowlist — the first real reader of `rot/egress.json`.
 *
 * The file shipped with the RoT scaffold and was hashed by `verify` from day
 * one, but nothing consumed it: the exact "written, tested, connected to
 * nothing" shape this repo keeps paying for. sys.http is its consumer, and the
 * wiring test lives next to the kernel branch that reads it.
 *
 * Allow-only, no domain granted by default. Patterns are exact hostnames or a
 * single leading wildcard label (`*.example.com` matches `api.example.com`,
 * NOT `example.com` and NOT `deep.api.example.com`... deliberately: every
 * widening is a policy edit the owner can read in a diff).
 */

/**
 * `.loose()`, not the strip-by-default of a bare `z.object`: `rot/egress.json`
 * is a file the owner can and does hand-edit (`_comment` exists exactly for
 * that), and a key we do not recognise — a second note, a field a future
 * version will read — is not garbage to discard on the next rewrite
 * (`widenEgressForCapability`, `core/rot/egress-writer.ts`). Nothing here
 * ever *reads* an unknown key (`loadEgress` below still projects out only
 * `allow`), so keeping it costs nothing at the only two call sites that
 * parse this schema, and it is the one choice of the three that never turns
 * an owner's own edit into data loss the file's next writer never mentions.
 */
export const EgressFileSchema = z
  .object({
    _comment: z.string().optional(),
    schemaVersion: z.literal(1),
    allow: z.array(z.string().min(1)),
  })
  .loose();

export type EgressPolicy = {
  readonly allow: readonly string[];
};

export class EgressError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

export function loadEgress(home: string): EgressPolicy {
  const file = join(paths(home).rot, 'egress.json');
  if (!existsSync(file)) {
    // The RoT manifest verification runs before this and would already have
    // refused a tampered install; a missing file here is an incomplete one.
    throw new EgressError(`no egress policy at ${file}`, 'reinstall the root of trust: `muffin rot reinstall`');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new EgressError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'restore it from the repo defaults and re-run `muffin rot reinstall`',
    );
  }
  const parsed = EgressFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EgressError(
      `${file} is invalid — ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'unparseable'}`,
      'fix the field or restore the file from the repo defaults',
    );
  }
  return { allow: parsed.data.allow.map((d) => d.toLowerCase()) };
}

/**
 * Case-insensitive; ports are not part of the policy (strip before calling).
 * `example.com` does not authorize `evil-example.com` — matching is on label
 * boundaries, never on string suffixes.
 */
export function hostAllowed(host: string, policy: EgressPolicy): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const pattern of policy.allow) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      // exactly one extra label: *.example.com covers api.example.com only
      if (h.endsWith(`.${base}`) && !h.slice(0, -(base.length + 1)).includes('.')) return true;
    } else if (h === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Addresses no egress may ever reach, allowlist or not: loopback, RFC1918,
 * link-local (the cloud metadata endpoint lives there), CGNAT, multicast,
 * reserved, and their IPv6 relatives — including v4-mapped v6, which is the
 * classic way a "public" hostname resolves somewhere private after all.
 * This is the anti-SSRF floor under the allowlist, not a substitute for it.
 */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return forbiddenV4(address);
  if (kind === 6) return forbiddenV6(address);
  return true; // not an IP at all: never connect to it
}

function forbiddenV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local, metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function forbiddenV6(address: string): boolean {
  const h = address.toLowerCase();
  // v4-mapped (::ffff:10.0.0.1) and NAT64 (64:ff9b::) carry a v4 answer
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return forbiddenV4(mapped[1]!);
  if (h.startsWith('64:ff9b:')) return true;
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}
