import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { startFakeTelegram } from '../telegram.js';

const OWNER = 424242;
const FINAL = 'Scheduled work verified and complete.';
const FILE = 'scheduled-evidence.txt';
const EVIDENCE = 'one settled write before interruption\n';

describe('acceptance · #949 · scheduled Telegram delivery', () => {
  /**
   * Load-bearing wiring for the lost-send scene (#949). Checked by hand once
   * on this worktree, then restored from a copy before any commit: replacing
   * `return connector.deliverTo(turn.id, address, text)` in `cli/surface.ts`
   * with a raw `api.sendMessage` that returns `'sent'` made
   * `reconciles lost send response` fail. The fixture then held two external
   * messages where the scene expects one. The legacy scene is not this proof:
   * it deletes the journal on purpose and still expects one message. There is
   * no production flag for the bypass.
   */
  it.each([
    'interrupted work',
    'before send',
    'lost send response',
    'legacy lost response',
    'suspended lost response',
    'revoked lost response',
    'revoked suspended lost response',
    'recurring suspended lost response',
  ] as const)(
    'reconciles %s without losing or repeating the final message',
    async (scene) => {
      const interrupted = scene === 'interrupted work';
      const beforeSend = scene === 'before send';
      const legacy = scene === 'legacy lost response';
      const recurring = scene === 'recurring suspended lost response';
      const revoked =
        scene === 'revoked lost response' || scene === 'revoked suspended lost response';
      const suspended =
        recurring ||
        scene === 'suspended lost response' ||
        scene === 'revoked suspended lost response';
      const destination = revoked ? OTHER : OWNER;
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
          : suspended
            ? [
                { tool: { name: 'wait', args: { seconds: 120, why: 'fixture wait' } } },
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
          ...(recurring ? ['--cron', '0 8 * * *'] : ['--once']),
          '--channel',
          'telegram:' + destination,
          'Verify the synthetic task.',
        ]);
        expect(armed.code, armed.err).toBe(0);
        const readSchedule = () =>
          inst.db(
            (db) =>
              db.prepare('SELECT active, next_fire_at FROM jobs').get() as {
                active: number;
                next_fire_at: string;
              },
          );
        if (recurring) {
          const db = new Database(join(inst.home, 'muffin.db'));
          try {
            db.prepare('UPDATE jobs SET next_fire_at = ?').run(
              new Date(Date.now() - 1_000).toISOString(),
            );
          } finally {
            db.close();
          }
        }
        const occurrence = readSchedule().next_fire_at;

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
        if (suspended) {
          await until(() => inst.provider.main().length === 1, 12_000);
          await until(
            () =>
              readTurn()?.status === 'waiting' &&
              (recurring
                ? readSchedule().next_fire_at !== occurrence
                : readSchedule().active === 0),
            12_000,
          );
          // The real wait has handed the fire to the lane. Advance only its
          // fixture deadline, without waiting two minutes in CI.
          const db = new Database(join(inst.home, 'muffin.db'));
          try {
            db.prepare('UPDATE turns SET wake_at = ? WHERE id = ?').run(
              new Date(Date.now() - 1_000).toISOString(),
              readTurn()!.id,
            );
          } finally {
            db.close();
          }
        }
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
        if (revoked) expect(partsOf(inst, workId)).toEqual([{ status: 'attempting' }]);
        const scheduleBeforeRestart = readSchedule();
        first.kill();
        expect(await first.exited).toBeNull();
        if (revoked) writeFileSync(join(inst.home, 'rot', 'owner.json'), '{}\n');
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
        if (!recurring) await until(() => readSchedule().active === 0, 12_000);
        if (suspended) {
          await vi.waitFor(() => expect(readTurn()?.delivery).toBe(delivery), { timeout: 5_000 });
        }
        if (recurring) {
          expect(scheduleBeforeRestart.active).toBe(1);
          expect(Date.parse(scheduleBeforeRestart.next_fire_at)).toBeGreaterThan(
            Date.parse(occurrence),
          );
          expect(readSchedule()).toEqual(scheduleBeforeRestart);
        }
        expect(messages()).toEqual([{ chatId: destination, text: expect.stringContaining(FINAL) }]);
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
        expect(inst.provider.main()).toHaveLength(interrupted ? 4 : suspended ? 2 : 1);
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

  // #949, the two routes the restart scenes above do not touch: a destination
  // that is not the owner's Telegram chat, and a route no surface serves.
  // The binary is the same one. Nothing here reimplements delivery.
  const OTHER = 777;
  const TICK_MS = 200;

  type Armed = {
    inst: Awaited<ReturnType<typeof install>>;
    telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  };

  async function arm(channel: string, flags: readonly string[] = []): Promise<Armed> {
    const inst = await install({
      env: { MUFFIN_GATEWAY_TICK_MS: String(TICK_MS) },
      main: [{ text: FINAL }],
    });
    const telegram = await startFakeTelegram();
    try {
      mkdirSync(join(inst.home, 'models'), { recursive: true });
      writeFileSync(join(inst.home, 'models', 'ggml-base.bin'), 'unused text-only fixture');
      const secret = await inst.muffin(['secret', 'set', 'telegram_token'], '123:fixture-only');
      if (secret.code !== 0) throw new Error(secret.err);
      const enabled = await inst.muffin([
        'surface',
        'enable',
        'telegram',
        '--api-base',
        telegram.url,
        '--owner',
        String(OWNER),
      ]);
      if (enabled.code !== 0) throw new Error(enabled.err);
      seal(inst.home, '1', new Date());
      const armed = await inst.muffin([
        'jobs',
        'add',
        '--once',
        ...flags,
        '--channel',
        channel,
        'Verify the synthetic task.',
      ]);
      if (armed.code !== 0) throw new Error(armed.err);
      return { inst, telegram };
    } catch (error) {
      await inst.cleanup();
      await telegram.close();
      throw error;
    }
  }

  type SettledTurn = {
    id: string;
    status: string;
    turn_outcome: string;
    delivery: string | null;
    channel: string;
    version: number | null;
  };

  function turnOf(inst: Armed['inst']): SettledTurn | undefined {
    return inst.db(
      (db) =>
        db
          .prepare(`
        SELECT id, status, turn_outcome, delivery,
               json_extract(reply_to, '$.channel') AS channel,
               json_extract(reply_to, '$.scheduledDeliveryVersion') AS version
        FROM turns WHERE job_id IS NOT NULL
      `)
          .get() as SettledTurn | undefined,
    );
  }

  function fireOf(
    inst: Armed['inst'],
  ): { turn_id: string; silent: number; settled_at: string | null }[] {
    return inst.db(
      (db) =>
        db.prepare('SELECT turn_id, silent, settled_at FROM job_fires').all() as {
          turn_id: string;
          silent: number;
          settled_at: string | null;
        }[],
    );
  }

  function partsOf(inst: Armed['inst'], turnId: string): { status: string }[] {
    return inst.db(
      (db) =>
        db.prepare('SELECT status FROM telegram_delivery_parts WHERE turn_id = ?').all(turnId) as {
          status: string;
        }[],
    );
  }

  const finals = (telegram: Armed['telegram']) =>
    telegram.messages().filter((message) => message.text.includes(FINAL));

  async function untilSettled(inst: Armed['inst']): Promise<SettledTurn> {
    await until(() => {
      const turn = turnOf(inst);
      const fire = fireOf(inst)[0];
      return turn?.status === 'done' && fire?.settled_at != null;
    }, 12_000);
    const turn = turnOf(inst);
    if (turn === undefined) throw new Error('turno schedulato assente dopo il settlement');
    return turn;
  }

  /** Long enough for several gateway ticks to have tried a second send. */
  async function holdQuiet(): Promise<void> {
    const started = Date.now();
    const waitMs = TICK_MS * 6;
    await until(() => Date.now() - started >= waitMs, waitMs + 2_000);
  }

  async function withGateway(
    armed: Armed,
    check: (gateway: Awaited<ReturnType<Armed['inst']['gateway']>>) => Promise<void>,
  ): Promise<void> {
    const gateway = await armed.inst.gateway();
    try {
      await gateway.waitFor(/muffin gateway/, 12_000);
      await check(gateway);
    } finally {
      await gateway.stop();
    }
  }

  it('delivers one normal Telegram result, and a restart does not send it again', async () => {
    const armed = await arm('telegram:' + OWNER);
    try {
      let turn: SettledTurn | undefined;
      await withGateway(armed, async () => {
        await until(() => finals(armed.telegram).length === 1, 12_000);
        turn = await untilSettled(armed.inst);
      });
      expect(turn).toMatchObject({
        status: 'done',
        turn_outcome: 'answered',
        delivery: 'sent',
        channel: 'telegram:' + OWNER,
        version: 1,
      });
      expect(finals(armed.telegram)).toEqual([
        { chatId: OWNER, text: expect.stringContaining(FINAL) },
      ]);
      expect(partsOf(armed.inst, turn!.id)).toEqual([{ status: 'sent' }]);
      expect(armed.inst.provider.main()).toHaveLength(1);
      expect(armed.inst.db((db) => db.prepare('SELECT active FROM jobs').get())).toEqual({
        active: 0,
      });

      await withGateway(armed, async () => {
        await holdQuiet();
      });
      expect(finals(armed.telegram)).toHaveLength(1);
      expect(turnOf(armed.inst)?.delivery).toBe('sent');
      expect(armed.inst.provider.main()).toHaveLength(1);
    } finally {
      await armed.inst.cleanup();
      await armed.telegram.close();
    }
  }, 45_000);

  it('delivers a scheduled result on the CLI without a Telegram journal or a second copy', async () => {
    const armed = await arm('cli');
    try {
      let stdout = '';
      await withGateway(armed, async (gateway) => {
        await until(() => gateway.stdout().includes(FINAL), 12_000);
        await untilSettled(armed.inst);
        stdout = gateway.stdout();
      });
      expect(stdout).toContain(`⏰ ${FINAL}`);
      expect(finals(armed.telegram)).toEqual([]);
      expect(turnOf(armed.inst)).toMatchObject({
        status: 'done',
        turn_outcome: 'answered',
        delivery: 'sent',
        channel: 'cli',
        version: null,
      });
      expect(partsOf(armed.inst, turnOf(armed.inst)!.id)).toEqual([]);
      expect(armed.inst.provider.main()).toHaveLength(1);

      await withGateway(armed, async (gateway) => {
        await holdQuiet();
        expect(gateway.stdout()).not.toContain(FINAL);
      });
      expect(finals(armed.telegram)).toEqual([]);
      expect(turnOf(armed.inst)?.delivery).toBe('sent');
      expect(armed.inst.provider.main()).toHaveLength(1);
    } finally {
      await armed.inst.cleanup();
      await armed.telegram.close();
    }
  }, 45_000);

  it.each([
    { channel: `telegram:${OTHER}`, threadId: undefined },
    { channel: `telegram:0${OTHER}#013`, threadId: 13 },
  ])(
    'delivers a scheduled result to another Telegram chat, once ($channel)',
    async ({ channel, threadId }) => {
      const armed = await arm(channel);
      try {
        await withGateway(armed, async () => {
          await until(() => finals(armed.telegram).length === 1, 12_000);
          await untilSettled(armed.inst);
        });
        expect(finals(armed.telegram)).toEqual([
          { chatId: OTHER, text: expect.stringContaining(FINAL) },
        ]);
        expect(turnOf(armed.inst)).toMatchObject({
          delivery: 'sent',
          channel,
          version: 1,
        });
        expect(partsOf(armed.inst, turnOf(armed.inst)!.id)).toEqual([{ status: 'sent' }]);
        expect(
          armed.telegram.sent().find((call) => call.method === 'sendMessage')?.payload
            .message_thread_id,
        ).toBe(threadId);
        expect(armed.inst.provider.main()).toHaveLength(1);

        await withGateway(armed, async () => {
          await holdQuiet();
        });
        expect(finals(armed.telegram)).toHaveLength(1);
        expect(armed.inst.provider.main()).toHaveLength(1);
      } finally {
        await armed.inst.cleanup();
        await armed.telegram.close();
      }
    },
    45_000,
  );

  it('stops retries of an explicit scheduled send after owner binding revocation', async () => {
    const armed = await arm('telegram:' + OTHER);
    try {
      let revoked = false;
      armed.telegram.guasta('sendMessage', 429, 'Too Many Requests');
      armed.telegram.beforeNextResponse('sendRichMessage', () => {
        writeFileSync(join(armed.inst.home, 'rot', 'owner.json'), '{}\n');
        revoked = true;
      });
      await withGateway(armed, async () => {
        const turn = await untilSettled(armed.inst);
        expect(turn.delivery).toMatch(/^failed:.*owner binding/);
        expect(partsOf(armed.inst, turn.id).some((part) => part.status === 'sent')).toBe(false);
      });
      const wire = armed.telegram.sent().filter((call) => call.method === 'sendMessage');
      expect(wire).toHaveLength(1);
      expect(wire[0]?.payload.chat_id).toBe(OTHER);
      expect(revoked).toBe(true);
      expect(armed.inst.provider.main()).toHaveLength(1);
    } finally {
      await armed.inst.cleanup();
      await armed.telegram.close();
    }
  }, 45_000);

  it.each(['pager:1', 'telegram:not-a-chat'] as const)(
    'records one failed delivery for %s and does not call the model again',
    async (channel) => {
      const armed = await arm(channel);
      try {
        let why = '';
        await withGateway(armed, async (gateway) => {
          await until(() => gateway.stderr().includes('consegna fallita'), 12_000);
          const turn = await untilSettled(armed.inst);
          why = turn.delivery ?? '';
        });
        expect(why.startsWith('failed:')).toBe(true);
        expect(why).toContain(`nessuna superficie serve "${channel}"`);
        expect(finals(armed.telegram)).toEqual([]);
        expect(partsOf(armed.inst, turnOf(armed.inst)!.id)).toEqual([]);
        expect(armed.inst.provider.main()).toHaveLength(1);
        expect(armed.inst.db((db) => db.prepare('SELECT active FROM jobs').get())).toEqual({
          active: 0,
        });
        const calls = armed.inst.provider.main().length;

        await withGateway(armed, async () => {
          await holdQuiet();
        });
        expect(turnOf(armed.inst)?.delivery).toBe(why);
        expect(finals(armed.telegram)).toEqual([]);
        expect(armed.inst.provider.main()).toHaveLength(calls);
      } finally {
        await armed.inst.cleanup();
        await armed.telegram.close();
      }
    },
    45_000,
  );

  it('keeps a quiet success quiet, including after a restart', async () => {
    const armed = await arm('telegram:' + OWNER, ['--silent']);
    try {
      await withGateway(armed, async (gateway) => {
        await untilSettled(armed.inst);
        await holdQuiet();
        expect(gateway.stdout()).not.toContain(FINAL);
      });
      expect(finals(armed.telegram)).toEqual([]);
      expect(turnOf(armed.inst)).toMatchObject({
        status: 'done',
        turn_outcome: 'answered',
        delivery: 'pending',
        channel: 'telegram:' + OWNER,
        version: 1,
      });
      expect(fireOf(armed.inst)).toEqual([
        expect.objectContaining({ silent: 1, turn_id: turnOf(armed.inst)!.id }),
      ]);
      expect(partsOf(armed.inst, turnOf(armed.inst)!.id)).toEqual([]);
      expect(armed.inst.provider.main()).toHaveLength(1);

      await withGateway(armed, async (gateway) => {
        await holdQuiet();
        expect(gateway.stdout()).not.toContain(FINAL);
      });
      expect(finals(armed.telegram)).toEqual([]);
      expect(turnOf(armed.inst)?.delivery).toBe('pending');
      expect(armed.inst.provider.main()).toHaveLength(1);
    } finally {
      await armed.inst.cleanup();
      await armed.telegram.close();
    }
  }, 45_000);
});
