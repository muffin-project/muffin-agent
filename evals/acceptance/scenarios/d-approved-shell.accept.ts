import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { itConSandbox } from '../sandbox-host.js';
import { callbackQuery, privateMessage, startFakeTelegram } from '../telegram.js';

itConSandbox(
  'runs an approved shell command once and records its actual effect and output',
  async () => {
    const owner = { id: 424242, name: 'Synthetic owner' };
    const file = 'shell-calculation.txt';
    const command = 'printf "%s\\n" "$((19 + 23))" | tee shell-calculation.txt';
    const call = { tool: { name: 'shell_run_write', args: { command, cwd: '.' } } };
    const reply = 'The calculation is complete.';
    // A resumed turn must reissue the exact command to consume its approval.
    const inst = await install({
      main: [call, call, { text: reply }],
      env: { MUFFIN_GATEWAY_TICK_MS: '200' },
    });
    const telegram = await startFakeTelegram();
    try {
      expect((await inst.muffin(['model', 'embed', 'off'])).code).toBe(0);
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

      telegram.deliver(
        privateMessage(
          owner,
          'Use the shell to calculate 19 + 23 and save the output in shell-calculation.txt.',
        ),
      );
      type Keyboard = { inline_keyboard?: { callback_data: string }[][] };
      const approvalButton = () => {
        for (const message of telegram.sent()) {
          const keyboard = message.payload.reply_markup as Keyboard | undefined;
          const allow = keyboard?.inline_keyboard
            ?.flat()
            .find((button) => button.callback_data.startsWith('ok:'));
          const id = message.messageId ?? message.payload.message_id;
          if (allow && typeof id === 'number')
            return { callback: allow.callback_data, id, text: String(message.payload.text ?? '') };
        }
        return undefined;
      };
      await until(() => approvalButton() !== undefined, 15_000);
      const pending = approvalButton();
      if (!pending) throw new Error('the Telegram approval button is missing');
      const outputPath = join(inst.workspace, file);
      expect(existsSync(outputPath)).toBe(false);
      expect(
        inst.db((db) =>
          db
            .prepare("SELECT count(*) AS n FROM turn_tool_calls WHERE tool='shell_run_write'")
            .get(),
        ),
      ).toEqual({ n: 0 });

      telegram.deliver(
        callbackQuery(owner, pending.callback, {
          messageId: pending.id,
          chatId: owner.id,
          text: pending.text,
        }),
      );
      await until(
        () => telegram.sent().some((msg) => JSON.stringify(msg.payload).includes(reply)),
        15_000,
      );
      expect(readFileSync(outputPath, 'utf8')).toBe('42\n');
      const executions = inst.db((db) =>
        db
          .prepare(`
          SELECT is_error, ended_at, content FROM turn_tool_calls
          WHERE tool = 'shell_run_write' ORDER BY started_at, rowid
        `)
          .all(),
      );
      expect(executions).toEqual([
        expect.objectContaining({
          is_error: 0,
          ended_at: expect.any(String),
          content: expect.stringContaining('\n42\n'),
        }),
      ]);
      expect(
        inst.db((db) => db.prepare('SELECT decision, consumed_at FROM approvals').all()),
      ).toEqual([{ decision: 'allow', consumed_at: expect.any(String) }]);
      expect(inst.provider.main()).toHaveLength(3);
      await gateway.stop();
    } finally {
      await inst.cleanup();
      await telegram.close();
    }
  },
  60_000,
);
