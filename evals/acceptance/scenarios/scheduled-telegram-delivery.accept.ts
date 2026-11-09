import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { startFakeTelegram } from '../telegram.js';

const OWNER = 424242;
const FINAL = 'Scheduled work verified and complete.';
const FILE = 'scheduled-evidence.txt';
const EVIDENCE = 'one settled write before interruption\n';

describe('acceptance · #949 · scheduled Telegram delivery', () => {
  it.each([
    'interrupted work',
    'before send',
    'lost send response',
    'legacy lost response',
  ] as const)(
    'reconciles %s without losing or repeating the final message',
    async (scene) => {
      const interrupted = scene === 'interrupted work';
      const beforeSend = scene === 'before send';
      const legacy = scene === 'legacy lost response';
      const uncertain = !interrupted && !beforeSend;
      const delivery = uncertain ? 'possibly_sent' : 'sent';
      const inst = await install({
        env: {
          MUFFIN_GATEWAY_TICK_MS: '1000',
          ...(beforeSend ? { MUFFIN_JOB_FIRES_STALL_AFTER_DONE_MS: '8000' } : {}),
        },
        main: interrupted
          ? [
              { tool: { name: 'fs_write', args: { path: FILE, content: EVIDENCE } } },
              { text: 'Interrupted before completion.', delayMs: 8_000 },
              { tool: { name: 'fs_read', args: { path: FILE } } },
              { text: FINAL },
            ]
          : [{ text: FINAL }],
      });
      const telegram = await startFakeTelegram();
      try {
        // Text-only fixture. Avoid downloading the speech model.
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
          String(OWNER),
        ]);
        expect(enabled.code, enabled.err).toBe(0);
        seal(inst.home, '1', new Date());
        const armed = await inst.muffin([
          'jobs',
          'add',
          '--once',
          '--channel',
          'telegram:' + OWNER,
          'Verify the synthetic task.',
        ]);
        expect(armed.code, armed.err).toBe(0);

        const readTurn = () =>
          inst.db(
            (db) =>
              db
                .prepare(`
          SELECT id, status, turn_outcome, delivery FROM turns WHERE job_id IS NOT NULL
        `)
                .get() as { id: string; status: string; delivery: string } | undefined,
          );
        const messages = () =>
          telegram.messages().filter((message) => message.text.includes(FINAL));
        if (uncertain) telegram.withholdNextSendResponse();
        const first = inst.spawnRaw(['gateway', 'run']);
        if (interrupted) {
          await until(() => inst.provider.main().length === 2, 12_000);
          expect(readFileSync(join(inst.workspace, FILE), 'utf8')).toBe(EVIDENCE);
          expect(readTurn()?.status).toBe('running');
        } else if (beforeSend) {
          await until(() => inst.provider.main().length === 1, 12_000);
          await until(() => readTurn()?.status === 'done', 12_000);
          expect(readTurn()?.delivery).toBe('pending');
          expect(messages()).toHaveLength(0);
        } else {
          await until(() => messages().length === 1, 12_000);
          expect(readTurn()).toMatchObject({ status: 'done', delivery: 'pending' });
        }
        const workId = readTurn()!.id;
        first.kill();
        expect(await first.exited).toBeNull();
        if (legacy) {
          // Recreate the state left by a gateway that accepted no journal
          // context. The external fixture still owns the first message.
          const db = new Database(join(inst.home, 'muffin.db'));
          try {
            db.transaction(() => {
              db.prepare(
                `UPDATE turns SET reply_to = json_remove(reply_to, '$.scheduledDeliveryVersion') WHERE id = ?`,
              ).run(workId);
              db.prepare('DELETE FROM telegram_delivery_parts WHERE turn_id = ?').run(workId);
            })();
          } finally {
            db.close();
          }
        }

        const restarted = await inst.gateway();
        await restarted.waitFor(/muffin gateway/, 12_000);
        await until(
          () => inst.db((db) => db.prepare('SELECT active FROM jobs').pluck().get() === 0),
          12_000,
        );
        expect(messages()).toEqual([{ chatId: OWNER, text: expect.stringContaining(FINAL) }]);
        expect(readTurn()).toMatchObject({
          id: workId,
          status: 'done',
          turn_outcome: 'answered',
          delivery,
        });
        expect(
          inst.db((db) =>
            db
              .prepare(`
          SELECT status FROM telegram_delivery_parts WHERE turn_id = ?
        `)
              .all(workId),
          ),
        ).toEqual(legacy ? [] : [{ status: delivery }]);
        expect(inst.db((db) => db.prepare('SELECT turn_id FROM job_fires').all())).toEqual([
          { turn_id: workId },
        ]);
        expect(inst.provider.main()).toHaveLength(interrupted ? 4 : 1);
        if (interrupted) {
          expect(readFileSync(join(inst.workspace, FILE), 'utf8')).toBe(EVIDENCE);
          expect(
            inst.db((db) =>
              db
                .prepare(`
            SELECT tool, is_error FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at, rowid
          `)
                .all(workId),
            ),
          ).toEqual([
            { tool: 'fs_write', is_error: 0 },
            { tool: 'fs_read', is_error: 0 },
          ]);
        }
        await restarted.stop();
      } finally {
        await inst.cleanup();
        await telegram.close();
      }
    },
    60_000,
  );
});
