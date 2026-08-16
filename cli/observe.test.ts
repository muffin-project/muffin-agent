import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, paths, saveConfig, type Config } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
import { FireLog } from '../core/scheduler/firelog.js';
import { SendLock } from '../core/scheduler/sendlock.js';
import type { LoopDeps } from '../agent/loop.js';
import type { ChatResult, Provider } from '../agent/providers/types.js';
import { seal } from '../core/rot/verify.js';
import { runInit } from './init.js';
import { DELIVERED, notDelivered } from '../core/surface/types.js';
import { cmdObserve } from './observe.js';

/**
 * `muffin observe`, end to end on a real home.
 *
 * The point is the path, not the arithmetic: a home that has never run
 * `observe` has no fires table, so if the schema were declared and never
 * executed — the defect this slice was sent to fix — the first command would
 * die on "no such table" instead of quietly doing nothing. And the default
 * command must reach the gate while touching neither the model nor a channel:
 * that is the whole reason it exists before `--send` does.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-05T11:00:00Z'); // midday in Europe/Rome, outside quiet hours
const at = (days: number): string => new Date(T0 + days * DAY).toISOString();
const NOW = new Date(T0 + 120 * DAY);
/**
 * 03:00 in Europe/Rome, and 01:00 UTC — inside the owner's quiet window and
 * inside the fallback's, so a test can say "at 3am" without depending on which
 * of the two was read.
 */
const NIGHT = new Date('2026-05-06T01:00:00Z');

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: string[]) {}
  async chat(): Promise<ChatResult> {
    return {
      text: this.script[this.i++] ?? 'fine',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 't',
    };
  }
}

/** A home whose memory holds one entity mentioned three times, then silent. */
function homeWithSilence(name = 'la tesi'): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-observe-cli-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  for (const day of [0, 10, 20]) {
    const when = at(day);
    const entityId = store.upsertEntity('host', name, 'thing', when);
    const episodeId = store.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 't1',
      role: 'user',
      kind: 'message',
      content: `qualcosa su ${name}`,
      trustTier: 0,
      createdAt: when,
    });
    store.addFact({
      tenantId: 'host',
      subjectId: entityId,
      predicate: 'menzionato',
      objectValue: 'x',
      episodeId,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: when,
    });
  }
  db.close();
  return home;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

function firedAnchors(home: string): string[] {
  const db = new DatabaseCtor(paths(home).db);
  try {
    new FireLog(db); // ensures the table exists even if nothing ever wrote
    return (db.prepare(`SELECT anchor FROM proactive_fires`).all() as { anchor: string }[]).map((r) => r.anchor);
  } finally {
    db.close();
  }
}

/** The quiet-hours rail, where the owner is invited to hand-edit it. */
const budgetsFile = (home: string): string => join(paths(home).rot, 'budgets.json');

function patchConfig(home: string, patch: (c: Config) => Config): void {
  saveConfig(patch(loadConfig(home)), home);
}

/** Edits the sealed file and reseals, the way an owner legitimately would. */
function patchBudgets(home: string, patch: (b: Record<string, unknown>) => Record<string, unknown>): void {
  const file = budgetsFile(home);
  writeFileSync(file, `${JSON.stringify(patch(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`);
  seal(home, '1', new Date());
}

/**
 * A stage 2 that cannot reach the network. Every test below asserts that
 * something was *not* delivered: without a scripted provider the failure mode
 * of a broken gate would be a call to the real API, which is slow, costs money
 * and hides the assertion behind a timeout.
 */
function scriptedRuntime(home: string, script: string[]): { deps: LoopDeps; close: () => void } {
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
  return { deps: { ...runtime.deps, provider: new Scripted(script) }, close: runtime.close };
}

/** Puts `pid` in the send lock, as a run of that pid would have. */
function holdLock(home: string, pid: number): void {
  const db = new DatabaseCtor(paths(home).db);
  try {
    new SendLock(db).acquire(NOW, pid);
  } finally {
    db.close();
  }
}

