import type { SessionRef } from '../../core/session/store.js';

/**
 * Which conversation a turn belongs to — the domain identity behind
 * `ChatCall.conversation`, which the OpenAI-compatible adapter hashes
 * opaquely into OpenRouter's `session_id` for upstream stickiness.
 *
 * Three inequalities are the whole contract, and all three now hold in VALUE:
 *
 * - **principal ≠ session ≠ conversation ≠ turn.** The principal (`owner`,
 *   a group member) lives on the turn record; the session (`owner` for the
 *   whole private owner scope, `telegram:<chat>` per room) is the durable
 *   transcript key; the conversation is the session PLUS its generation
 *   (`owner#g0`, `owner#g1`, …), bumped on every accepted `/new`; the turn
 *   is a fresh id per turn.
 * - **turn ≠ conversation**: a fresh id per turn would pin every request to
 *   a cold upstream — stickiness needs a value that survives across turns
 *   of the same work.
 * - **stable for the conversation, not for a lifetime**: the provider sees
 *   the same value for every turn of one conversation, and a different value
 *   after `/new`.
 *
 * Filesystem-free on purpose: the generation arrives already resolved on the
 * `SessionRef` (read by `SessionStore.open()`, bumped by
 * `SessionStore.newConversation()`). This function only renders it. A ref
 * without a generation — every literal `{id, file}` built before the field
 * existed — reads as generation 0, the legacy default.
 */
export function resolveConversationId(session: SessionRef): string {
  return `${session.id}#g${session.generation ?? 0}`;
}
