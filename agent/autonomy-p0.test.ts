import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore, type Job } from '../core/scheduler/jobs.js';
import { Scheduler, type SchedulerEvent } from '../core/scheduler/scheduler.js';
import { SessionStore } from '../core/session/store.js';
import { DELIVERED } from '../core/surface/types.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { toolContext } from './fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import { makeJobRunner } from './scheduler-run.js';
import { makeScheduleTool, scheduleCapability } from './tools/schedule.js';
import { makeTodoTool, todoCapability } from './tools/todo.js';

/**
 * Autonomy P0 (#598) — acceptance scene sul production path.
 *
 * Proprietà: l'owner arma UNA volta un obiettivo durevole. Muffin si sveglia
 * senza un nuovo messaggio owner, esegue più step attraverso il runtime
 * canonico, usa solo capability consentite, registra gli Effect normali,
 * sopravvive a una continuation boundary e conclude (oppure entra in
 * needs-owner) senza duplicare effetti.
 *
 * Niente AutomationEngine parallelo: il fire entra in `makeJobRunner` →
 * `runTurn`/`continueTurn` (loop canonico) → capability policy → WAL/Effects →
 * continuation → outcome durevole. `Scheduler` resta l'unico chiamante.
 */

const BEFORE_ADD = new Date('2026-06-15T05:00:00Z');
const AFTER_FIRE = new Date('2026-06-15T06:00:00Z');

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const someUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Lo stallo upstream dentro una forma di successo: lease continuable, mai terminale. */
const stall = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'error',
  usage: zeroUsage,
  model: 'test-model',
});

const toolUse = (id: string, name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage: someUsage,
  model: 'test-model',
});

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: someUsage,
  model: 'test-model',
});

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    const next = this.script[this.i++];
    if (!next) throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

function toolResultsSeen(provider: Scripted): string[] {
  const out: string[] = [];
  for (const call of provider.seen) {
    for (const m of call.messages ?? []) {
      for (const b of m.content as Array<{ type: string; content?: string }>) {
        if (b.type === 'tool_result' && typeof b.content === 'string') out.push(b.content);
      }
    }
  }
  return out;
}