/** What Muffin is on record as having said — agent-side episodes only. */
function agentEpisodes(home: string): string[] {
  const db = new DatabaseCtor(paths(home).db);
  try {
    return (
      db.prepare(`SELECT content FROM episodes WHERE role = 'agent'`).all() as { content: string }[]
    ).map((r) => r.content);
  } finally {
    db.close();
  }
}

/** Who holds it now, straight from the row — never inferred from behaviour. */
function lockHolder(home: string): number | null {
  const db = new DatabaseCtor(paths(home).db);
  try {
    return new SendLock(db).holder();
  } finally {
    db.close();
  }
}

/** A pid that is really gone — a stale lock the test only *believes* is stale proves nothing. */
function deadPid(): number {
  const { pid } = spawnSync('/bin/sh', ['-c', 'exit 0']);
  expect(typeof pid).toBe('number');
  expect(() => process.kill(pid as number, 0)).toThrow();
  return pid as number;
}

describe('muffin observe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects the silence, shows the gate decision and the numbers, and speaks to nobody', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const delivered: string[] = [];

    // No `deps`: if this path touched the model it could not even build a turn.
    const code = await cmdObserve(home, [], { now: NOW, deliver: async (_c, t) => (delivered.push(t), DELIVERED) });

    const text = out.join('');
    expect(code).toBe(0);
    expect(text).toContain('la tesi');
    expect(text).toContain('3 occasioni');
    expect(text).toContain('100'); // giorni di silenzio
    expect(text).toMatch(/p 0\.0/);
    expect(delivered).toEqual([]);
    // Nothing is burned by looking: the anchor is still available to fire.
    expect(firedAnchors(home)).toEqual([]);
  });

  it('--send composes through the loop, delivers once, and records the anchor', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const delivered: string[] = [];
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: { ...runtime.deps, provider: new Scripted(['da quanto non tocchi la tesi?']) },
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(code).toBe(0);
      expect(delivered).toEqual(['da quanto non tocchi la tesi?']);
      expect(firedAnchors(home)).toHaveLength(1);
      expect(out.join('')).toContain('inviato');
    } finally {
      runtime.close();
    }
  });

  it('the second run skips the anchor it already fired — the old repetition, structurally', async () => {
    const home = homeWithSilence();
    capture();
    const delivered: string[] = [];
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const send = async () =>
        cmdObserve(home, ['--send'], {
          now: NOW,
          deps: { ...runtime.deps, provider: new Scripted(['primo', 'secondo']) },
          deliver: async (_c, t) => (delivered.push(t), DELIVERED),
        });
      await send();
      await send();
      expect(delivered).toEqual(['primo']);
      expect(firedAnchors(home)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it('a delivery that fails leaves the anchor open, and the exit code says so', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: { ...runtime.deps, provider: new Scripted(['da quanto non tocchi la tesi?']) },
        deliver: async () => {
          throw new Error('canale giù');
        },
      });
      expect(code).toBe(1);
      // Recording before the message is out would silence this entity forever
      // on the strength of one bad run.
      expect(firedAnchors(home)).toEqual([]);
      expect(out.join('')).toContain('non inviato');
    } finally {
      runtime.close();
    }
  });

  it('an empty memory is not an error, and says so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-observe-empty-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const { out, err } = capture();

    expect(await cmdObserve(home, [], { now: NOW })).toBe(0);
    expect(`${out.join('')}${err.join('')}`).toContain('nessun silenzio');
  });
});

/**
 * The gate's verdict, obeyed at the boundary.
 *
 * Every test above runs at midday, under budget, tier 0 — so `allow` was the
 * only branch production ever exercised, and the one line that filters on it
 * (`sendAllowed`) could be widened to let a `defer` through with the suite
 * still green. These are the other branches, from the same entry point.
 */
