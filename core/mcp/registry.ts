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

const ServerEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Environment passed to the server, explicit and empty by default. The SDK
   * adds only its own safelist (PATH, HOME, …) — the host process env, API key
   * included, never crosses.
   *
   * **Solo riferimenti `secret://nome`, mai valori** (direttiva owner
   * 2026-08-18). La regola vive qui, nello schema, e non solo nel parser di
   * `muffin mcp add`: un `mcp.json` scritto a mano con un token letterale lo
   * consegnerebbe al figlio senza che nessuno obietti, e la garanzia
   * dipenderebbe dal fatto che si passi dalla CLI. Un valore che non è un
   * segreto — `LANG=C`, un percorso, un flag — non appartiene all'env di un
   * server MCP: sta negli `args`, dove è visibile per quello che è.
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
  if (!ensurePrivateDir(paths(home).home)) {
    throw new McpConfigError(
      `non posso scrivere ${file}: la directory privata non è stata stabilita (symlink sulla catena)`,
      'rimuovi il symlink e riprova',
    );
  }
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenPrivateFile(file);
}

/** What gets hashed. Everything the model will see, nothing volatile. */
export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * sha256 over a canonical serialization: object keys sorted at every level, so
 * a server that merely re-orders its schema fields is not "changed". Anything
 * else — a word in the description, a new argument, a widened type — is.
 */
export function toolHash(tool: McpToolDef): string {
  const canonical = stableStringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
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
