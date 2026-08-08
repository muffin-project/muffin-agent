import { Client } from '@modelcontextprotocol/client';
// Node-only transport lives behind a subpath in 2.0.0 stable (the root entry
// is runtime-agnostic) — probed on the installed package, the alpha-era docs
// still show it on the root export.
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerEntry, McpToolDef } from './registry.js';

/**
 * One connection per allowlisted server, over stdio.
 *
 * The transport spawns the server as a child process with the SDK's own env
 * safelist (PATH, HOME, SHELL, …) plus whatever the registry entry names
 * explicitly — verified against the v2 source: the host environment, API key
 * included, does not cross by default. Remote (HTTP) servers are out of v1
 * scope: a local stdio process is auditable and has no session to hijack.
 */

export type McpConnection = {
  tools: McpToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
};

export async function connectServer(server: string, entry: McpServerEntry): Promise<McpConnection> {
  const client = new Client({ name: 'muffin', version: '0.2.0' });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env },
    // The server's stderr is diagnostics, not conversation: keep it out of the
    // parent's inherited stderr so a chatty server cannot scribble on the REPL.
    stderr: 'pipe',
  });
  await client.connect(transport);

  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const t of page.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  return {
    tools,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const parts = Array.isArray(result.content) ? result.content : [];
      const text = parts
        .map((part: { type?: string; text?: string }) =>
          part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type ?? 'unknown'} content]`,
        )
        .join('\n');
      return { text, isError: result.isError === true };
    },
    async close() {
      await client.close();
    },
  };
}
