import type Database from 'better-sqlite3';
import { DurableLock, heldBy, pidAlive, type LockOutcome } from '../lock/durable.js';

/**
 * Who owns the scheduler.
 *
 * ADR-0035 moves the ticker out of the REPL and into a process that lives. The
 * moment that is true there are two things that *could* tick, and two tickers
 * on one job store means a job runs twice — the shape of Hermes #25517 that
 * ADR-0022's corollary told us to design out rather than discover.
 *
 * So the gateway takes a durable claim, and the REPL reads it. The mechanism is
 * the send lock's, generalised into `core/lock/durable.ts` instead of copied
 * (see that file for the argument, and sendlock.ts for why the claim has this
 * shape at all). One thing had to change, and it is the interesting one:
 *
 * **The horizon is a heartbeat, not a duration.** A proactive send is a single
 * model call, so the send lock can say "older than an hour means gone". A
 * gateway holds its lock for weeks; silence proves nothing about it. Instead it
 * refreshes `taken_at` on every tick, and a claim that has missed ten beats is
 * stale. That keeps both halves: a live gateway is never taken over, and one
 * that was `kill -9`d never wedges `muffin` — which is the requirement the send
 * lock's own docstring pins down and which a bare pid check cannot meet,
 * because pids are reused within hours.
 *
 * Two extra columns beyond the claim, because "visibile e ammazzabile" is
 * constraint 5 of the ADR and needs data: `since` (when this holder started,
 * which is uptime and must not move on a beat) and `status` (what it is doing,
 * for `muffin gateway status` and `doctor`).
 */

/** Written on every tick, so the horizon below is about missed beats. */
export const HEARTBEAT_MS = 30_000;

/**
 * Ten missed beats. Long enough that an overloaded machine never trips it,
 * short enough that a REPL opened after a crash starts ticking within minutes
 * rather than after an hour of nothing being scheduled.
 */