describe('muffin observe · the gate rules, and delivery obeys', () => {
  afterEach(() => vi.restoreAllMocks());

  it('at 03:00 it defers: nothing delivered, no anchor burned, and it says so', async () => {
    const home = homeWithSilence();
    const rt = scriptedRuntime(home, ['non doveva uscire']);
    const { out } = capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NIGHT,
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(delivered).toEqual([]);
      // A defer that burns the anchor is a permanent silence about that entity.
      expect(firedAnchors(home)).toEqual([]);
      expect(out.join('')).toContain('rimandato');
      expect(out.join('')).toContain('(quiet_hours)');
      expect(code).toBe(0);
    } finally {
      rt.close();
    }
  });

  it('over budget it defers, and --send delivers nothing all the same', async () => {
    const home = homeWithSilence();
    // The runtime is built before the cap drops to zero, and that order is the
    // substance of the test: `runTurn` has a budget check of its own, so with a
    // stage 2 that is also exhausted no message would go out even if this gate
    // did not exist — the test would pass for the wrong reason. With a stage 2
    // able to compose, the only thing holding the message in is the gate.
    const rt = scriptedRuntime(home, ['non doveva uscire']);
    // The real mechanism, not a stub: zero is a legitimate cap meaning stop
    // (`core/rot/budgets.ts`), so `BudgetEngine.exhausted()` answers yes without
    // the test having to fabricate spend. Dropped in the *sealed* file and
    // resealed — since ADR-0039 that is the only file the cap comes from, and a
    // patch of `config.json` here would now change nothing at all.
    patchBudgets(home, (b) => ({ ...b, monthlyUsd: 0 }));
    const { out } = capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW, // midday: the only reason to stay quiet is the budget
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(delivered).toEqual([]);
      expect(firedAnchors(home)).toEqual([]);
      expect(out.join('')).toContain('rimandato');
      expect(out.join('')).toContain('(budget)');
      expect(code).toBe(0);
    } finally {
      rt.close();
    }
  });

  it('delivers on the configured surface, not on one written here by hand', async () => {
    const home = homeWithSilence();
    patchConfig(home, (c) => ({ ...c, surfaces: { ...c.surfaces, default: 'telegram', enabled: ['cli', 'telegram'] } }));
    const rt = scriptedRuntime(home, ['da quanto non tocchi la tesi?']);
    const { out } = capture();
    const channels: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: rt.deps,
        deliver: async (c) => (channels.push(c), DELIVERED),
      });
      expect(code).toBe(0);
      expect(channels).toEqual(['telegram']);
      expect(out.join('')).toContain('canale telegram');
    } finally {
      rt.close();
    }
  });
});

describe('muffin observe --send · delivery that did not happen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an unwired channel does not burn the anchor for a message nobody got', async () => {
    // No `deliver` injected — every other test in this file passes one, which is
    // why the real `printDeliver` was reached by nothing and could return
    // normally after writing "consegna remota da cablare" to stderr. The caller
    // then recorded the fire, and the anchor carries `lastSeen`, which does not
    // move while the entity stays silent: that occasion was spent forever on a
    // message that never left the machine.
    const home = homeWithSilence();
    patchConfig(home, (c) => ({ ...c, surfaces: { ...c.surfaces, default: 'telegram' } }));
    const rt = scriptedRuntime(home, ['da quanto non tocchi la tesi?']);
    const { out, err } = capture();
    try {
      const code = await cmdObserve(home, ['--send'], { now: NOW, deps: rt.deps });

      expect(code).toBe(1);
      expect(firedAnchors(home)).toEqual([]);
      // The text still reaches the screen: losing the message would be worse
      // than the bug being fixed.
      expect(err.join('')).toContain('da quanto non tocchi la tesi?');
      // And the run says which one did not go out, next to its evidence.
      expect(out.join('')).toContain('non inviato');
      // Nothing in memory either. Composing is not saying: an episode written at
      // compose time would claim Muffin said this, once per failed run, and
      // recall would later ground an answer on a nudge nobody received.
      expect(agentEpisodes(home)).toEqual([]);
    } finally {
      rt.close();
    }
  });

  it('delivers on the cli channel, where delivery is real', async () => {
    // The other half: the throw must be about the channel being unwired, not a
    // blanket refusal that would make `--send` useless everywhere.
    const home = homeWithSilence();
    const rt = scriptedRuntime(home, ['da quanto non tocchi la tesi?']);
    const { out } = capture();
    try {
      const code = await cmdObserve(home, ['--send'], { now: NOW, deps: rt.deps });

      expect(code).toBe(0);
      expect(out.join('')).toContain('da quanto non tocchi la tesi?');
      expect(firedAnchors(home)).toHaveLength(1);
      // Delivered, so it is written down — the same rule, the other direction.
      expect(agentEpisodes(home)).toEqual(['da quanto non tocchi la tesi?']);
    } finally {
      rt.close();
    }
  });
});

