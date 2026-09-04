/**
 * One `sleep`, for the retry and wait loops that used to each write their own.
 *
 * Measured in `docs/evidence/forma-del-repo-2026-09-04.md` §B.2: four
 * undeclared copies (`agent/loop.ts`, `connectors/telegram/connector.ts`,
 * `connectors/discord/api.ts`, `connectors/telegram/api.ts`), two shapes —
 * abortable and not — with no comment saying why. That is unlike
 * `backoffMs()` (§B.3), which *does* carry a reason for staying split; this
 * one had none, so it is unified instead of left alone.
 *
 * The signature is the superset (`signal` optional): a caller that never
 * aborts just omits it and gets the old two-line body back, byte for byte.
 * `connectors/discord/gateway.ts` keeps its own inline default deliberately —
 * that one is a documented DI seam local to a single connector, not this
 * undeclared duplication, and unifying it is a separate decision this slice
 * does not make.
 *
 * `connectors/telegram/connector.ts` still has its own copy too, unlike the
 * other three: that file was being rewritten by a concurrent slice while this
 * one landed, and folding it in here would have collided with work in
 * flight. The finding stands — three of the four are unified, the fourth is
 * deferred, not defended.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
