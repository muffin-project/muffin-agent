import type { CapabilityDecl } from '../../core/policy/types.js';
import { fence } from '../../core/memory/spotlight.js';
import { connectServer, type McpConnection } from '../../core/mcp/connect.js';
import { verifyTools, type McpRegistry } from '../../core/mcp/registry.js';
import type { RegisteredTool } from '../loop.js';

/**
 * MCP servers become loop tools — after verification, and never above it.
 *
 * Three rules from the threat model (§c-bis), each visible here:
 *  1. A server whose tools do not match their pinned hashes is SUSPENDED: no
 *     tool registered, one report line, re-approval is the only way back.
 *  2. Third-party descriptions are data, not instructions: fenced with a
 *     nonce, and MCP tools are appended after every internal tool.
 *  3. Every result is tier 3 and fenced — it raises the turn's taint like any
 *     other untrusted content, which is what disarms the poisoned-result
 *     attack downstream (the kernel refuses tainted turns the sensitive
 *     capabilities).
 *
 * One capability per server (`mcp.<name>`): medium risk, host-only, default
 * taint ceiling 1 — a turn already carrying untrusted content cannot reach
 * out through a third-party server at all.
 *
 * That ceiling is INHERITED from the class default, not pinned here, and the
 * sentence above is only true because `policy.json` may lower the default and
 * never raise it (`core/policy/matrix.ts`, `tighter`). A judge measured the
 * version where it could: `{"medium":3}` in a resealed file made this a silent
 * `allow` at taint 3. If that clamp ever goes, pin `maxTaint: 1` here.
 */
export function mcpCapabilityFor(server: string): CapabilityDecl {
  return {
    id: `mcp.${server}`,
    risk: 'medium',
    reversible: 'no',
    // We do not own the semantics on the other side of the pipe, so a call that
    // may have landed is never made twice. This is the value that must not
    // become a per-server option later without the server telling us: a
    // third-party tool declaring itself re-runnable is a claim we cannot check.
    rerunnable: false,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: true,
  };
}

export type McpAttachment = {
  tools: RegisteredTool[];
  capabilities: CapabilityDecl[];
  /** One line per server: connected with N tools, suspended with the reason, or failed. */
  report: string[];
  close(): Promise<void>;
};

/** Injectable for tests. */
export type McpDeps = {
  connectFn?: typeof connectServer;
};

export async function buildMcpTools(registry: McpRegistry, deps: McpDeps = {}): Promise<McpAttachment> {
  const connectFn = deps.connectFn ?? connectServer;
  const tools: RegisteredTool[] = [];
  const capabilities: CapabilityDecl[] = [];
  const report: string[] = [];
  const connections: McpConnection[] = [];

  for (const [server, entry] of Object.entries(registry.servers)) {
    let connection: McpConnection;
    try {
      connection = await connectFn(server, entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report.push(`mcp:${server} — connessione fallita: ${detail}`);
      continue;
    }

    const verdict = verifyTools(connection.tools, entry.tools);
    if (!verdict.ok) {
      // The rug-pull gate. A changed description is an attempted instruction
      // with maximum standing; nothing from this server reaches the loop.
      const what = [
        verdict.changed.length > 0 ? `cambiati: ${verdict.changed.join(', ')}` : null,
        verdict.added.length > 0 ? `nuovi: ${verdict.added.join(', ')}` : null,
        verdict.removed.length > 0 ? `spariti: ${verdict.removed.join(', ')}` : null,
      ]
        .filter((s) => s !== null)
        .join('; ');
      report.push(
        `mcp:${server} SOSPESO — le definizioni dei tool non combaciano coi pin (${what}). ` +
          `Rivedi e ri-approva con \`muffin mcp add ${server}\`.`,
      );
      await connection.close().catch(() => {});
      continue;
    }

    connections.push(connection);
    capabilities.push(mcpCapabilityFor(server));

    for (const def of connection.tools) {
      const fenced = fence('mcpdesc', def.description, `descrizione dal server terzo "${server}"`);
      tools.push({
        capability: `mcp.${server}`,
        spec: {
          name: `mcp_${server}_${def.name}`,
          description: fenced.block,
          // Hash-verified against the owner's pin above; the shape is the
          // server's contract and the provider passes it through opaquely.
          inputSchema: def.inputSchema as RegisteredTool['spec']['inputSchema'],
        },
        handler: async (args) => {
          const result = await connection.call(def.name, (args ?? {}) as Record<string, unknown>);
          const body = fence('mcp', result.text, `risultato di ${server}.${def.name}`);
          return {
            content: body.block,
            tier: 3,
            ...(result.isError ? { isError: true } : {}),
          };
        },
      });
    }
    report.push(`mcp:${server} — ${connection.tools.length} tool verificati e attivi`);
  }

  return {
    tools,
    capabilities,
    report,
    async close() {
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}