/**
 * Where the quiet hours come from, and what stands in when they are unreadable.
 *
 * `budgets.json` is inside the seal and the owner is explicitly invited to edit
 * it, so both halves need proving: that a valid window is *read* (and not a
 * constant that happens to look like it), and that the fallback is a real
 * window rather than a value that is merely present.
 */
describe('muffin observe · quiet hours come from the RoT', () => {
  afterEach(() => vi.restoreAllMocks());

  const broken: [string, (home: string) => void, string][] = [
    ['missing', (home) => rmSync(budgetsFile(home)), 'assente'],
    // The two arms are separate rows on purpose. A single `{from:'11pm',
    // to:'8am'}` fixture fails on *either* regex, so dropping one of them alone
    // left the suite green — and it is `from` that carries the claim the
    // docstring makes: no crash, just `inQuietHours` answering false at 23:30
    // Rome where "23:00" answers true. The night quietly opening was the one
    // case nothing held.
    [
      'with an invalid quiet-hours start',
      (home) =>
        // The owner's hand, not a random byte: "11pm" is how a time gets written
        // when nobody said the format is HH:MM.
        // `schemaVersion` stays: the loader checks the version before the shape,
        // and an owner fixing a time by hand does not delete the version line.
        // Without it this row would exercise the version gate instead of the
        // regex, which is a different claim.
        writeFileSync(
          budgetsFile(home),
          JSON.stringify({
            schemaVersion: 1,
            monthlyUsd: 80,
            perTenantDailyUsd: 2,
            quietHours: { from: '11pm', to: '08:00', timezone: 'Europe/Rome' },
          }),
        ),
      'quietHours non valide',
    ],
    [
      'with an invalid quiet-hours end',
      (home) =>
        writeFileSync(
          budgetsFile(home),
          JSON.stringify({
            schemaVersion: 1,
            monthlyUsd: 80,
            perTenantDailyUsd: 2,
            quietHours: { from: '23:00', to: '8am', timezone: 'Europe/Rome' },
          }),
        ),
      'quietHours non valide',
    ],
    ['unreadable', (home) => writeFileSync(budgetsFile(home), '{ "quietHours": '), 'illeggibile'],
  ];

  it.each(broken)('budgets.json %s → the fallback, noted, and 03:00 still stays quiet', async (_case, breakIt, note) => {
    const home = homeWithSilence();
    breakIt(home);
    const rt = scriptedRuntime(home, ['non doveva uscire']);
    const { out, err } = capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NIGHT,
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(code).toBe(0);
      expect(err.join('')).toContain(note);
      // The note alone would pass with an empty fallback window, which is the
      // fallback not existing. This is the half that says it is a real window.
      expect(delivered).toEqual([]);
      expect(firedAnchors(home)).toEqual([]);
      expect(out.join('')).toContain('rimandato');
    } finally {
      rt.close();
    }
  });

  it('a valid window inside the seal is the one that rules, and notes nothing', async () => {
    const home = homeWithSilence();
    // A window the fallback would never produce: if anyone stopped reading the
    // file, this home would speak at midday.
    writeFileSync(
      budgetsFile(home),
      JSON.stringify({
        schemaVersion: 1,
        monthlyUsd: 80,
        perTenantDailyUsd: 2,
        quietHours: { from: '10:00', to: '18:00', timezone: 'Europe/Rome' },
      }),
    );
    const rt = scriptedRuntime(home, ['non doveva uscire']);
    const { out, err } = capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW, // 13:00 in Rome: inside the file's window, outside the fallback's
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(code).toBe(0);
      expect(delivered).toEqual([]);
      expect(out.join('')).toContain('(quiet_hours)');
      // Not a single fallback note: both halves of the sealed file were read.
      expect(err.join('')).not.toContain('compilat');
    } finally {
      rt.close();
    }
  });
});

