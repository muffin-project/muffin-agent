import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

describe('acceptance · #598 · a Telegram request arms one autonomous job', () => {
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
        { tool: { name: 'schedule_once', args: { goal } } },
        { text: armed },
        { tool: { name: 'schedule_once', args: { goal: 'Forbidden child job' } } },
        { tool: { name: 'fs_write', args: { path: filename, content: evidence } } },
        { tool: { name: 'fs_read', args: { path: filename } } },
        { text: final },
      ],
    });
    const telegram = await startFakeTelegram();
    try {
      // Text-only fixture. Avoid downloading the unrelated speech model at setup.
      mkdirSync(join(inst.home, 'models'), { recursive: true });
      writeFileSync(join(inst.home, 'models', 'ggml-base.bin'), 'unused text-only fixture');
      expect(
        (await inst.muffin(['secret', 'set', 'telegram_token'], '123:fixture-only')).code,
      ).toBe(0);
      const enabled = await inst.muffin([
        'surface',
        'enable',
        'telegram',
        '--api-base',
        telegram.url,
        '--owner',
        String(owner.id),
      ]);
      expect(enabled.code, enabled.err).toBe(0);
      seal(inst.home, '1', new Date());

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
      expect(inst.provider.main()[0]?.tools).toContain('schedule_once');

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
      const effects = inst.db((db) =>
        db
          .prepare(`
        SELECT tool, is_error FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at, rowid
      `)
          .all(fires[0]!.id),
      );
      expect(effects).toEqual([
        { tool: 'fs_write', is_error: 0 },
        { tool: 'fs_read', is_error: 0 },
      ]);
      expect(inst.provider.main()[2]?.tools).not.toContain('schedule_once');
      expect(inst.provider.main()[3]?.transcript).toContain('principal_forbidden');
      expect(inst.provider.main()[5]?.transcript).toContain(evidence.trim());
      expect(inst.provider.main()).toHaveLength(6);
      await restarted.stop();
    } finally {
      await inst.cleanup();
      await telegram.close();
    }
  }, 60_000);
});
