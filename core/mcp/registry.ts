import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { looksLikeSecretValue } from '../tracing/redact.js';
import { paths } from '../config/config.js';
import { ensurePrivateDir, tightenPrivateFile } from '../config/private-fs.js';

/**
 * The MCP server allowlist, with tool pinning — threat model §c-bis.
 *
 * A server's tool *definitions* (name, description, inputSchema) are prompt
 * material coming from outside the trust boundary. Allowlisting the server is
 * not enough: an allowlisted server that gets compromised can rewrite its own
 * descriptions and place instructions in the prompt with more standing than
 * any fenced recall block — the rug-pull. So approval pins a sha256 of every
 * tool's definition, and any later variation suspends the server until the
 * owner re-approves. The pin lives here, in `~/.muffin/mcp.json`, owner-edited
 * only through the CLI.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CREDENTIAL_IN_ARGV =
  'un valore con la forma di una credenziale non può stare in argv; registra il segreto e passalo nel relativo --env come secret://nome';

const ServerEntrySchema = z.object({
  command: z
    .string()
    .min(1)
    .refine((value) => !looksLikeSecretValue(value), CREDENTIAL_IN_ARGV),
  args: z
    .array(z.string().refine((value) => !looksLikeSecretValue(value), CREDENTIAL_IN_ARGV))
    .default([]),
  /**
   * Environment passed to the server, explicit and empty by default. The SDK
   * adds only its own safelist (PATH, HOME, …) — the host process env, API key
   * included, never crosses.
   *
   * Le credenziali viaggiano come riferimenti `secret://nome`, risolti solo al
   * momento di avviare il figlio. I valori letterali non sensibili
   * (`LANG=C`, un percorso, un flag) restano permessi in `env`. Lo schema
   * rifiuta i valori che corrispondono alle forme note a
   * `looksLikeSecretValue`, anche in un `mcp.json` scritto a mano: è una rete
   * best-effort (classe 3), non una garanzia contro token personalizzati o
   * stringhe opache. Non passare segreti letterali in `env`, `command` o
   * `args`; la protezione strutturale vale per i valori già nel backend
   * segreto, passati come riferimenti.
   * `command` and `args` are also checked for credential-shaped values: they
   * become child-process argv and are stored in this registry. This is the
   * class-3 shape detector, not a guarantee for arbitrary custom credentials.
   */
  env: z
    .record(
      z.string(),
      z
        .string()
        .refine(
          (value) => !looksLikeSecretValue(value),
          'un valore con la forma di una credenziale: registralo con `muffin secret set` e mettici `secret://nome`',
        ),
    )
    .default({}),
  approvedAt: z.string().min(1),
  /** toolName → sha256 of the canonical definition, pinned at approval. */
  tools: z.record(z.string(), z.string().length(64)),
});

const RegistryFileSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.record(z.string().regex(NAME_RE), ServerEntrySchema),
});

export type McpServerEntry = z.infer<typeof ServerEntrySchema>;
export type McpRegistry = z.infer<typeof RegistryFileSchema>;

export class McpConfigError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'McpConfigError';
  }
}

function registryPath(home: string): string {
  return join(paths(home).home, 'mcp.json');
}

export function loadMcpRegistry(home: string): McpRegistry {
  const file = registryPath(home);
  if (!existsSync(file)) return { schemaVersion: 1, servers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new McpConfigError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'fix the syntax, or remove the file and re-add servers with `muffin mcp add`',
    );
  }
  const parsed = RegistryFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new McpConfigError(
      `${file} is invalid — ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'unparseable'}`,
      'fix that field, or remove the entry and re-add it with `muffin mcp add`',
    );
  }
  return parsed.data;
}

export function saveMcpRegistry(registry: McpRegistry, home: string): void {
  const file = registryPath(home);
  const parsed = RegistryFileSchema.safeParse(registry);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new McpConfigError(
      `${file} is invalid — ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'unparseable'}`,
      'rimuovi i valori con forma di credenziale dagli argomenti e usa riferimenti secret:// solo nel campo env',
    );
  }
  if (!ensurePrivateDir(paths(home).home)) {
    throw new McpConfigError(
      `non posso scrivere ${file}: la directory privata non è stata stabilita (symlink sulla catena)`,
      'rimuovi il symlink e riprova',
    );
  }
  writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenPrivateFile(file);
}

/** What gets hashed. Everything the model will see, nothing volatile. */
export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The protocol's own `annotations` (`ToolAnnotations` in the SDK: `title`,
   * `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, all
   * optional). Retained from `listTools` so the reversible mapping below reads
   * a declared value, not a guess — and hashed with the rest, because an
   * annotation flip is a rug-pull with the same standing as a rewritten
   * description: a server approved as read-only that later declares itself
   * destructive (or the reverse) suspends until the owner re-approves.
   */
  annotations?: McpToolAnnotations;
};

/**
 * The five protocol hint fields, nothing else. Unknown keys from the wire are
 * dropped at the boundary (`connect.ts`), so a server cannot smuggle hash
 * volatility — or meaning — through a field this build never reviewed.
 */
export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * ADR-0074 punto 5: the annotations the MCP server declares are the authority
 * for the reversible flag. `readOnlyHint: true` is `reversible: 'yes'`; a
 * `destructiveHint` or absent annotations are `'no'` and ask (row `external`).
 *
 * Two deliberate fail-closed readings where the ADR is silent:
 * - contradictory hints (`readOnlyHint` AND `destructiveHint` true) are `'no'`:
 *   the server disagrees with itself, and the direction that asks is the one
 *   that survives a lie;
 * - `readOnlyHint: false` is `'no'`, not `'yes'`: only an explicit `true`
 *   lifts the ask, the default is today's ask-everything, byte for byte.
 *
 * The SDK itself warns that hints are "not guaranteed to provide a faithful
 * description" and that clients should never decide on them from untrusted
 * servers. They are not trusted here either: they are *pinned* — an
 * annotation change breaks the tool hash and suspends the server — so the
 * authority is the owner's approval of that exact declaration, not the
 * server's live word.
 */
export function reversibleFromAnnotations(annotations?: McpToolAnnotations): 'yes' | 'no' {
  if (annotations?.readOnlyHint === true && annotations?.destructiveHint !== true) return 'yes';
  return 'no';
}

/**
 * sha256 over a canonical serialization: object keys sorted at every level, so
 * a server that merely re-orders its schema fields is not "changed". Anything
 * else — a word in the description, a new argument, a widened type, a flipped
 * hint — is. Absent annotations hash as `{}`: the pin covers the authority,
 * not just the prose.
 */
export function toolHash(tool: McpToolDef): string {
  const canonical = stableStringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; added: string[]; removed: string[]; changed: string[] };

/** Compare what the server offers now with what the owner approved. */
export function verifyTools(listed: McpToolDef[], pinned: Record<string, string>): VerifyOutcome {
  const added: string[] = [];
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const tool of listed) {
    seen.add(tool.name);
    const pin = pinned[tool.name];
    if (pin === undefined) added.push(tool.name);
    else if (pin !== toolHash(tool)) changed.push(tool.name);
  }
  const removed = Object.keys(pinned).filter((name) => !seen.has(name));
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return { ok: true };
  return { ok: false, added, removed, changed };
}

/** Build the pin map at approval time. */
export function pinTools(listed: McpToolDef[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const tool of listed) pins[tool.name] = toolHash(tool);
  return pins;
}
