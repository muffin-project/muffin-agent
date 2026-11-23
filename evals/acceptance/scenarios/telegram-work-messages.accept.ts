import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EXIT_STOPPED } from '../../../core/gateway/service.js';
import { seal } from '../../../core/rot/verify.js';
import { decodeWaitFor } from '../../../core/turns/wait.js';
import { type Install, install, until } from '../harness.js';
import type { ScriptedReply } from '../provider.js';
import { type FakeTelegram, startFakeTelegram } from '../telegram.js';

const CLI = join(import.meta.dirname, '../../../dist/cli/main.js');
const OWNER = 424242;
const BOT = { id: 42, is_bot: true, first_name: 'Muffin' }; // fake Telegram's getMe
const WORK_KEY = /^work:[a-f0-9]{64}$/;

async function withTelegram(
  main: ScriptedReply[],
  run: (inst: Install, telegram: FakeTelegram) => Promise<void>,
): Promise<void> {
  const inst = await install({ main });
  const telegram = await startFakeTelegram();
  try {
    mkdirSync(join(inst.home, 'models'), { recursive: true });
    writeFileSync(join(inst.home, 'models', 'ggml-base.bin'), 'unused text-only fixture');
    const secret = await inst.muffin(['secret', 'set', 'telegram_token'], '123:fixture-only');
    expect(secret.code, secret.err).toBe(0);
    const enable = await inst.muffin([
      'surface',
      'enable',
      'telegram',
      '--api-base',
      telegram.url,
      '--owner',
      String(OWNER),
    ]);
    expect(enable.code, enable.err).toBe(0);
    seal(inst.home, '1', new Date());
    await run(inst, telegram);
  } finally {
    await inst.cleanup();
    await telegram.close();
  }
}

