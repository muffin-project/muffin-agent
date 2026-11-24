import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../providers/types.js';
import { canonicalShellCalls, modelShellHistory, modelShellMenu } from './shell-menu.js';
import type { RegisteredTool } from './types.js';

const tool = (name: string, capability: string): RegisteredTool => ({
  spec: { name, description: '', inputSchema: { type: 'object', properties: {} } },
  capability,
  throwTier: 0,
  handler: () => ({ content: '', tier: 0 }),
});
const read = tool('shell_run', 'sys.shell');
const write = tool('shell_run_write', 'sys.shell.write');
const shellCall = (args: unknown): ChatResult => ({
  model: 'fixture',
  text: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: 'tool_use',
  toolCalls: [{ id: 'command-id', name: 'shell', args }],
});

describe('single shell menu', () => {
  it('uses the declared scope before the existing capability lookup and preserves the call ID', () => {
    const menu = modelShellMenu([read, write], [read, write]);
    expect(menu?.tools.map((entry) => entry.name)).toEqual(['shell']);
    expect(menu?.effects.map((entry) => entry.effect)).toEqual(['read_only', 'write_project']);
    for (const effect of menu?.effects ?? []) {
      const call = shellCall({ effect: effect.effect, command: 'printf 42', cwd: '.' });
      expect(canonicalShellCalls(call, menu?.effects ?? []).toolCalls).toEqual([
        { id: 'command-id', name: effect.name, args: { command: 'printf 42', cwd: '.' } },
      ]);
    }
  });

  it('keeps an unavailable or invalid scope out of the native shell execution path', () => {
    const menu = modelShellMenu([read], [read, write]);
    expect(menu?.effects.map((entry) => entry.effect)).toEqual(['read_only']);
    for (const effect of ['write_project', 'unsupported', undefined]) {
      const call = shellCall({ effect, command: 'printf 42' });
      expect(canonicalShellCalls(call, menu?.effects ?? []).toolCalls).toEqual(call.toolCalls);
    }
  });

  it('does not claim a name used by another registered tool', () => {
    expect(
      modelShellMenu([read, write], [read, write, tool('shell', 'plugin.effect')]),
    ).toBeUndefined();
  });

  it('restores the provider-facing name without mutating the durable invocation', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'command-id',
      name: 'shell_run_write',
      input: { command: 'printf 42' },
    };
    expect(modelShellHistory([{ role: 'assistant', content: [block] }])[0]?.content).toEqual([
      { ...block, name: 'shell', input: { command: 'printf 42', effect: 'write_project' } },
    ]);
    expect(block.name).toBe('shell_run_write');
    expect(block.input).toEqual({ command: 'printf 42' });
  });
});
