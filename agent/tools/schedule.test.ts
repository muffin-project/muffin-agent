import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import { armingTier } from '../../core/policy/types.js';
import { JobFireStore } from '../../core/scheduler/job-fires.js';
import { JobStore } from '../../core/scheduler/jobs.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { visibleTools } from '../context/assemble.js';
import { toolContext } from '../fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool, ToolContext, TurnInput } from '../loop.js';
import { runTool } from '../loop/tool-call.js';
import { makeSnapshot } from '../loop/permissions.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from '../providers/types.js';
import { buildRuntime } from '../runtime.js';
import { makeJobRunner } from '../scheduler-run.js';
import { makeScheduleTool, scheduleCapability } from './schedule.js';

/**
 * Il bug conversazionale: «ricordamelo ogni giorno alle 9» non ha una strada
 * di produzione verso un job durevole.
 *
 * `cli/jobs.ts` lo dice alla luce del sole — lo strumento per creare job da
 * una frase non è mai esistito, `JobStore.add` ha un solo chiamante fuori da
 * test/eval (la CLI) — e `agent/context/assemble.ts` (WORK_RULES) registra il
 * sintomo sul campo: il modello, senza un tool da chiamare, ha spiegato
 * l'assenza come un permesso negato. La scorciatoia vietata è lo shell-out
 * verso `muffin jobs add --cron`: perderebbe provenance, authority e taint
 * dell'intento originale, e i job partirebbero a `taint: 0` con un principal
 * di sistema.
 *
 * Questi test sono rossi finché la capability canonica non esiste: un intento
 * autorizzato deve diventare un job durevole attraverso un tool tipizzato e
 * validato, sullo stesso store della CLI, con provenance e taint preservati
 * fino all'esecuzione futura.
 */

function memoryTool() {
  const db = new DatabaseCtor(':memory:');
  const jobs = new JobStore(db);
  return {
    db,
    jobs,
    tool: makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' }),
  };
}

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call?: ChatCall): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next)
      throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

describe('armingTier — un invariante, un proprietario', () => {
  it('il soffitto che arma un trigger futuro è il massimo dei due taint', () => {
    // La stessa formula che `todo due` scrive come `due_tier` e questo tool
    // come `tier` della riga job: se una delle due strade la calcolasse
    // diversa, una promessa e una ricorrenza nate dallo stesso turno
    // partirebbero da due autorità diverse.
    expect(armingTier(0, 0)).toBe(0);
    expect(armingTier(0, 2)).toBe(2);
    expect(armingTier(3, 0)).toBe(3);
    expect(armingTier(2, 2)).toBe(2);
  });
});

