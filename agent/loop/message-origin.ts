import type { ContentBlock, Message, MessageOrigin, Role } from '../providers/types.js';

/**
 * Which messages are lease-local control, and which are durable work evidence.
 *
 * One constructor per provenance, one predicate, one splitter — the whole
 * structural distinction P0-B rests on, generalised by Context P0 from
 * "harness vs everything" to the full internal vocabulary (`MessageOrigin`).
 * `Message.origin` carries it; everything else reads it here rather than
 * re-deriving it from role or content (a user can type the same words as a
 * nudge, so content matching would strip owner words; role matching would
 * strip tool results).
 */

/** Build a message of a given provenance: the only legal way to mark one. */
export function provenanceMessage(role: Role, origin: MessageOrigin, content: ContentBlock[]): Message {
  return { role, content, origin };
}

/** Build a harness control message: the only legal way to write one. */
export function harnessMessage(role: Role, content: ContentBlock[]): Message {
  return provenanceMessage(role, 'harness', content);
}

/** Build the current turn's owner-input message: only owner bytes may enter. */
export function ownerMessage(content: ContentBlock[]): Message {
  return provenanceMessage('user', 'owner', content);
}

/** Build a tool-evidence message: results, refusals, repairs. Wire role stays `user`. */
export function toolMessage(content: ContentBlock[]): Message {
  return provenanceMessage('user', 'tool', content);
}

/**
 * Build an accepted truncation-prefix chunk of the current logical answer
 * (#615): model output interrupted by `max_tokens`, kept as durable work
 * evidence. Always `assistant` — the model really wrote it — and always
 * `partial`, never absent: an absent origin is what replayed session history
 * carries, and the two must never be confused.
 */
export function partialMessage(content: ContentBlock[]): Message {
  return provenanceMessage('assistant', 'partial', content);
}

/**
 * True for an accepted truncation-prefix chunk of the current logical answer,
 * never for replayed history, tool calls, or harness control. The ONLY
 * predicate the truncation path reads: role, absence of `tool_use`, text
 * contents and historical position are all explicitly NOT consulted.
 */
export function isPartialMessage(message: Message): boolean {
  return message.origin === 'partial';
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
