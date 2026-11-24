import type { ChatResult, Message, ToolSpec } from '../providers/types.js';
import type { RegisteredTool } from './types.js';

const name = 'shell';
const read = { name: 'shell_run', capability: 'sys.shell', effect: 'read_only' } as const;
const write = {
  name: 'shell_run_write',
  capability: 'sys.shell.write',
  effect: 'write_project',
} as const;
type ShellEffect = typeof read | typeof write;
const effects = [read, write] as const;

/** Model-interface experiment. The execution registry and both capability gates stay intact. */
export function modelShellMenu(
  exposed: readonly RegisteredTool[],
  registered: readonly RegisteredTool[],
): { tools: ToolSpec[]; effects: ShellEffect[] } | undefined {
  if (registered.some((tool) => tool.spec.name === name)) return undefined;
  const available = effects.filter((effect) =>
    exposed.some((tool) => tool.spec.name === effect.name && tool.capability === effect.capability),
  );
  const shellTools = exposed.filter((tool) =>
    available.some((effect) => effect.name === tool.spec.name),
  );
  const [first] = shellTools;
  if (first === undefined) return undefined;

  const schema = first.spec.inputSchema;
  const tools = exposed.flatMap((tool) => {
    if (!shellTools.includes(tool)) return [tool.spec];
    if (tool !== first) return [];
    return [
      {
        name,
        description:
          'Run a non-interactive command in the current project. Set effect to write_project whenever the command ' +
          'creates or changes a project file, including shell redirection and a program saving its own output. ' +
          'Set read_only for inspection or a result returned only on stdout. The owner approves the command. ' +
          'Use fs_write for text you already have. Pass a project-relative cwd when needed. Returns exit status, ' +
          'stdout, and stderr. Verify the requested result before reporting success.',
        inputSchema: {
          ...schema,
          properties: {
            ...(schema.properties as Record<string, unknown>),
            effect: {
              type: 'string',
              enum: available.map((effect) => effect.effect),
              description:
                'write_project creates or changes a project file. read_only prints a result without changing project files.',
            },
          },
          required: ['command', 'description', 'effect'],
        },
      },
    ];
  });
  return { tools, effects: available };
}

/** Resolve the model's declared scope before storing the call or looking up its capability. */
export function canonicalShellCalls(
  result: ChatResult,
  available: readonly ShellEffect[],
): ChatResult {
  return {
    ...result,
    toolCalls: result.toolCalls.map((call) => {
      if (call.name !== name || !call.args || typeof call.args !== 'object') return call;
      const { effect, ...args } = call.args as Record<string, unknown>;
      const selected = available.find((candidate) => candidate.effect === effect);
      return selected === undefined ? call : { ...call, name: selected.name, args };
    }),
  };
}

/** The provider sees its own tool interface. The durable transcript keeps the capability name. */
export function modelShellHistory(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool_use' || !block.input || typeof block.input !== 'object')
          return block;
        const selected = effects.find((candidate) => candidate.name === block.name);
        return selected === undefined
          ? block
          : {
              ...block,
              name,
              input: { ...block.input, effect: selected.effect },
            };
      }),
    };
  });
}
