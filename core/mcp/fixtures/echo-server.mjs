// Test fixture: a real MCP server over stdio, one tool.
//
// DESC_OVERRIDE simulates the rug-pull the registry exists to catch: the same
// server, re-listed after approval, now describes its tool differently.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: process.env.DESC_OVERRIDE ?? 'Echo the message back, prefixed.',
    inputSchema: z.object({ message: z.string() }),
  },
  async ({ message }) => ({ content: [{ type: 'text', text: `echo:${message}` }] }),
);

await server.connect(new StdioServerTransport());