describe('Autonomy P0 — un goal durevole gira senza owner, continua, conclude', () => {
  it(
    'owner arma → trigger → 2+ tool step → effect settled → continuable → resume stesso turn → done, senza duplicati né self-schedule',
    { timeout: 20000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'muffin-autonomy-p0-'));
      let current = BEFORE_ADD;
      const clock = () => current;
      const db = new DatabaseCtor(':memory:');
      const turns = new TurnStore(db);
      const todos = new TodoStore(db);
      const jobs = new JobStore(db, clock);
      const fires = new JobFireStore(db, clock);

      // 1. L'owner arma il goal UNA volta, attraverso il tool canonico
      //    (stesso store della CLI, provenance del turno owner).
      const scheduleTool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
      const armed = await scheduleTool.handler(
        { cron: '0 8 * * *', goal: 'controlla il backup e aggiorna il piano' },
        toolContext({ sessionId: 'owner' }),
      );
      expect(armed.isError).not.toBe(true);
      expect(jobs.list()).toHaveLength(1);
      const job = jobs.list()[0] as Job;
      expect(job.goal).toBe('controlla il backup e aggiorna il piano');

      // Il runtime canonico del fire: todo reale (effect) + schedule reale
      // (per il tentativo vietato). Niente finti: gli handler contano.
      const todoCalls: unknown[] = [];
      const scheduleCalls: unknown[] = [];
      const innerTodo = makeTodoTool(todos);
      const todoTool: RegisteredTool = {
        ...innerTodo,
        handler: (args, ctx) => {
          todoCalls.push(args);
          return innerTodo.handler(args, ctx);
        },
      };
      const innerSchedule = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
      const forbiddenTool: RegisteredTool = {
        ...innerSchedule,
        handler: (args, ctx) => {
          scheduleCalls.push(args);
          return innerSchedule.handler(args, ctx);
        },
      };
      const caps = new Map([
        [todoCapability.id, todoCapability],
        [scheduleCapability.id, scheduleCapability],
      ] as const);
      // 4. Il modello fa due step utili, poi la lease cade (stalli), poi —
      //    sulla lease autonoma — tenta un self-schedule vietato, chiude un
      //    secondo effect e risponde.
      const provider = new Scripted([
        toolUse('c-plan', 'todo', { action: 'plan', items: ['raccogli esito backup', 'aggiorna piano'] }),
        stall(),
        stall(),
        stall(),
        stall(),
        toolUse('c-self', 'schedule_recurring', { cron: '0 9 * * *', goal: 'job figlio non autorizzato' }),
        toolUse('c-set', 'todo', { action: 'set', step: 1, state: 'done' }),
        answer('backup verificato, piano aggiornato'),
      ]);
      const deps: LoopDeps = {
        provider,
        profile: CONSERVATIVE,
        model: 'test-model',
        tools: [todoTool, forbiddenTool],
        decide: createDecide({ matrix: POLICY_FLOOR, capabilities: new Map(caps), budgetExhausted: () => false, hardened: true }),
        capabilities: new Map(caps),
        tracer: new SimpleTracer(new JsonlExporter(home)),
        sessions: new SessionStore(home),
        turns,
        todos,
        budgetExhausted: () => false,
        systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin.' },
      };

      // 2+3. Niente nuovo input owner: il trigger è lo Scheduler, il giro è
      //      system@scheduler sul production path completo (deliver + settle).
      const delivered: { channel: string; text: string }[] = [];
      const events: SchedulerEvent[] = [];
      const runner = makeJobRunner(deps, fires);
      const sched = new Scheduler(
        jobs,
        runner,
        async (channel, text) => {
          delivered.push({ channel, text });
          return DELIVERED;
        },
        undefined,
        (e) => events.push(e),
        clock,
        undefined,
        (turnId, delivery) => turns.delivered(turnId, delivery),
        new ModelLane(),
        undefined,
        (fired) => fires.settle(fired.id, fired.nextFireAt.toISOString()),
      );
      current = AFTER_FIRE;
      const ran = new Promise<SchedulerEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lo Scheduler non ha mai chiuso il fire')), 15000);
        const check = () => {
          const hit = events.find((e) => e.kind === 'ran');
          if (hit !== undefined) {
            clearTimeout(timer);
            resolve(hit);
          } else setTimeout(check, 25);
        };
        check();
      });
      sched.tick();
      const ranEvent = await ran;
      expect(ranEvent.kind).toBe('ran');

      // 10. Stesso lavoro arrivato a done (non needs-owner qui: niente ask).
      expect(ranEvent).toMatchObject({ kind: 'ran', stopped: 'answered', delivered: true });

      const scheduledFor = job.nextFireAt.toISOString();
      const fire = fires.get(job.id, scheduledFor);
      expect(fire?.turnId).not.toBeNull();
      const turnId = fire!.turnId as string;

      // 7+8. Stesso turn, due lease, una sola riga, effect mai duplicato.
      const rows = db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number };
      expect(rows.n).toBe(1);
      const row = turns.get(turnId);
      expect(row?.status).toBe('done');
      expect(row?.outcome).toBe('answered');
      expect(row?.principal).toEqual({ kind: 'system', source: 'scheduler' });
      const leases = turns.leasesFor(turnId);
      expect(leases).toHaveLength(2);
      // 6. La prima lease è caduta DOPO lavoro utile, non a turno vuoto.
      expect(leases[0]?.outcome).toBe('provider_empty');
      expect(leases[0]?.counters?.toolCallsMade).toBe(1);

      // 5+8. WAL intent→outcome: il plan è settled una volta sola, in due lease
      //      l'handler ha girato per plan una volta sola (replay, non re-fire).
      const outcomes = turns.recordedOutcomes(turnId);
      expect(outcomes.get('c-plan')?.isError).toBe(false);
      expect(todoCalls.filter((a) => (a as { action: string }).action === 'plan')).toHaveLength(1);
      expect(todoCalls).toHaveLength(2);
      const plan = todos.list('host', row!.sessionId);
      expect(plan.length).toBeGreaterThanOrEqual(2);

      // 9. Il tentativo di mintare autonomia futura è negato dal kernel.
      const seen = toolResultsSeen(provider);
      expect(seen.some((t) => t.includes('principal_forbidden'))).toBe(true);
      expect(scheduleCalls).toHaveLength(0);
      expect(jobs.list().map((j) => j.id)).toEqual([job.id]);

      // Il modello ha fatto davvero 3 interazioni tool su 2 lease.
      expect(provider.seen.length).toBe(8);

      // Dalle righe durevoli è ricostruibile tutto: cosa, quale run, cosa
      // fatto, outcome. Il fire è settled, la schedule è avanzata, la
      // consegna è registrata sulla stessa riga del turno.
      expect(fire?.settledAt).not.toBeNull();
      expect(jobs.get(job.id)?.lastRunAt).not.toBeNull();
      expect(row?.delivery).toBe('sent');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).toContain('backup verificato');
      const calls = db
        .prepare(`SELECT tool, capability, content FROM turn_tool_calls WHERE turn_id = ? ORDER BY rowid`)
        .all(turnId) as { tool: string; capability: string; content: string | null }[];
      expect(calls.map((c) => c.tool)).toEqual(['todo', 'todo']);
      // Nessun intento per la chiamata negata: il deny non raggiunge l'handler.
      expect(calls.some((c) => c.tool === 'schedule_recurring')).toBe(false);

      db.close();
    },
  );
});
