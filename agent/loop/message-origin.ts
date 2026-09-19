import type { ContentBlock, Message, Role } from '../providers/types.js';

/**
 * Which messages are lease-local control, and which are durable work evidence.
 *
 * One constructor, one predicate, one splitter — the whole structural
 * distinction P0-B rests on. `Message.origin` carries it; everything else
 * reads it here rather than re-deriving it from role or content (a user can
 * type the same words as a nudge, so content matching would strip owner
 * words; role matching would strip tool results).
 */

/** Build a harness control message: the only legal way to write one. */
export function harnessMessage(role: Role, content: ContentBlock[]): Message {
  return { role, content, origin: 'harness' };
}

/** True for loop-written lease control, never for owner/model/tool evidence. */
export function isHarnessMessage(message: Message): boolean {
  return message.origin === 'harness';
}

/**
 * The live transcript for a new execution lease: evidence survives,
 * harness control does not remain behaviorally active.
 *
 * The dropped half is not destroyed — the caller archives it in the
 * per-lease audit (`turn_leases`) before replacing the row's messages.
 */
export function splitWorkEvidence(messages: readonly Message[]): { evidence: Message[]; harness: Message[] } {
  const evidence: Message[] = [];
  const harness: Message[] = [];
  for (const message of messages) {
    (isHarnessMessage(message) ? harness : evidence).push(message);
  }
  return { evidence, harness };
}
