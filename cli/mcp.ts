import { connectServer } from '../core/mcp/connect.js';
import {
  loadMcpRegistry,
  McpConfigError,
  pinTools,
  saveMcpRegistry,
  toolHash,
  verifyTools,
  type McpServerEntry,
} from '../core/mcp/registry.js';

/**
 * Operator verbs over the MCP allowlist — the audit surface the threat model
 * names (`muffin mcp list --verify`, §c-bis).
 *
 * `add` is also the re-approval path: approving means READING what the tools
 * say they do and pinning it. So `add` prints every description before it
 * pins — the owner approves text they have seen, not a count. Re-running
 * `add <name>` with no command reconnects the stored entry and re-pins:
 * that is what "rivedi e ri-approva" resolves to.
 */

export const MCP_USAGE = `usage:
  muffin mcp list [--verify]          i server approvati; --verify riconnette e ricontrolla i pin
  muffin mcp add <name> [--env K=V]... -- <command> [args...]
  muffin mcp add <name>               ri-approva un server esistente (ripinna i tool)
  muffin mcp remove <name>
`;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export async function cmdMcpAdd(
  home: string,
  name: string,
  command: string | undefined,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  if (!NAME_RE.test(name)) {
    process.stderr.write(`nome non valido: "${name}" (minuscole, cifre, - e _, max 32)\n`);
    return 78;
  }
  const registry = loadMcpRegistry(home);
  const existing = registry.servers[name];

  let entry: McpServerEntry;
  if (command) {
    entry = { command, args, env, approvedAt: new Date().toISOString(), tools: {} };
  } else if (existing) {
    entry = { ...existing, approvedAt: new Date().toISOString() };
  } else {
    process.stderr.write(`"${name}" non esiste: serve il comando.\n${MCP_USAGE}`);
    return 78;
  }

  let connection;
  try {
    connection = await connectServer(name, entry);
  } catch (error) {
    process.stderr.write(
      `connessione fallita: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  try {
    if (connection.tools.length === 0) {
      process.stderr.write(`${name} non espone alcun tool: niente da approvare.\n`);
      return 1;
    }
    // The owner approves text they have seen. This listing IS the approval act.
    process.stdout.write(`${name} espone ${connection.tools.length} tool:\n\n`);
    for (const tool of connection.tools) {
      const oneLine = tool.description.replace(/\s+/g, ' ').slice(0, 100);
      process.stdout.write(`  ${tool.name}  [${toolHash(tool).slice(0, 12)}]\n    ${oneLine}\n`);
    }
    entry.tools = pinTools(connection.tools);
    registry.servers[name] = entry;
    saveMcpRegistry(registry, home);
    process.stdout.write(
      `\n${Object.keys(entry.tools).length} tool pinnati. Ogni variazione futura sospende il server.\n`,
    );
    return 0;
  } finally {
    await connection.close().catch(() => {});
  }
}

export async function cmdMcpList(home: string, verify: boolean): Promise<number> {
  let registry;
  try {
    registry = loadMcpRegistry(home);
  } catch (error) {
    if (error instanceof McpConfigError) {
      process.stderr.write(`${error.message}\n→ ${error.remedy}\n`);
      return 1;
    }
    throw error;
  }
  const names = Object.keys(registry.servers);
  if (names.length === 0) {
    process.stdout.write('nessun server MCP approvato. `muffin mcp add` per iniziare.\n');
    return 0;
  }

  let drifted = false;
  for (const name of names) {
    const entry = registry.servers[name]!;
    const head = `${name.padEnd(16)} ${Object.keys(entry.tools).length} tool · approvato ${entry.approvedAt.slice(0, 10)} · ${entry.command}`;
    if (!verify) {
      process.stdout.write(`${head}\n`);
      continue;
    }
    try {
      const connection = await connectServer(name, entry);
      const verdict = verifyTools(connection.tools, entry.tools);
      await connection.close().catch(() => {});
      if (verdict.ok) {
        process.stdout.write(`${head} · PIN OK\n`);
      } else {
        drifted = true;
        const what = [
          verdict.changed.length > 0 ? `cambiati: ${verdict.changed.join(',')}` : null,
          verdict.added.length > 0 ? `nuovi: ${verdict.added.join(',')}` : null,
          verdict.removed.length > 0 ? `spariti: ${verdict.removed.join(',')}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        process.stdout.write(`${head} · DRIFT (${what}) — sospeso finché non ri-approvi\n`);
      }
    } catch (error) {
      drifted = true;
      process.stdout.write(
        `${head} · CONNESSIONE FALLITA (${error instanceof Error ? error.message : String(error)})\n`,
      );
    }
  }
  // Scriptable: a clean audit exits 0, anything suspicious does not.
  return drifted ? 1 : 0;
}

export function cmdMcpRemove(home: string, name: string): number {
  const registry = loadMcpRegistry(home);
  if (!registry.servers[name]) {
    process.stderr.write(`"${name}" non è nel registro.\n`);
    return 1;
  }
  delete registry.servers[name];
  saveMcpRegistry(registry, home);
  process.stdout.write(`${name} rimosso. I suoi tool spariscono al prossimo avvio.\n`);
  return 0;
}