/**
 * One `--send` at a time.
 *
 * `observe()` reads `fires.has(anchor)` and `recordFired` writes after the
 * message is out; nothing spans the two. Two runs started together therefore
 * both see an unfired anchor and both deliver — measured, and the fire log
 * still holds one row, because `INSERT OR IGNORE` protects the row and not the
 * owner. A duplicate nudge is precisely the repetition this slice exists to
 * prevent, and it fails silently: exit 0 twice.
 */
describe('muffin observe --send · one at a time', () => {
  afterEach(() => vi.restoreAllMocks());

  it('two --send started together deliver once, and the second says why not', async () => {
    const home = homeWithSilence();
    const rt = scriptedRuntime(home, ['primo', 'secondo']);
    const { err } = capture();
    const delivered: string[] = [];
    try {
      const send = () =>
        cmdObserve(home, ['--send'], { now: NOW, deps: rt.deps, deliver: async (_c, t) => (delivered.push(t), DELIVERED) });
      const codes = (await Promise.all([send(), send()])).sort((a, b) => a - b);

      expect(delivered).toEqual(['primo']);
      expect(firedAnchors(home)).toHaveLength(1);
      // Loud, not a silent no-op: the run that lost has to be distinguishable
      // from the run that had nothing to say.
      expect(codes).toEqual([0, 75]);
      // Names the holder rather than saying "busy": both runs are this process,
      // so an assertion on the word alone would also pass on the wrong branch.
      expect(err.join('')).toContain(`pid ${process.pid}`);
      // Released even on the refusal path, or the next run inherits the block.
      expect(lockHolder(home)).toBeNull();
    } finally {
      rt.close();
    }
  });

  it('a lock held by a living process refuses by name and delivers nothing', async () => {
    const home = homeWithSilence();
    // This process is the most honestly live pid available to the test.
    holdLock(home, process.pid);
    const rt = scriptedRuntime(home, ['non doveva uscire']);
    const { err } = capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(delivered).toEqual([]);
      expect(firedAnchors(home)).toEqual([]);
      expect(code).not.toBe(0);
      expect(err.join('')).toContain(String(process.pid));
      // A live holder is never cleared: the process holding it still needs it.
      expect(lockHolder(home)).toBe(process.pid);
    } finally {
      rt.close();
    }
  });

  it('a stale lock is taken over, and the send goes through', async () => {
    const home = homeWithSilence();
    holdLock(home, deadPid());
    const rt = scriptedRuntime(home, ['da quanto non tocchi la tesi?']);
    capture();
    const delivered: string[] = [];
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: rt.deps,
        deliver: async (_c, t) => (delivered.push(t), DELIVERED),
      });
      expect(code).toBe(0);
      expect(delivered).toEqual(['da quanto non tocchi la tesi?']);
      expect(firedAnchors(home)).toHaveLength(1);
      expect(lockHolder(home)).toBeNull();
    } finally {
      rt.close();
    }
  });

  it('plain `muffin observe` still works while a send holds the lock', async () => {
    const home = homeWithSilence();
    holdLock(home, process.pid);
    const { out } = capture();

    // Showing what is pending is the command's main use: it must never be the
    // thing that a running send takes away.
    const code = await cmdObserve(home, [], { now: NOW });

    expect(code).toBe(0);
    expect(out.join('')).toContain('la tesi');
    expect(lockHolder(home)).toBe(process.pid);
  });
});
