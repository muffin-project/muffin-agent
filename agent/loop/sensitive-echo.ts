import { isSensitiveResourceName } from '../../core/tracing/redact.js';

/**
 * The single owner of the sensitive-echo classification (P0-B).
 *
 * Two consumers, one predicate: the live collector in `guidaIlTurno`
 * (`agent/loop/engine.ts`, RAM-only) and the deterministic rehydration over
 * durable transcript pairs (`agent/loop/echo-rehydrate.ts`, crash and
 * continuation resumes). If the two ever disagreed about what counts as an
 * echo, a resumed turn would scrub either too much (breaking answers) or too
 * little (leaking secrets) — silently, in exactly the direction nobody
 * watches. So the tool set, the argument lookup, the error skip and the
 * string check live here once, and both call sites delegate without
 * restating any of it.
 *
 * Returns the content to protect, or `undefined` when this call/outcome pair
 * is not a protectable echo.
 */
const RESOURCE_READ_TOOLS: readonly string[] = ['fs_read', 'http_get', 'document_read', 'skill_read'];

export function echoContentFor(
  toolName: string,
  args: unknown,
  outcome: { type: string; isError?: boolean; content?: unknown },
): string | undefined {
  if (!RESOURCE_READ_TOOLS.includes(toolName)) return undefined;
  if (outcome.type !== 'tool_result' || outcome.isError) return undefined;
  if (typeof outcome.content !== 'string') return undefined;
  const parsed = (args ?? {}) as Record<string, unknown>;
  const resourceId =
    typeof parsed.path === 'string' ? parsed.path : typeof parsed.url === 'string' ? parsed.url : undefined;
  if (resourceId === undefined || !isSensitiveResourceName(resourceId)) return undefined;
  return outcome.content;
}
