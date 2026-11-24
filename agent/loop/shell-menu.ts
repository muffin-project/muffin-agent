import type { ChatResult, Message, ToolSpec } from '../providers/types.js';
import type { RegisteredTool } from './types.js';

const name = 'shell';
const read = { name: 'shell_run', capability: 'sys.shell', effect: 'read_only' } as const;
const write = {
  name: 'shell_run_write',
  capability: 'sys.shell.write',
  effect: 'write_project',
} as const;

/** Model-interface experiment. The execution registry and both capability gates stay intact. */
export function modelShellMenu(exposed: readonly RegisteredTool[]): ToolSpec[] | undefined {
  const readTool = exposed.find(
    (tool) => tool.spec.name === read.name && tool.capability === read.capability,
  );
  const writeTool = exposed.find(
    (tool) => tool.spec.name === write.name && tool.capability === write.capability,
  );
  if (!readTool || !writeTool || exposed.some((tool) => tool.spec.name === name)) return undefined;

  const schema = readTool.spec.inputSchema;
  return exposed.flatMap((tool) => {
    if (tool === writeTool) return [];
    if (tool !== readTool) return [tool.spec];
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
              enum: [read.effect, write.effect],
              description:
                'write_project creates or changes a project file. read_only prints a result without changing project files.',
            },
          },
          required: ['command', 'description', 'effect'],
        },
      },
    ];
  });
}

/** Resolve the model's declared scope before storing the call or looking up its capability. */
export function canonicalShellCalls(result: ChatResult): ChatResult {
  return {
    ...result,
    toolCalls: result.toolCalls.map((call) => {
      if (call.name !== name || !call.args || typeof call.args !== 'object') return call;
      const { effect, ...args } = call.args as Record<string, unknown>;
      const selected = effect === read.effect ? read : effect === write.effect ? write : undefined;
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
        const selected =
          block.name === read.name ? read : block.name === write.name ? write : undefined;
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