export const STALE_AFTER_MS = 10 * HEARTBEAT_MS;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_lock (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  pid       INTEGER,
  taken_at  TEXT,
  since     TEXT,
  status    TEXT,
  holder_id TEXT
);
`;

/** What a live gateway is doing, as everything outside the process can see it. */
export type GatewayInfo = {
  pid: number;
  /** When this holder started serving — uptime, not the last heartbeat. */
  since: Date;
  status: string;
  lastBeat: Date;
};

type Row = { pid: number | null; takenAt: string | null; since: string | null; status: string | null };

export class GatewayLock {
  private readonly lock: DurableLock;
  private readonly claimInfo: Database.Statement;
  private readonly beatInfo: Database.Statement;

  constructor(
    db: Database.Database,
    /** Injected so a test can exercise dead, live and not-ours holders. */
    alive: (pid: number) => boolean = pidAlive,
  ) {
    this.lock = new DurableLock(
      db,
      {
        table: 'gateway_lock',
        schema: SCHEMA,
        staleAfterMs: STALE_AFTER_MS,
        refusal: (holder) => ({
          held: `un gateway è già attivo (pid ${holder})`,
          // The pid is in the message because both remedies need it.
          remedy: 'fermalo con `muffin gateway stop`, oppure lascia lavorare quello',
        }),
      },
      alive,
    );
    // `since` is set only here: a heartbeat that touched it would reset uptime
    // every thirty seconds, and `doctor` would report a process that has been
    // up for a week as thirty seconds old, forever.
    this.claimInfo = db.prepare(`UPDATE gateway_lock SET since = @at, status = @status WHERE id = 1`);
    this.beatInfo = db.prepare(`UPDATE gateway_lock SET status = @status WHERE id = 1`);
  }

  /** Claim it for this process, or name the gateway that has it. */
  claim(now: Date, status: string, pid: number = process.pid): LockOutcome {
    // The status write runs inside the claim's transaction (see DurableLock):
    // outside it, a reader would see the new holder wearing the dead one's
    // status line.
    return this.lock.acquire(now, pid, () => this.claimInfo.run({ at: now.toISOString(), status }));
  }

  /**
   * One beat: push the horizon out and say what it is doing. False means this
   * process is no longer the holder — a cue to stop, not an error to swallow,
   * because the only way it happens is that something took the lock over.
   */
  beat(now: Date, status: string, pid: number = process.pid): boolean {
    return this.lock.refresh(now, pid, () => this.beatInfo.run({ status }));
  }

  release(pid: number = process.pid): void {
    this.lock.release(pid);
  }

  /**
   * Am I, right now, still the process the row's claim names — not merely a
   * live pid, but the exact acquisition `claim` won.
   *
   * P20's fix: `Gateway.tick` used to check `beat()` once and then run
   * `scheduler.tick()`/`turnLane.tick()` with no re-check inside, so a single
   * overlong tick could still be delivering when a second gateway claimed the
   * lock underneath it. `Scheduler`/`TurnLane` take this as `stillOwner` (wired
   * in `cli/gateway.ts`) and re-ask it right before the model call and again
   * right before delivery — the same points `ModelLane.take` already gates —
   * so a takeover mid-tick is caught before its next effect rather than only
   * discovered, after the fact, on the next `beat()`.
   */
  isCurrentClaim(pid: number = process.pid): boolean {
    return this.lock.isCurrentHolder(pid);
  }
}

/**
 * The gateway as every inspection path sees it — the REPL deciding whether to
 * start a ticker, `muffin gateway status`, `muffin gateway stop`, `doctor`.
 *
 * A free function and not a method for one concrete reason: `doctor` opens the
 * database **readonly**, and a constructor that runs `CREATE TABLE IF NOT
 * EXISTS` would throw there. So this creates nothing and treats a missing table
 * as "no gateway", which is also the honest answer on a home that has only ever
 * run the REPL.
 *
 * The liveness judgement is `heldBy`, the same one the claim uses. Two rules
 * would disagree exactly around a crash: `doctor` reporting a gateway while
 * `gateway run` quietly takes its lock.
 */
export function readGateway(
  db: Database.Database,
  now: Date = new Date(),
  alive: (pid: number) => boolean = pidAlive,
): GatewayInfo | null {
  let row: Row | undefined;
  try {
    row = db
      .prepare(`SELECT pid, taken_at AS takenAt, since, status FROM gateway_lock WHERE id = 1`)
      .get() as Row | undefined;
  } catch {
    // No such table: nothing has ever claimed it here.
    return null;
  }
  const pid = heldBy(row, now.getTime(), STALE_AFTER_MS, alive);
  if (pid === null || !row) return null;
  return {
    pid,
    since: new Date(row.since ?? row.takenAt ?? now.toISOString()),
    status: row.status ?? 'sconosciuto',
    lastBeat: new Date(row.takenAt ?? now.toISOString()),
  };
}

/**
 * «Chi serve, adesso?» — chiesto a ogni giro, detto una volta per cambio.
 *
 * Estratto il 03/09/2026 da `gatewayStandDown` (`cli/repl.ts`) quando è
 * servito un secondo consumatore della stessa domanda: le **superfici**. Fino a
 * quel giorno il REPL cedeva allo scheduler e non cedeva le superfici, quindi
 * con un gateway sotto supervisore due processi chiamavano `getUpdates` sullo
 * stesso token e Telegram rispondeva 409 al perdente — che lo scriveva a
 * timer, per sempre, sull'installazione dell'owner.
 *
 * Un solo posto risponde, perché due risposte divergono: il gateway «vivo» del
 * lucchetto (heartbeat + `STALE_AFTER_MS`, che copre il coperchio del portatile
 * e il `kill -9`) e un qualsiasi secondo criterio inventato accanto sarebbero
 * d'accordo ovunque tranne che intorno a un crash, cioè esattamente dove conta.
 *
 * Annuncia sulla **transizione** e non sullo stato: la riga di avvio resta
 * l'unica cosa detta all'avvio (`servingAtBoot` è ciò che quella riga ha già
 * riportato) e una condizione che dura non produce una riga al secondo. In
 * entrambe le direzioni, perché un gateway che muore e un processo che
 * riprende in silenzio sono lo stesso difetto con il cappello scambiato.
 */
export function gatewayTransition(
  db: Database.Database,
  say: (line: string) => void,
  servingAtBoot: boolean,
  words: { taken: (pid: number) => string; released: () => string },
): () => GatewayInfo | null {
  let serving = servingAtBoot;
  return () => {
    const gateway = readGateway(db);
    const now = gateway !== null;
    if (now !== serving) {
      serving = now;
      say(gateway ? words.taken(gateway.pid) : words.released());
    }
    return gateway;
  };
}
