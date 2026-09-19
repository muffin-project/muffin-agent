import type { SessionRef } from '../../core/session/store.js';

/**
 * Which conversation a turn belongs to — the domain identity behind
 * `ChatCall.conversation`, which the OpenAI-compatible adapter hashes
 * opaquely into OpenRouter's `session_id` for upstream stickiness.
 *
 * Three inequalities are the whole contract:
 *
 * - **principal ≠ conversation**: who is speaking is not what is being
 *   discussed. The principal (`owner`, a group member) lives on the turn
 *   record; the conversation lives here.
 * - **turn ≠ conversation**: a fresh id per turn would pin every request to
 *   a cold upstream — stickiness needs a value that survives across turns
 *   of the same work.
 * - **stable for the conversation, not for a lifetime**: the provider must
 *   see the same value for every turn of one piece of work, and a different
 *   value when the work changes.
 *
 * Today this resolves session-scoped (`session.id`): a room for groups
 * (`telegram:<chat>`, `#thread` suffixed for forum topics), one value for
 * the whole private owner scope (`'owner'`). That last case is the known
 * residual — principal and conversation coincide in VALUE for private owner
 * turns, though never in TYPE (this function, not the principal key, is
 * what the loop passes down). Making them differ in value needs a durable
 * per-conversation generation (bumped on `/new`), which is a schema shape
 * the owner has to approve — see the P0 output's migration contract. When
 * it lands, only this function changes; the loop, the adapters and every
 * test below keep their shape.
 */
export function resolveConversationId(session: SessionRef): string {
  return session.id;
}
