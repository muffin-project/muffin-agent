import type { Message } from '../providers/types.js';
import { echoContentFor } from './sensitive-echo.js';

/**
 * Rebuild the sensitive-resource echo protection from durable evidence.
 *
 * `TurnRun.sensitiveResourceEchoes` is RAM-only: whatever a turn read from a
 * secret-flavoured name is collected live so `scrubResourceEchoes` can strip
 * verbatim reproductions from the reply. A crash — or a continuation to a
 * new execution lease — loses the RAM, and a resumed turn that re-reads
 * nothing would then echo credentials it "never saw".
 *
 * The durable transcript already contains the exact pairs the live collector
 * saw: an assistant `tool_use` naming the tool and its arguments, and the
 * user `tool_result` carrying the content. Rehydration replays the single
 * shared predicate (`echoContentFor`, `agent/loop/sensitive-echo.ts`) over
 * those pairs instead of persisting a second plaintext copy of the secrets.
 * Live collection and durable replay cannot drift: there is only one
 * classifier, and `sensitive-echo.test.ts` pins its matrix.
 */

export function rehydrateSensitiveEchoes(messages: readonly Message[]): string[] {
  const uses = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.set(block.id, { name: block.name, args: block.input });
    }
  }
  const echoes: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const call = uses.get(block.toolCallId);
      if (call === undefined) continue;
      const echo = echoContentFor(call.name, call.args, block);
      if (echo !== undefined) echoes.push(echo);
    }
  }
  return echoes;
}
