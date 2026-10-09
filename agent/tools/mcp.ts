import type { CapabilityDecl } from '../../core/policy/types.js';
import { fence } from '../../core/memory/spotlight.js';
import { connectServer, type McpConnection } from '../../core/mcp/connect.js';
import {
  reversibleFromAnnotations,
  verifyTools,
  type McpRegistry,
  type McpToolDef,
} from '../../core/mcp/registry.js';
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
 * One capability per tool (`mcp.<server>.<tool>`): medium risk, host-only,
 * default taint ceiling 1 — a turn already carrying untrusted content cannot
 * reach out through a third-party server at all.
 *
 * The one field that varies per tool is `reversible`, and it is not set here:
 * ADR-0074 punto 5 makes the protocol's own `annotations` the authority
 * (`reversibleFromAnnotations` in `core/mcp/registry.ts` — `readOnlyHint: true`
 * is `'yes'`, a `destructiveHint` or absent annotations are `'no'` and ask).
 * A server with ten read-only tools and one destructive tool therefore asks
 * for exactly the one, instead of asking for all eleven (the old per-server
 * `'no'`) or for none. Everything else — risk, row, ceiling, `rerunnable`
 * below — is identical for every tool, which is the "no widening beyond
 * annotations" half of the slice.
 *
 * That ceiling used to be INHERITED from the class default, and the sentence
 * above was only true because `policy.json` may lower the default and never
 * raise it (`core/policy/matrix.ts`, `tighter`). A judge measured the version
 * where it could: `{"medium":3}` in a resealed file made this a silent `allow`
 * at taint 3. Since ADR-0053 it is held by the `external` row instead — same
 * number, now stated rather than inherited, which is what that measurement
 * asked for.
 */
export function mcpCapabilityFor(server: string, tool: McpToolDef): CapabilityDecl {
  return {
    id: `mcp.${server}.${tool.name}`,
    // Third-party code we do not own, outside the egress allowlist model: the
    // one row the threat model's matrix does not print, kept at exactly the
    // ceiling this capability already had rather than widened into a printed
    // row nobody reviewed it for.
    effect: 'external',
    risk: 'medium',
    // Declared by the server, pinned by the registry: the tool hash covers the
    // annotations, so a hint flip suspends the server until the owner
    // re-approves instead of silently moving a tool across the ask boundary.
    reversible: reversibleFromAnnotations(tool.annotations),
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

export type McpEventConnection = {
  connectionId: string;
  serverId: string;
  request(method: string, params?: unknown): Promise<unknown>;
  getCapabilities(): unknown;
  /** Optional tuning knobs consumed by an embedded event layer. */
  pollIntervalMs?: number;
  maxEvents?: number;
};

export type McpAttachment = {
  tools: RegisteredTool[];
  capabilities: CapabilityDecl[];
  /**
   * Verified host-owned MCP sessions exposed as a narrow Events-capable view.
   * Consumers never reconnect or receive the underlying credentials/transport.
   */
  eventConnections: McpEventConnection[];
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
  const eventConnections: McpEventConnection[] = [];

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
    if (connection.request !== undefined && connection.getCapabilities !== undefined) {
      eventConnections.push({
        connectionId: server,
        serverId: server,
        request: connection.request,
        getCapabilities: connection.getCapabilities,
      });
    }
    for (const def of connection.tools) capabilities.push(mcpCapabilityFor(server, def));

    for (const def of connection.tools) {
      const fenced = fence('mcpdesc', def.description, `descrizione dal server terzo "${server}"`);
      const capability = `mcp.${server}.${def.name}`;
      tools.push({
        capability,
        spec: {
          name: `mcp_${server}_${def.name}`,
          description: fenced.block,
          // Hash-verified against the owner's pin above; the shape is the
          // server's contract and the provider passes it through opaquely.
          inputSchema: def.inputSchema as RegisteredTool['spec']['inputSchema'],
        },
        // `throwTier: 3`, matching the tier every successful call already
        // declares. Judge round-1 (PR #28): `connection.call` → `client.callTool`
        // lets a JSON-RPC-level error through uncaught, and its `message` is the
        // THIRD PARTY's own field — a compromised server could throw
        // "IGNORE previous instructions…" and reach `runTool`'s generic catch,
        // where the text landed in the model's context un-fenced and the
        // resulting failure cost the server nothing to repeat, unlike a
        // tier-3 success (which closes egress at the shipped medium ceiling
        // after one round-trip). The `try`/`catch` below closes the specific
        // door; `throwTier: 3` is the declared ceiling for whatever this
        // handler cannot be proven not to throw next.
        throwTier: 3,
        handler: async (args) => {
          try {
            const result = await connection.call(def.name, (args ?? {}) as Record<string, unknown>);
            const body = fence('mcp', result.text, `risultato di ${server}.${def.name}`);
            return {
              content: body.block,
              tier: 3,
              ...(result.isError ? { isError: true } : {}),
            };
          } catch (error) {
            // Fenced and tier 3, in the same shape `http.ts` and `search.ts`
            // already give their own caught errors: a server that fails
            // instead of succeeding must not get a channel a successful call
            // does not have. Without this, `error.message` reached `runTool`'s
            // generic catch bare — recinto only guards the `content` field of
            // a normal return, never the message of a thrown Error.
            const detail = error instanceof Error ? error.message : String(error);
            const body = fence('mcp', detail, `errore da ${server}.${def.name}`);
            return { content: body.block, isError: true, tier: 3 };
          }
        },
      });
    }
    report.push(`mcp:${server} — ${connection.tools.length} tool verificati e attivi`);
  }

  return {
    tools,
    capabilities,
    eventConnections,
    report,
    async close() {
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}