describe('la richiesta ricorrente crea esattamente un durable job', () => {
  it('«ogni giorno alle 9» diventa una riga con schedule corretta e id reale', async () => {
    const { jobs, tool } = memoryTool();
    const res = await tool.handler(
      { cron: '0 9 * * *', goal: 'ricordami di bere acqua' },
      toolContext({ sessionId: 'owner' }),
    );
    expect(res.isError).not.toBe(true);
    const righe = jobs.list();
    expect(righe).toHaveLength(1);
    const job = righe[0];
    if (!job) throw new Error('il tool ha risposto ok ma non ha persistito nessuna riga');
    expect(job.cron).toBe('0 9 * * *');
    expect(job.timezone).toBe('Europe/Rome');
    expect(job.channel).toBe('cli');
    if (job.kind !== 'goal') throw new Error('un promemoria è un goal, non uno script');
    expect(job.goal).toBe('ricordami di bere acqua');
    // L'id restituito è quello realmente persistito, non una parafrasi.
    expect(res.content).toContain(job.id.slice(0, 8));
    expect(jobs.get(job.id)?.id).toBe(job.id);
    // La prossima esecuzione è calcolata dallo stesso motore della CLI.
    expect(job.nextFireAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('«ogni lunedì alle 18» con timezone esplicita la usa, validata', async () => {
    const { jobs, tool } = memoryTool();
    const res = await tool.handler(
      { cron: '0 18 * * 1', timezone: 'Europe/Rome', goal: 'ricordami X' },
      toolContext({ sessionId: 'owner' }),
    );
    expect(res.isError).not.toBe(true);
    expect(jobs.list()[0]?.cron).toBe('0 18 * * 1');
    expect(jobs.list()[0]?.timezone).toBe('Europe/Rome');
  });

  it('un cron malformato o una timezone ignota non scrivono e non confermano', async () => {
    const { jobs, tool } = memoryTool();
    for (const args of [
      { cron: 'non un cron', goal: 'x' },
      { cron: '0 9 * * *', timezone: 'Europe/Roma', goal: 'x' },
      { cron: '', goal: 'x' },
      { cron: '0 9 * * *' },
      {},
    ]) {
      const res = await tool.handler(args, toolContext({ sessionId: 'owner' }));
      expect(res.isError).toBe(true);
      // Nessuna falsa conferma: il marcatore di successo è la prossima
      // esecuzione calcolata, e un errore non deve mai portarlo.
      expect(res.content).not.toContain('prossima esecuzione');
    }
    expect(jobs.list()).toEqual([]);
  });

  it('il modello non nomina tenant, canale o provenance: li decide il turno', async () => {
    const { jobs, tool } = memoryTool();
    const res = await tool.handler(
      {
        cron: '0 9 * * *',
        goal: 'x',
        channel: 'telegram:999',
        tenant: 'group:telegram:999',
        tier: 0,
      },
      toolContext({ sessionId: 'owner', replyChannel: 'telegram:123' }),
    );
    expect(res.isError).not.toBe(true);
    // La chiave in più viene ignorata: il canale è quello del turno, mai un
    // destinatario scelto dal modello (sarebbe un nuovo recipient = outward).
    expect(jobs.list()[0]?.channel).toBe('telegram:123');
  });

  it('senza replyChannel il canale è il default di superficie, non del processo', async () => {
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db);
    const tool = makeScheduleTool({
      jobs,
      defaultTimezone: 'Europe/Rome',
      defaultChannel: 'telegram',
    });
    const res = await tool.handler(
      { cron: '0 9 * * *', goal: 'x' },
      toolContext({ sessionId: 's' }),
    );
    expect(res.isError).not.toBe(true);
    expect(jobs.list()[0]?.channel).toBe('telegram');
  });
});

describe('provenance, principal e taint attraversano il confine del job futuro', () => {
  it('la riga porta tenant, superficie, principal, turno e soffitto del turno', async () => {
    const { jobs, tool } = memoryTool();
    await tool.handler(
      { cron: '0 9 * * *', goal: 'ricordami X' },
      toolContext({
        sessionId: 'owner',
        turnId: 'turno-42',
        taint: () => 1,
        intrinsicTaint: () => 0,
      }),
    );
    const job = jobs.list()[0];
    if (!job) throw new Error('il tool ha risposto ok ma non ha persistito nessuna riga');
    expect(job.origin.tenant).toBe('host');
    expect(job.origin.surface).toBe('cli');
    expect(job.origin.principal).toBe('owner');
    expect(job.origin.turnId).toBe('turno-42');
    // Il soffitto che ha armato l'intento, non l'intrinseco pulito — la stessa
    // distinzione di `todo due` (due_tier): un trigger differito è proprio il
    // caso che l'intrinseco esclude per costruzione.
    expect(job.tier).toBe(1);
  });

  it('il giro futuro gira con il taint della riga, nel tenant della riga, attribuito al job', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-schedule-fire-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const todos = new TodoStore(db);
    const jobs = new JobStore(db);
    const fires = new JobFireStore(db);
    const provider = new Scripted([answer('promemoria!')]);
    const deps: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [],
      decide: createDecide({
        matrix: POLICY_FLOOR,
        capabilities: new Map(),
        budgetExhausted: () => false,
        hardened: true,
      }),
      capabilities: new Map(),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions: new SessionStore(home),
      turns,
      todos,
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin.' },
    };
    const tool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
    await tool.handler(
      { cron: '0 9 * * *', goal: 'ricordami X' },
      toolContext({
        sessionId: 'owner',
        turnId: 'turno-42',
        taint: () => 2,
        intrinsicTaint: () => 0,
      }),
    );
    const job = jobs.list()[0];
    if (!job) throw new Error('il tool ha risposto ok ma non ha persistito nessuna riga');

    const outcome = await makeJobRunner(deps, fires)(job, undefined);
    if (!('stopped' in outcome))
      throw new Error(`atteso un JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    if (!outcome.turnId) throw new Error('il giro futuro non ha scritto nessuna riga di turno');
    const riga = turns.get(outcome.turnId);
    if (!riga) throw new Error('la riga di turno del giro futuro non esiste');
    // Non più il letterale 0: il giro futuro non lava la provenienza.
    expect(riga.taint).toBe(2);
    expect(riga.tenant).toBe('host');
    expect(riga.jobId).toBe(job.id);
    expect(riga.principal).toEqual({ kind: 'system', source: 'scheduler' });
  });

  it('restart non perde il job: riaprendo il database c’è ancora, con schedule e provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-schedule-restart-'));
    const file = join(dir, 'muffin.db');
    const aperto = new DatabaseCtor(file);
    const jobs = new JobStore(aperto);
    const tool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
    const res = await tool.handler(
      { cron: '0 9 * * *', goal: 'ricordami X' },
      toolContext({ sessionId: 'owner', turnId: 'turno-7' }),
    );
    expect(res.isError).not.toBe(true);
    const prima = jobs.list()[0];
    if (!prima) throw new Error('il tool ha risposto ok ma non ha persistito nessuna riga');
    const id = prima.id;
    aperto.close();

    const riaperto = new DatabaseCtor(file);
    const jobs2 = new JobStore(riaperto);
    const job = jobs2.get(id);
    expect(job?.cron).toBe('0 9 * * *');
    expect(job?.timezone).toBe('Europe/Rome');
    expect(job?.origin.turnId).toBe('turno-7');
    expect(job?.origin.principal).toBe('owner');
    expect(job?.tier).toBe(0);
    riaperto.close();
  });
});

describe('la capability è registrata, surface-agnostic e chiusa ai membri', () => {
  it('il runtime vero espone schedule_recurring con la capability jobs.schedule', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-schedule-rt-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-schedule-ws-')));
    try {
      const tool = runtime.deps.tools.find((t) => t.spec.name === 'schedule_recurring');
      expect(tool, 'il loop non ha la porta conversazionale sui job ricorrenti').toBeDefined();
      expect(tool?.capability).toBe('jobs.schedule');
      expect(scheduleCapability.hostOnly).toBe(true);
      expect(scheduleCapability.effect).toBe('context');
      expect(scheduleCapability.rerunnable).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it('un membro non lo vede nel menu e il kernel non glielo concede', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-schedule-mb-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-schedule-mb-ws-')));
    try {
      const member = {
        kind: 'member',
        connector: 'telegram',
        tenantId: 'group:telegram:42',
        externalId: 'u1',
      } as const;
      const menu = visibleTools(runtime.deps.tools, member, runtime.deps.capabilities, undefined);
      expect(menu.some((t) => t.spec.name === 'schedule_recurring')).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it('nessuna superficie reinventa lo scheduler: la creazione vive in un posto solo', () => {
    // Le superfici recapitano e fanno girare il loop; non parsano cron, non
    // aprono JobStore, non deducono timezone. La seconda strada per creare un
    // job oltre a `cli/jobs.ts` è il tool, sullo stesso store.
    const superfici = [
      'connectors/telegram/connector.ts',
      'connectors/discord/connector.ts',
      'connectors/discord/gateway.ts',
      'connectors/discord/surface.ts',
      'connectors/shared/ingress/work.ts',
      'connectors/shared/ingress/router.ts',
      'connectors/shared/ingress/lane.ts',
      'cli/repl.ts',
      'cli/run.ts',
      'cli/gateway.ts',
    ];
    const root = join(import.meta.dirname, '..', '..');
    for (const file of superfici) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src, `${file} apre JobStore`).not.toContain('JobStore');
      // `nextFire(` con la parentesi: la chiamata al motore, non la
      // proprietà `nextFireAt` che le righe già persistite portano con sé.
      expect(src, `${file} calcola nextFire`).not.toContain('nextFire(');
    }
  });

  it('nessun secondo motore cron: solo lo store canonico lo interpreta', () => {
    const root = join(import.meta.dirname, '..', '..');
    const ammessi = new Set(['core/scheduler/jobs.ts', 'core/scheduler/proactivity.ts']);
    const candidati = ['agent/tools/schedule.ts', 'cli/jobs.ts', 'cli/gateway.ts', 'cli/repl.ts'];
    for (const file of candidati) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src, `${file} importa un parser cron proprio`).not.toContain('CronExpressionParser');
      void ammessi;
    }
  });
});

describe('un principal autonomo non arma ricorrenze (S1)', () => {
  /**
   * Amplification boundary: un'autonomia già delegata (il fire gira con il
   * runtime completo) non deve creare nuova autonomia durevole. Cardinalità,
   * durata e spesa crescerebbero senza una nuova decisione owner — e il taint
   * che non sale non è la misura di questo guasto.
   *
   * La chiusura vive nel proprietario canonico (`forbiddenForSystem`,
   * `core/policy/matrix.ts`), non in un `if` dentro l'handler: il kernel nega
   * `principal_forbidden` a qualunque `system`, qualunque sia il taint.
   */
  function decideConSchedule() {
    const caps = new Map([[scheduleCapability.id, scheduleCapability]] as const);
    return createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(caps),
      budgetExhausted: () => false,
      hardened: true,
    });
  }

  it('system@scheduler riceve principal_forbidden su jobs.schedule', () => {
    const decide = decideConSchedule();
    for (const taint of [0, 2, 3] as const) {
      expect(
        decide({
          principal: { kind: 'system', source: 'scheduler' },
          tenant: 'host',
          capability: 'jobs.schedule',
          resource: { kind: 'none' },
          args: {},
          taint,
        }),
      ).toEqual({ effect: 'deny', code: 'principal_forbidden', detail: 'not available to autonomous principals' });
    }
  });

  it("l'owner normale continua a poter creare recurring jobs", () => {
    const decide = decideConSchedule();
    const d = decide({
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      capability: 'jobs.schedule',
      resource: { kind: 'none' },
      args: {},
      taint: 0,
    });
    // `allow`: (context, low, undoable) esegue — `medium` sarebbe `draft` e
    // `draft` senza `resolveEffectPath` rifiuta ogni chiamata, quindi un
    // rischio diverso renderebbe il tool ineseguibile nel loop.
    expect(d.effect).toBe('allow');
  });
});

describe('one accepted effect → one Job (effect identity)', () => {
  /**
   * Il contract, stretto: UNA riga per ogni effect durevole accettato — non
   * «una riga per intento umano». Due tool call distinte con gli stessi
   * argomenti restano due richieste legittime (l'owner può volerlo davvero
   * due volte); ma la STESSA identity `(turn_id, call_id)` — retry della
   * stessa call, resume, duplicate id nello stesso batch — non deve mai
   * raggiungere l'handler due volte.
   *
   * Il WAL scrive intent prima e outcome dopo: un outcome già registrato per
   * questo `call.id` va rigiocato, mai ricalcolato (la stessa proprietà che
   * `reconcile` garantisce alla ripresa — qui sul percorso vivo).
   */
  it('stesso call id consegnato due volte: handler una volta sola, una riga sola', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-schedule-effect-id-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const jobs = new JobStore(db);
    const tool: RegisteredTool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
    const caps = new Map([[scheduleCapability.id, scheduleCapability]] as const);
    const deps: LoopDeps = {
      provider: undefined as never,
      profile: CONSERVATIVE,
      model: 'test',
      tools: [tool],
      capabilities: new Map(caps),
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities: new Map(caps), budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions: new SessionStore(home),
      turns,
      todos: new TodoStore(new DatabaseCtor(':memory:')),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin.' },
    };
    const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
    const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
    const parent = deps.tracer.start('muffin.turn', {});
    const input: TurnInput = {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: { id: 's1', file: '/dev/null' },
      text: 'ricordamelo ogni giorno alle 9',
    };
    const ctx: ToolContext = {
      tenant: 'host',
      principal: owner,
      turnId: 'turn-1',
      sessionId: 's1',
      taint: () => snapshot.currentTaint(),
      intrinsicTaint: () => snapshot.intrinsicTaint(),
      suspend: () => {
        throw new Error('questo test non sospende');
      },
      replyChannel: 'cli',
    };
    const call = { id: 'c1', name: 'schedule_recurring', args: { cron: '0 9 * * *', goal: 'bere acqua' } };

    const first = await runTool(deps, snapshot, parent, call, input, [tool], ctx);
    if (first.type !== 'tool_result') throw new Error(`atteso un tool_result, ricevuto ${first.type}`);
    expect(first.isError).not.toBe(true);
    const second = await runTool(deps, snapshot, parent, call, input, [tool], ctx);
    if (second.type !== 'tool_result') throw new Error(`atteso un tool_result, ricevuto ${second.type}`);
    // Stesso contenuto rigiocato — nessuna seconda esecuzione.
    expect(second.content).toBe(first.content);
    expect(second.isError).toBe(first.isError);
    expect(jobs.list()).toHaveLength(1);
    db.close();
  });

  it('due call id distinte con stessi args restano due richieste: due righe', async () => {
    const db = new DatabaseCtor(':memory:');
    try {
      const jobs = new JobStore(db);
      const tool = makeScheduleTool({ jobs, defaultTimezone: 'Europe/Rome', defaultChannel: 'cli' });
      const ctx = toolContext({ sessionId: 'owner' });
      const args = { cron: '0 9 * * *', goal: 'acqua' };
      await tool.handler(args, ctx);
      await tool.handler(args, ctx);
      expect(jobs.list()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
