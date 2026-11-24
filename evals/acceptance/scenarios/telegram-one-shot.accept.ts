import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { type Install, install, until } from '../harness.js';
import { type FakeTelegram, privateMessage, startFakeTelegram } from '../telegram.js';

async function pairTelegram(inst: Install, telegram: FakeTelegram, ownerId: number): Promise<void> {
  // Text-only fixture. Avoid downloading the unrelated speech model at setup.
  mkdirSync(join(inst.home, 'models'), { recursive: true });
  writeFileSync(join(inst.home, 'models', 'ggml-base.bin'), 'unused text-only fixture');
  expect((await inst.muffin(['secret', 'set', 'telegram_token'], '123:fixture-only')).code).toBe(0);
  const enabled = await inst.muffin([
    'surface',
    'enable',
    'telegram',
    '--api-base',
    telegram.url,
    '--owner',
    String(ownerId),
  ]);
  expect(enabled.code, enabled.err).toBe(0);
  seal(inst.home, '1', new Date());
}

describe('acceptance · #598 · deferred work delivery', () => {
  it('refuses deferred delivery over the temporary forwarded CLI connection', async () => {
    const request =
      'Confronta in background una sola volta 80 più 25 di spedizione con 100 spedizione inclusa. Rimandami il risultato quando è finito.';
    const result = 'Questa conversazione può ricevere il confronto soltanto ora.';
    const inst = await install({
      main: [{ tool: { name: 'schedule_once', args: { goal: request } } }, { text: result }],
    });
    try {
      const gateway = await inst.gateway();
      await gateway.waitFor(/muffin gateway/, 15_000);
      const reply = await inst.muffin(['run', '--json', '--timeout', '40', request]);
      expect(reply.code, reply.err).toBe(0);
      expect(reply.err).toContain('esecuzione sul gateway');
      expect(JSON.parse(reply.out).text).toBe(result);
      expect(inst.db((db) => db.prepare('SELECT * FROM jobs').all())).toHaveLength(0);
      expect(inst.db((db) => db.prepare('SELECT * FROM job_fires').all())).toHaveLength(0);
      expect(inst.provider.main()).toHaveLength(2);
      expect(inst.provider.main()[1]?.transcript).toContain('No job was created.');
      expect(inst.provider.main()[1]?.transcript).toContain('a connected messaging conversation');
      await gateway.stop();
    } finally {
      await inst.cleanup();
    }
  }, 60_000);

  it('does not redirect a resumed terminal request to the default Telegram chat', async () => {
    const ownerId = 424242;
    const request = 'Wait for my synthetic dependency, then do the comparison in background.';
    const result = 'The original conversation cannot receive a later result.';
    const barrier = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
    try {
      if (barrier.pid === undefined) throw new Error('Could not start the fixture dependency');
      const inst = await install({
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
        main: [
          { tool: { name: 'wait', args: { seconds: 60, until_process_exits: barrier.pid } } },
          { tool: { name: 'schedule_once', args: { goal: 'Compare the shipping quotes' } } },
          { text: result },
        ],
      });
      const telegram = await startFakeTelegram();
      try {
        await pairTelegram(inst, telegram, ownerId);
        const configured = await inst.muffin(['surface', 'default', 'telegram']);
        expect(configured.code, configured.err).toBe(0);
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 15_000);
        const reply = await inst.muffin(['run', '--json', '--timeout', '40', request]);
        expect(reply.code, reply.err).toBe(6);
        const initial = JSON.parse(reply.out) as { stopped: string; turnId: string };
        expect(initial.stopped).toBe('suspended');
        barrier.kill();
        await until(
          () =>
            inst.db((db) =>
              db.prepare('SELECT status FROM turns WHERE id = ?').pluck().get(initial.turnId),
            ) === 'done',
        );
        expect(inst.db((db) => db.prepare('SELECT * FROM jobs').all())).toHaveLength(0);
        expect(inst.provider.main()).toHaveLength(3);
        expect(inst.provider.main()[2]?.transcript).toContain('No job was created.');
        expect(telegram.messages()).toEqual([]);
        await gateway.stop();
      } finally {
        await inst.cleanup();
        await telegram.close();
      }
    } finally {
      if (barrier.exitCode === null) barrier.kill();
    }
  }, 60_000);

  it('survives gateway restart before firing and sends one final receipt to the original chat', async () => {
    const owner = { id: 424242, name: 'Synthetic owner' };
    const filename = 'one-shot-evidence.txt';
    const evidence = 'written once by the scheduler\n';
    const request =
      'Avvia in background una sola volta un lavoro per creare e verificare il file one-shot-evidence.txt. Avvisami quando è finito.';
    const goal = 'Create and verify the synthetic file one-shot-evidence.txt.';
    const armed = 'One-shot work armed.';
    const final = 'One-shot file verified and complete.';
    const inst = await install({
      // One startup beat, then time for the owner turn and the deliberate restart.
      env: { MUFFIN_GATEWAY_TICK_MS: '60000' },
      main: [
        {
          tool: {
            name: 'capability_search',
            args: { query: 'arm an independent background objective once', max_results: 1 },
          },
        },
        { tool: { name: 'schedule_once', args: { goal } } },
        { text: armed },
        { tool: { name: 'schedule_once', args: { goal: 'Forbidden child job' } } },
        {
          tool: {
            name: 'capability_search',
            args: { query: 'write text content to a file', max_results: 1 },
          },
        },
        { tool: { name: 'fs_write', args: { path: filename, content: evidence } } },
        { tool: { name: 'fs_read', args: { path: filename } } },
        { text: final },
      ],
    });
    const telegram = await startFakeTelegram();
    try {
      await pairTelegram(inst, telegram, owner.id);

      const gateway = await inst.gateway();
      await gateway.waitFor(/muffin gateway/, 15_000);
      telegram.deliver(privateMessage(owner, request));
      await until(
        () => telegram.messages().some((message) => message.text.includes(armed)),
        15_000,
      );
      const readJobs = () =>
        inst.db(
          (db) =>
            db
              .prepare(`
        SELECT id, channel, active, run_once, delegation, origin_tenant, origin_surface,
               origin_principal, origin_turn FROM jobs
      `)
              .all() as { id: string; origin_turn: string }[],
        );
      const jobs = readJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job).toMatchObject({
        channel: 'telegram:' + owner.id,
        active: 1,
        run_once: 1,
        delegation: 'manual',
        origin_tenant: 'host',
        origin_surface: 'telegram',
        origin_principal: 'owner',
      });
      const ownerTurn = inst.db((db) =>
        db.prepare('SELECT input_text FROM turns WHERE id = ?').get(job.origin_turn),
      );
      expect(ownerTurn).toEqual({ input_text: request });
      expect(inst.db((db) => db.prepare('SELECT * FROM job_fires').all())).toHaveLength(0);
      expect(inst.provider.main()[0]?.tools).toContain('capability_search');
      expect(inst.provider.main()[0]?.tools).not.toContain('schedule_once');
      expect(inst.provider.main()[1]?.tools).toContain('schedule_once');

      await gateway.stop();
      expect(readJobs()).toEqual([job]);
      const restarted = await inst.gateway();
      await restarted.waitFor(/muffin gateway/, 15_000);
      await until(
        () => telegram.messages().some((message) => message.text.includes(final)),
        15_000,
      );
      await until(
        () =>
          inst.db(
            (db) => db.prepare('SELECT active FROM jobs WHERE id = ?').pluck().get(job.id) === 0,
          ),
        5_000,
      );

      expect(readFileSync(join(inst.workspace, filename), 'utf8')).toBe(evidence);
      expect(telegram.messages().filter((message) => message.text.includes(final))).toEqual([
        { chatId: owner.id, text: expect.stringContaining(final) },
      ]);
      expect(readJobs()).toHaveLength(1);
      const fires = inst.db((db) =>
        db
          .prepare(`
        SELECT f.job_id, f.settled_at, f.silent, t.id, t.status, t.turn_outcome, t.delivery, t.principal
          FROM job_fires f JOIN turns t ON t.id = f.turn_id
      `)
          .all(),
      ) as { id: string; principal: string }[];
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({
        job_id: job.id,
        settled_at: expect.any(String),
        silent: 0,
        status: 'done',
        turn_outcome: 'answered',
        delivery: 'sent',
      });
      expect(JSON.parse(fires[0]!.principal)).toEqual({ kind: 'system', source: 'scheduler' });
      const sent = telegram
        .sent()
        .filter(
          (call) => call.method === 'sendMessage' && String(call.payload['text']).includes(final),
        );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.messageId).toEqual(expect.any(Number));
      expect(
        inst.db((db) =>
          db
            .prepare(`
        SELECT chat_id, status, telegram_message_id FROM telegram_delivery_parts WHERE turn_id = ?
      `)
            .all(fires[0]!.id),
        ),
      ).toEqual([{ chat_id: owner.id, status: 'sent', telegram_message_id: sent[0]!.messageId }]);
      const effects = inst.db((db) =>
        db
          .prepare(`
        SELECT tool, is_error FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at, rowid
      `)
          .all(fires[0]!.id),
      );
      expect(effects).toEqual([
        { tool: 'capability_search', is_error: 0 },
        { tool: 'fs_write', is_error: 0 },
        { tool: 'fs_read', is_error: 0 },
      ]);
      const requests = inst.provider.main();
      expect(requests.slice(3).every((request) => !request.tools.includes('schedule_once'))).toBe(
        true,
      );
      expect(requests[4]?.transcript).toContain('principal_forbidden');
      expect(requests[5]?.tools).toContain('fs_write');
      expect(requests[7]?.transcript).toContain(evidence.trim());
      expect(requests).toHaveLength(8);
      await restarted.stop();
    } finally {
      await inst.cleanup();
      await telegram.close();
    }
  }, 60_000);
});
