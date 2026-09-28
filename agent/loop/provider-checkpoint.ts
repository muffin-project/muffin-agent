import type { TurnRecord } from '../../core/turns/store.js';
import type { Message } from '../providers/types.js';

/**
 * The only place the loop interprets the opaque payload stored by TurnStore.
 * The current provider contract checkpoints a Message array; a future lease
 * adapter can replace that representation without teaching the durable core
 * the provider's block types.
 */
export function providerMessages(record: TurnRecord | null | undefined): Message[] {
  if (record === null || record === undefined) return [];
  const checkpoint = record.providerLease.checkpoint;
  if (!Array.isArray(checkpoint)) {
    throw new Error(`turn ${record.id} has an invalid provider checkpoint: expected an array`);
  }
  return checkpoint as Message[];
}

/** Provider/harness ownership: TurnStore persists this audit projection but does not inspect message blocks. */
export function harnessMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.origin === 'harness');
}
