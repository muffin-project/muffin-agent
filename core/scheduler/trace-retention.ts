import { JsonlExporter } from '../tracing/tracer.js';

/**
 * Trace retention on the scheduler's beat (#838).
 *
 * The mechanism is the proven `JsonlExporter.pruneOlderThan` — the exact
 * function `agent/runtime.ts` already calls at boot. The boot call alone
 * never runs in a long-lived process, so this adapter drives it from
 * `Scheduler.tick` instead: the one beat both the gateway (`Gateway.tick`)
 * and the REPL (its own interval) already own.
 *
 * Same shape as the dated-commitment lane (`{ tick(now) }`, nullable): the
 * scheduler holds it, the tick passes its own `now` so the clock stays
 * injectable, and a scheduler built without one behaves exactly as before.
 *
 * Best-effort on purpose: a prune that throws (a file vanishing mid-pass, a
 * home that became unreadable) must never take the tick — and with it the
 * job lane — down. The next beat tries again. This mirrors the boot path's
 * own posture (`tightenHome` is best-effort at `agent/runtime.ts`).
 */
export function makeTraceRetentionTick(
  homeDir: string,
  retentionDays: number,
): { tick(now: Date): void } {
  const exporter = new JsonlExporter(homeDir);
  return {
    tick(now: Date): void {
      try {
        exporter.pruneOlderThan(retentionDays, now);
      } catch {
        /* retention is hygiene, never the thing that fails the tick */
      }
    },
  };
}
