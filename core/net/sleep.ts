/**
 * One `sleep`, for the retry and wait loops that used to each write their own.
 *
 * Measured in `docs/evidence/forma-del-repo-2026-09-04.md` §B.2: four
 * undeclared copies (`agent/loop.ts` — today `agent/loop/round.ts` —
 * `connectors/telegram/connector.ts`, `connectors/discord/api.ts`,
 * `connectors/telegram/api.ts`), two shapes — abortable and not — with no
 * comment saying why. That is unlike `backoffMs()` (§B.3), which *does* carry a
 * reason for staying split; this one had none, so it is unified instead of left
 * alone.
 *
 * The signature is the superset (`signal` optional): a caller that never
 * aborts just omits it and gets the old two-line body back, byte for byte.
 * `connectors/discord/gateway.ts` keeps its own inline default deliberately —
 * that one is a documented DI seam local to a single connector, not this
 * undeclared duplication, and unifying it is a separate decision this slice
 * does not make.
 *
 * `connectors/telegram/connector.ts` was the last copy still declared locally:
 * that file was being rewritten by a concurrent slice when the other three
 * landed, so folding it in then would have collided with work in flight. That
 * slice has since merged; the fourth is folded now. Its DI seam stays — a test
 * still injects its own — but the default it falls back to is this function,
 * not a private copy. All four §B.2 measured are one.
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
