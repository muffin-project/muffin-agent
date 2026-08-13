import { spawnSync } from 'node:child_process';

/**
 * `sd_notify`, the half of supervision that answers "is it *healthy*".
 *
 * ADR-0035's research section is the spec: systemd/launchd answer "who restarts
 * it"; they do not answer "is it serving". `Type=notify` splits *started* from
 * *serving* (`READY=1`), and the periodic `WATCHDOG=1` is **the only thing that
 * catches a process that is up but wedged** — the failure `Restart=always`
 * cannot see, and the one this repo has been paying.
 *
 * Three rules this file exists to keep:
 *
 *  1. **No supervisor, no problem.** `NOTIFY_SOCKET` absent means every call
 *     here is a no-op. Verbatim from the ADR: *"a missing socket must never
 *     prevent the gateway from starting"* — and the owner's dev machine is
 *     macOS, where it is always absent.
 *  2. **Nothing Linux-only is imported.** `node:child_process` is portable; the
 *     Linux-specific part is a program name that is only ever looked up when
 *     systemd itself set the variable that names its socket.
 *  3. **A transport failure is loud but not fatal.** Losing the ping means
 *     systemd kills a healthy process every `WatchdogSec`, which presents as a
 *     crash loop with no cause. So the error is kept and surfaced, and the
 *     gateway still starts.
 *
 * ## Why the transport is a subprocess
 *
 * The wire protocol is a datagram on an `AF_UNIX` **`SOCK_DGRAM`** socket
 * (`sd_notify(3)`; `@`-prefixed paths are the Linux abstract namespace).
 * **Node cannot open one**: `dgram.createSocket` accepts `udp4`/`udp6` only —
 * measured on Node 22.22, `ERR_SOCKET_BAD_TYPE: Bad socket type specified.
 * Valid types are: udp4, udp6` — and `node:net` is stream-only. The choices
 * were a native dependency for one platform, or the tool systemd ships for
 * exactly this. `systemd-notify(1)` it is, with the consequence written down
 * rather than discovered: because the message then comes from a child rather
 * than the main pid, the unit needs `NotifyAccess=all` — *"it is essential to
 * set NotifyAccess=all in the service unit file, or otherwise the notification
 * will be ignored for security reasons"*. `unit.ts` sets it and says why.
 *
 * That widening is real and worth naming: with `NotifyAccess=all`, any process
 * in the service's cgroup can ping the watchdog, so a stuck gateway with a
 * lively child is a hole the watchdog no longer covers. Accepted for now
 * (single owner, and our children are MCP servers and sandboxes); the way out
 * is a sender that can write the datagram from the main pid, which is a
 * dependency decision and not this slice's.
 *
 * `spawnSync` rather than `spawn`, deliberately: it costs a few milliseconds
 * twice a minute and buys the ENOENT synchronously. Fire-and-forget would make
 * "the transport is missing" invisible, which is the one outcome this file is
 * written to prevent.
 */

/**
 * Ping at half the declared interval. Pinging at the full one races the
 * deadline: a single slow tick and the supervisor kills a healthy process.
 * Half is what the sd_notify documentation's own examples use.
 */
export const WATCHDOG_FRACTION = 0.5;

/** Sends one datagram payload. Injected so the protocol is testable off Linux. */
export type NotifySink = (payload: string) => void;

export type Notifier = {
  /** True when a supervisor is listening. False makes every method a no-op. */
  readonly supervised: boolean;
  /** How often to call `watchdog()`, or null when nobody asked for it. */
  readonly watchdogIntervalMs: number | null;
  /** Startup is finished and the gateway is actually serving. */
  ready(status?: string): void;
  /**
   * The periodic "I am alive", carrying what it is doing.
   *
   * The status rides the ping rather than having a method of its own, and that
   * is the whole reason `systemctl status` stops showing the boot-time line
   * forever. There *was* a `status(text)` method here: written, tested twice,
   * and called by nothing — the repo's signature defect, in the file whose job
   * is to be reached. Sending it separately would also have cost a second
   * `systemd-notify` spawn every thirty seconds for a string the ping was
   * already going to carry.
   *
   * The wire format permits it, checked in the documentation rather than
   * assumed: *"The state parameter should contain a newline-separated list of
   * variable assignments"*, and `sd_notify(3)`'s own Example 2 sends
   * `READY=1\nSTATUS=Processing requests...\nMAINPID=%lu` in one call.
   * `systemd-notify(1)` takes `[VARIABLE=VALUE...]` and sends them as one
   * status update. Both read 2026-08-13 from man7.org.
   */
  watchdog(status?: string): void;
  /** Shutdown has begun — so a drain is not mistaken for a hang. */
  stopping(status?: string): void;
  /** The last transport failure, for a boot line. Null while it is working. */
  problem(): string | null;
};

/**
 * A status is a single UTF-8 line. Newlines are not cosmetic here: the payload
 * is a newline-separated list of `KEY=value`, so a newline inside the text
 * *is* a second assignment, and the status is the one field carrying text that
 * came from a job goal.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export function createNotifier(
  env: NodeJS.ProcessEnv = process.env,
  sink: NotifySink = systemdNotifySink,
): Notifier {
  const supervised = (env['NOTIFY_SOCKET'] ?? '') !== '';

  // WATCHDOG_PID exists so an inherited environment does not turn every child
  // into a second pinger. Absent means "the process that got this env" — us.
  const usec = Number(env['WATCHDOG_USEC']);
  const forPid = env['WATCHDOG_PID'];
  const mine = forPid === undefined || forPid === String(process.pid);
  const watchdogIntervalMs =
    supervised && mine && Number.isFinite(usec) && usec > 0 ? (usec / 1000) * WATCHDOG_FRACTION : null;

  let failure: string | null = null;
  const send = (payload: string): void => {
    if (!supervised) return;
    try {
      sink(payload);
      failure = null;
    } catch (error) {
      // Kept, never thrown: see rule 3 above. The gateway starting without
      // supervision is recoverable; the gateway not starting is not.
      failure = error instanceof Error ? error.message : String(error);
    }
  };

  return {
    supervised,
    watchdogIntervalMs,
    ready: (status) => send(status === undefined ? 'READY=1' : `READY=1\nSTATUS=${oneLine(status)}`),
    watchdog: (status) => send(status === undefined ? 'WATCHDOG=1' : `WATCHDOG=1\nSTATUS=${oneLine(status)}`),
    stopping: (status) => send(status === undefined ? 'STOPPING=1' : `STOPPING=1\nSTATUS=${oneLine(status)}`),
    problem: () => failure,
  };
}

/**
 * The production transport. Only ever reached when systemd set NOTIFY_SOCKET,
 * so the lookup of a Linux-only binary never happens on the dev machine.
 * Throws on ENOENT or a non-zero exit so `createNotifier` can report it.
 */
export const systemdNotifySink: NotifySink = (payload) => {
  const result = spawnSync('systemd-notify', payload.split('\n'), { stdio: 'ignore' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemd-notify è uscito con ${result.status}`);
};