async function withGateway(
  inst: Install,
  run: (kill: () => Promise<void>) => Promise<void>,
  ready = 'telegram: connesso',
): Promise<void> {
  const child = spawn(process.execPath, [CLI, 'gateway', 'run'], {
    cwd: inst.workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(inst.workspace, '..'),
      MUFFIN_HOME: inst.home,
      MUFFIN_WORKSPACE: inst.workspace,
      XDG_CONFIG_HOME: inst.xdg,
      MUFFIN_GATEWAY_TICK_MS: '200',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let killed = false;
  let log = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  try {
    await until(() => {
      if (child.exitCode !== null) throw new Error('Gateway exited before surface initialization');
      return log.includes(ready);
    });
    await run(async () => {
      killed = true;
      child.kill('SIGKILL');
      await closed;
    });
  } catch (error) {
    throw new Error(`${String(error)}\nGateway output:\n${log}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    await closed.finally(() => clearTimeout(timer));
  }
  if (killed) expect(child.signalCode, log).toBe('SIGKILL');
  else expect(child.exitCode, log).toBe(EXIT_STOPPED);
}

function dm(
  updateId: number,
  userId: number,
  messageId: number,
  text: string,
  reply?: { messageId: number; text: string },
) {
  const chat = { id: userId, type: 'private' };
  const date = Math.floor(Date.now() / 1000);
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date,
      chat,
      from: { id: userId, is_bot: false, first_name: 'Fixture user' },
      text,
      ...(reply && {
        reply_to_message: { message_id: reply.messageId, date, chat, from: BOT, text: reply.text },
      }),
    },
  };
}

type Turn = {
  id: string;
  input_text: string;
  status: string;
  wait_for: string | null;
  wake_at: string | null;
  turn_outcome: string | null;
  delivery: string | null;
};

function turns(inst: Install): Turn[] {
  const sql = 'SELECT id, input_text, status, wait_for, wake_at, turn_outcome, delivery FROM turns';
  return inst.db((db) => db.prepare(sql).all() as Turn[]);
}

function writeDb(inst: Install, write: (db: Database.Database) => void): void {
  const db = new Database(join(inst.home, 'muffin.db'), { fileMustExist: true });
  try {
    write(db);
  } finally {
    db.close();
  }
}

function deliveryParts(inst: Install) {
  const sql = `
    SELECT turn_id, operation, chat_id, status, telegram_message_id
    FROM telegram_delivery_parts ORDER BY rowid
  `;
  return inst.db((db) => db.prepare(sql).all() as { turn_id: string; status: string }[]);
}

function inbox(inst: Install) {
  const sql = `
    SELECT u.update_id, u.processed_at, u.failure, c.work_id
    FROM telegram_updates u LEFT JOIN telegram_compositions c USING (composition_id)
    ORDER BY u.update_id
  `;
  return inst.db(
    (db) => db.prepare(sql).all() as { update_id: number; processed_at: string | null }[],
  );
}

function bubbles(telegram: FakeTelegram) {
  return telegram
    .sent()
    .filter((call) => call.method === 'sendMessage')
    .map((call) => ({
      id: call.messageId,
      chatId: Number(call.payload.chat_id),
      text: String(call.payload.text),
    }));
}

function sentPart(key: string, messageId: number | undefined) {
  return {
    turn_id: key,
    operation: 'send',
    chat_id: OWNER,
    status: 'sent',
    telegram_message_id: messageId,
  };
}

describe('acceptance · Telegram messages during work', () => {
  it('stops owner-chat writes after an interim update when the binding is revoked', async () => {
    const note = 'I have compared the two shipping quotes.';
    const final = 'The final comparison is ready.';
    let revoke: (() => void) | undefined;
    await withTelegram(
      [
        { tool: { name: 'work_message', args: { text: note } } },
        {
          get text() {
            revoke?.();
            return final;
          },
          delayMs: 200,
        },
      ],
      async (inst, telegram) => {
        let wireBefore: number | undefined;
        revoke = () => {
          wireBefore = telegram.sent().length;
          writeFileSync(join(inst.home, 'rot', 'owner.json'), '{}\n');
        };
        await withGateway(inst, async () => {
          telegram.deliver(
            dm(101, OWNER, 101, 'Compare the shipping quotes and send me the result.'),
          );
          await until(
            () => turns(inst)[0]?.status === 'done' && turns(inst)[0]?.delivery !== 'pending',
          );
          expect(wireBefore).toBeDefined();
          expect(telegram.sent().slice(wireBefore)).toEqual([]);
          expect(bubbles(telegram)).toEqual([
            { id: expect.any(Number), chatId: OWNER, text: note },
          ]);
          expect(turns(inst)[0]?.delivery).toMatch(/^failed:/);
        });
      },
    );
  });

  it('sends a useful interim note and finishes from the one owner message', async () => {
    const request =
      'Which of these quotes is cheaper delivered: Oak at $80 plus $25 shipping, or Elm at $100 with shipping included?';
    const note = 'Oak has the lower sticker price. Shipping may reverse the comparison.';
    const final = 'Elm is cheaper delivered: $100 versus $105 for Oak.';
    let observeBeforeResult: (() => void) | undefined;
    await withTelegram(
      [
        { tool: { name: 'work_message', args: { text: note } } },
        {
          // Snapshot at the provider boundary before any final bytes can leave.
          // The result is delayed, but no assertion depends on the delay length.
          get text() {
            observeBeforeResult?.();
            return final;
          },
          delayMs: 100,
        },
      ],
      async (inst, telegram) => {
        const beforeResult: ReturnType<typeof bubbles>[] = [];
        observeBeforeResult = () => beforeResult.push(bubbles(telegram));

        await withGateway(inst, async () => {
          telegram.deliver(dm(101, OWNER, 101, request));
          await until(
            () => turns(inst)[0]?.delivery === 'sent' && inbox(inst)[0]?.processed_at != null,
          );
        });

        const sent = bubbles(telegram);
        expect(sent).toEqual([
          { id: expect.any(Number), chatId: OWNER, text: note },
          { id: expect.any(Number), chatId: OWNER, text: expect.stringContaining(final) },
        ]);
        expect(beforeResult).toEqual([[sent[0]]]);
        const rows = turns(inst);
        const [turn] = rows;
        expect(rows).toEqual([
          expect.objectContaining({
            input_text: request,
            status: 'done',
            wait_for: null,
            turn_outcome: 'answered',
            delivery: 'sent',
          }),
        ]);
        if (!turn) throw new Error('Original turn missing');
        expect(inbox(inst)).toEqual([
          { update_id: 101, processed_at: expect.any(String), failure: null, work_id: turn.id },
        ]);
        const parts = deliveryParts(inst);
        const workKey = parts[0]?.turn_id;
        expect(workKey).toMatch(WORK_KEY);
        if (workKey === undefined) throw new Error('Interim delivery plan missing');
        expect(parts).toEqual([sentPart(workKey, sent[0]?.id), sentPart(turn.id, sent[1]?.id)]);
        const calls = inst.provider.main();
        expect(calls).toHaveLength(2);
        expect(calls[0]?.tools).toContain('work_message');
        expect(calls[0]?.transcript).toContain(request);
        expect(calls[1]?.transcript).toContain('Work message sent.');
      },
    );
  }, 60_000);

  it.each(['confirmed', 'lost on crash', 'readable 502'] as const)(
    'resumes the same Work after a native reply (question receipt: %s)',
    async (receipt) => {
      const filename = 'pickup-notes.txt';
      const request = `Can you draft a pickup confirmation from ${filename}?`;
      const location = 'North counter';
      const question =
        receipt === 'confirmed'
          ? 'Which directory should I list for your pickup records?'
          : 'Which day should I put in the pickup confirmation?';
      const answer = receipt === 'confirmed' ? '/stop/archive' : 'Saturday, 12 December';
      const wrongAnswer = 'Sunday, 13 December';
      const final = `Pickup confirmation for the ${location}: ${answer}.`;
      await withTelegram(
        [
          { tool: { name: 'fs_read', args: { path: filename } } },
          { tool: { name: 'work_message', args: { text: question, wait_for_reply: true } } },
          { text: final },
        ],
        async (inst, telegram) => {
          writeFileSync(
            join(inst.workspace, filename),
            `Pickup location: ${location}. Day not yet chosen.\n`,
          );
          await withGateway(inst, async (kill) => {
            if (receipt === 'lost on crash') telegram.withholdNextSendResponse();
            if (receipt === 'readable 502') telegram.failNextAcceptedSendResponse();
            const status = {
              confirmed: 'sent',
              'lost on crash': 'attempting',
              'readable 502': 'possibly_sent',
            }[receipt];
            telegram.deliver(dm(101, OWNER, 101, request));
            await until(
              () =>
                turns(inst)[0]?.status === 'waiting' &&
                (receipt === 'lost on crash' || deliveryParts(inst)[0]?.status !== 'attempting') &&
                bubbles(telegram).some((bubble) => bubble.text.includes(question)),
            );
            expect(deliveryParts(inst)[0]?.status).toBe(status);
            if (receipt === 'lost on crash') await kill();
          });

          const rows = turns(inst);
          const [waiting] = rows;
          expect(rows).toEqual([
            expect.objectContaining({
              input_text: request,
              status: 'waiting',
              wake_at: expect.any(String),
            }),
          ]);
          if (!waiting) throw new Error('Original turn missing');
          const barrier = decodeWaitFor(waiting.wait_for);
          expect(barrier).toEqual({ kind: 'owner_reply', id: expect.any(String), question });
          if (barrier?.kind !== 'owner_reply')
            throw new Error('Missing durable owner-reply barrier');
          const questionKey = `work:${barrier.id}`;
          const questions = bubbles(telegram);
          const [asked] = questions;
          expect(questions).toEqual([
            { id: expect.any(Number), chatId: OWNER, text: expect.stringContaining(question) },
          ]);
          if (asked?.id === undefined) throw new Error('Question missing its native message ID');
          const target = { messageId: asked.id, text: asked.text };
          const questionPart =
            receipt === 'confirmed'
              ? sentPart(questionKey, target.messageId)
              : {
                  ...sentPart(questionKey, undefined),
                  status: 'possibly_sent',
                  telegram_message_id: null,
                };
          expect(inst.provider.main()).toHaveLength(2);
          expect(inst.provider.main()[1]?.tools).toContain('work_message');
          expect(inst.provider.main()[1]?.transcript).toContain(location);

          await withGateway(inst, async () => {
            // A message ID is scoped to its chat: seeing the same ID from another
            // private chat must not release the owner's waiting work.
            telegram.deliver(dm(102, OWNER + 1, 2000, wrongAnswer, target));
            await until(
              () => inbox(inst).find((row) => row.update_id === 102)?.processed_at != null,
            );
            expect(turns(inst)).toEqual([waiting]);
            expect(deliveryParts(inst)).toEqual([questionPart]);
            expect(bubbles(telegram)).toEqual([asked]);
            expect(inst.provider.main()).toHaveLength(2);

            telegram.deliver(dm(103, OWNER, 2001, answer, target));
            await until(
              () =>
                turns(inst).some((turn) => turn.id === waiting.id && turn.delivery === 'sent') &&
                inbox(inst)[0]?.processed_at != null,
            );
          });

          expect(turns(inst)).toEqual([
            expect.objectContaining({
              id: waiting.id,
              input_text: request,
              status: 'done',
              wait_for: null,
              turn_outcome: 'answered',
              delivery: 'sent',
            }),
          ]);
          expect(inbox(inst)).toEqual([
            {
              update_id: 101,
              processed_at: expect.any(String),
              failure: null,
              work_id: waiting.id,
            },
            { update_id: 102, processed_at: expect.any(String), failure: null, work_id: null },
            { update_id: 103, processed_at: expect.any(String), failure: null, work_id: null },
          ]);
          const sent = bubbles(telegram);
          expect(sent).toEqual([
            asked,
            { id: expect.any(Number), chatId: OWNER, text: expect.stringContaining(final) },
          ]);
          expect(deliveryParts(inst)).toEqual([questionPart, sentPart(waiting.id, sent[1]?.id)]);

          const calls = inst.provider.main();
          expect(calls).toHaveLength(3);
          const resumed = calls[2];
          if (!resumed) throw new Error('No model request for the resumed turn');
          expect(resumed.transcript).toContain(request);
          expect(resumed.transcript).toContain(location);
          expect(resumed.transcript).not.toContain(wrongAnswer);
          expect(resumed.transcript.split(answer)).toHaveLength(2);
          expect(
            resumed.messages.some(
              (message) =>
                message.role === 'user' && JSON.stringify(message.content).includes(answer),
            ),
          ).toBe(true);
        },
      );
    },
    75_000,
  );

  it('continues with an honest blocker when the question is refused on the wire', async () => {
    await withTelegram(
      [
        {
          tool: { name: 'work_message', args: { text: 'Which pickup day?', wait_for_reply: true } },
        },
        { text: 'The pickup day is still missing because my question could not be delivered.' },
      ],
      async (inst, telegram) => {
        await withGateway(inst, async () => {
          telegram.guasta('sendMessage', 400, 'Bad Request: synthetic rejection');
          telegram.deliver(dm(101, OWNER, 101, 'Draft the pickup confirmation.'));
          await until(() => turns(inst)[0]?.delivery === 'sent');
        });
        expect(turns(inst)).toHaveLength(1);
        expect(inst.provider.main()[1]?.transcript).toContain(
          'The owner has not seen it and has not answered',
        );
        expect(
          bubbles(telegram).filter((message) =>
            message.text.includes('The pickup day is still missing'),
          ),
        ).toHaveLength(1);
        expect(deliveryParts(inst).map((part) => part.status)).toEqual(['rejected', 'sent']);
      },
    );
  }, 75_000);

  async function recoverFinal(
    receipt: 'sent' | 'possibly_sent',
    revoke: 'no' | 'after crash' | 'before reconciliation',
  ) {
    const final = 'The selected pickup day is Saturday.';
    await withTelegram(
      [
        {
          tool: {
            name: 'work_message',
            args: { text: 'What day is pickup?', wait_for_reply: true },
          },
        },
        { text: final },
      ],
      async (inst, telegram) => {
        const revokeBinding = () => writeFileSync(join(inst.home, 'rot', 'owner.json'), '{}\n');
        const releaseReceipt = () =>
          writeDb(inst, (db) => db.exec('DROP TRIGGER hold_owner_final_receipt'));
        const expectReceipt = async () => {
          await until(() => turns(inst)[0]?.delivery !== 'pending');
          expect(turns(inst)[0]?.delivery).toBe(receipt);
        };
        await withGateway(inst, async (kill) => {
          telegram.deliver(dm(101, OWNER, 101, 'Draft my pickup confirmation.'));
          await until(
            () => turns(inst)[0]?.status === 'waiting' && deliveryParts(inst)[0]?.status === 'sent',
          );
          const asked = bubbles(telegram)[0];
          if (asked?.id === undefined) throw new Error('Question missing its native message ID');
          if (receipt === 'possibly_sent') telegram.withholdNextSendResponse();
          else {
            // Hold the scalar receipt behind the independently committed wire journal.
            writeDb(inst, (db) =>
              db.exec(`
              CREATE TRIGGER hold_owner_final_receipt BEFORE UPDATE OF delivery ON turns
              WHEN NEW.delivery = 'sent'
              BEGIN SELECT RAISE(IGNORE); END;
            `),
            );
          }
          telegram.deliver(
            dm(102, OWNER, 102, 'Saturday', { messageId: asked.id, text: asked.text }),
          );
          await until(
            () =>
              turns(inst)[0]?.status === 'done' &&
              turns(inst)[0]?.delivery === 'pending' &&
              deliveryParts(inst)[1]?.status === (receipt === 'sent' ? 'sent' : 'attempting') &&
              bubbles(telegram).some((bubble) => bubble.text.includes(final)),
          );
          if (revoke === 'before reconciliation') {
            revokeBinding();
            releaseReceipt();
            await expectReceipt();
          } else await kill();
        });
        if (revoke !== 'before reconciliation') {
          if (receipt === 'sent') releaseReceipt();
          if (revoke === 'after crash') revokeBinding();
          const wireBefore = telegram.sent().length;
          await withGateway(
            inst,
            expectReceipt,
            revoke === 'after crash' ? 'telegram: abilitata ma senza owner' : undefined,
          );
          if (revoke === 'after crash') expect(telegram.sent().slice(wireBefore)).toEqual([]);
        }
        expect(turns(inst)).toHaveLength(1);
        expect(inst.provider.main()).toHaveLength(2);
        expect(deliveryParts(inst).map((part) => part.status)).toEqual(['sent', receipt]);
        expect(bubbles(telegram).filter((message) => message.text.includes(final))).toHaveLength(1);
      },
    );
  }

  it.each([
    { receipt: 'possibly_sent', revoke: 'no' },
    { receipt: 'possibly_sent', revoke: 'after crash' },
    { receipt: 'sent', revoke: 'after crash' },
    { receipt: 'sent', revoke: 'before reconciliation' },
  ] as const)(
    'reconciles a $receipt final (revoke: $revoke)',
    ({ receipt, revoke }) => recoverFinal(receipt, revoke),
    90_000,
  );

  it.each(['rich rejection', 'first fallback', 'rate limit'] as const)(
    'stops new final wire attempts when the binding is revoked at %s',
    async (fault) => {
      const final = Array.from(
        { length: 12 },
        (_, i) => `Part ${i}: ${'pickup details '.repeat(45)}`,
      ).join('\n\n');
      await withTelegram(
        [
          {
            tool: {
              name: 'work_message',
              args: { text: 'What day is pickup?', wait_for_reply: true },
            },
          },
          { text: final },
        ],
        async (inst, telegram) => {
          await withGateway(inst, async () => {
            telegram.deliver(dm(101, OWNER, 101, 'Draft my pickup confirmation.'));
            await until(
              () =>
                turns(inst)[0]?.status === 'waiting' && deliveryParts(inst)[0]?.status === 'sent',
            );
            const asked = bubbles(telegram)[0];
            if (asked?.id === undefined) throw new Error('Question missing its native message ID');
            const wireBefore = telegram.sent().length;
            const rateLimited = fault === 'rate limit';
            telegram.guasta(
              'sendMessage',
              rateLimited ? 429 : 400,
              rateLimited ? 'Too Many Requests' : 'RICH_MESSAGE_INVALID',
            );
            telegram.beforeNextResponse(
              fault === 'first fallback' ? 'sendMessage' : 'sendRichMessage',
              () => {
                writeFileSync(join(inst.home, 'rot', 'owner.json'), '{}\n');
              },
            );
            telegram.deliver(
              dm(102, OWNER, 102, 'Saturday', { messageId: asked.id, text: asked.text }),
            );
            await until(
              () => turns(inst)[0]?.status === 'done' && turns(inst)[0]?.delivery !== 'pending',
            );
            expect(turns(inst)[0]?.delivery).toMatch(
              rateLimited ? /^failed:Telegram 429/ : /^failed:Work reply is no longer authorized/,
            );
            const wire = telegram
              .sent()
              .slice(wireBefore)
              .filter((call) => call.method === 'sendMessage');
            expect(wire).toHaveLength(fault === 'first fallback' ? 2 : 1);
            expect(wire[0]?.payload.rich_message).toBeDefined();
            const statuses = deliveryParts(inst)
              .slice(1)
              .map((part) => part.status);
            if (rateLimited) expect(statuses).toEqual(['pending']);
            else {
              expect(statuses.shift()).toBe('rejected');
              if (fault === 'first fallback') expect(statuses.shift()).toBe('sent');
              expect(statuses.length).toBeGreaterThan(0);
              expect(statuses.every((status) => status === 'pending')).toBe(true);
            }
          });
        },
      );
    },
    75_000,
  );

  it('discards a revoked owner’s DMs both during the wait and after terminal expiry', async () => {
    const final = 'The pickup is still missing a day.';
    await withTelegram(
      [
        {
          tool: {
            name: 'work_message',
            args: { text: 'What day is pickup?', wait_for_reply: true },
          },
        },
        { text: final },
      ],
      async (inst, telegram) => {
        await withGateway(inst, async () => {
          telegram.deliver(dm(101, OWNER, 101, 'Draft my pickup confirmation.'));
          await until(
            () => turns(inst)[0]?.status === 'waiting' && deliveryParts(inst)[0]?.status === 'sent',
          );
          const asked = bubbles(telegram)[0];
          if (asked?.id === undefined) throw new Error('Question missing its native message ID');
          const waiting = turns(inst)[0];
          const wireBefore = telegram.sent().length;
          writeFileSync(join(inst.home, 'rot', 'owner.json'), '{}\n');
          const revokedReply = 'Saturday — stale binding';
          telegram.deliver(
            dm(102, OWNER, 102, revokedReply, { messageId: asked.id, text: asked.text }),
          );
          await until(
            () =>
              turns(inst).length > 1 ||
              inbox(inst).find((row) => row.update_id === 102)?.processed_at != null,
          );
          expect(turns(inst)).toEqual([waiting]);
          expect(inst.provider.main()).toHaveLength(1);
          expect(inbox(inst)[1]).toEqual({
            update_id: 102,
            processed_at: expect.any(String),
            failure: null,
            work_id: null,
          });
          expect(
            inst.db((db) =>
              db
                .prepare('SELECT payload FROM telegram_updates WHERE update_id = 102')
                .pluck()
                .get(),
            ),
          ).toBe('{}');
          writeDb(inst, (db) => {
            expect(
              db
                .prepare('UPDATE turns SET wake_at = ? WHERE status = ?')
                .run('2000-01-01T00:00:00.000Z', 'waiting').changes,
            ).toBe(1);
          });
          await until(
            () =>
              turns(inst)[0]?.status === 'done' &&
              turns(inst)[0]?.delivery?.startsWith('failed:') === true,
          );
          const expired = turns(inst)[0];
          expect(expired?.wait_for).toBeNull();
          const lateReply = 'Sunday — too late and still revoked';
          telegram.deliver(
            dm(103, OWNER, 103, lateReply, { messageId: asked.id, text: asked.text }),
          );
          const processed = (id: number) =>
            inbox(inst).some((row) => row.update_id === id && row.processed_at !== null);
          await until(() => processed(103) || turns(inst).length > 1);
          expect(turns(inst)).toEqual([expired]);
          telegram.deliver(dm(104, OWNER, 104, '/pause'));
          await until(() => processed(104));
          expect(inst.provider.main()).toHaveLength(2);
          const transcripts = inst.provider
            .main()
            .map((call) => call.transcript)
            .join('\n');
          expect(transcripts).not.toContain(revokedReply);
          expect(transcripts).not.toContain(lateReply);
          expect(inbox(inst).slice(2)).toEqual(
            [103, 104].map((update_id) => ({
              update_id,
              processed_at: expect.any(String),
              failure: null,
              work_id: null,
            })),
          );
          expect(
            inst.db((db) =>
              db
                .prepare(
                  'SELECT payload FROM telegram_updates WHERE update_id IN (103, 104) ORDER BY update_id',
                )
                .pluck()
                .all(),
            ),
          ).toEqual(['{}', '{}']);
          expect(
            telegram
              .sent()
              .slice(wireBefore)
              .filter((call) =>
                /^(?:send(?:Rich)?Message(?:Draft)?|editMessageText|sendChatAction)$/.test(
                  call.method,
                ),
              ),
          ).toEqual([]);
        });
        expect(bubbles(telegram)).toHaveLength(1);
        expect(deliveryParts(inst)).toHaveLength(1);
      },
    );
  }, 75_000);
});
