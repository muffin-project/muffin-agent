/**
 * One mechanism for "wait for a connector to genuinely stop, but not forever."
 *
 * Telegram and Discord used to each own a hand-rolled `stop(): void` that only
 * *signalled* — it flipped a flag or closed a socket and returned immediately,
 * with nothing left to await the in-flight request or turn that was still
 * going to touch the database a moment later. This repository has already
 * recorded that shape of defect once (a single mechanism split into two
 * hand-written variants that drift), so the wait itself lives here, once, and
 * both connectors' `stop()` calls through it rather than re-implementing a
 * second bounded wait next to the first.
 */

/**
 * Waits for `settling` up to `budgetMs`, then gives up without throwing.
 *
 * A rejection from `settling` is swallowed here on purpose: the caller is
 * shutting down and a failure in whatever it was waiting on (a turn that threw
 * because the database it was writing to had already closed under it — the
 * exact race this file exists to close) must not become an unhandled
 * rejection that turns a clean "esco comunque" into a crash. The return value
 * is the honest half: `true` only when `settling` actually finished inside the
 * budget, `false` for both a timeout and a rejection — either way, something
 * was still going when the wait gave up.
 */
export async function awaitWithBudget(settling: Promise<unknown>, budgetMs: number): Promise<boolean> {
  if (budgetMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  try {
    const settled = await Promise.race([
      settling.then(
        () => 'done' as const,
        () => 'done' as const, // a rejection still means "no longer in flight" — see doc above
      ),
      timeout,
    ]);
    return settled === 'done';
  } finally {
    clearTimeout(timer!);
  }
}
