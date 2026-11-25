import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { itConSandbox } from '../sandbox-host.js';
import { callbackQuery, privateMessage, startFakeTelegram } from '../telegram.js';

for (const writesFile of [true, false]) {
  itConSandbox(
    writesFile
      ? 'single shell menu writes once after approval and gateway restart'
      : 'single shell menu reports stdout from the read-only scope after restart',
    async () => {
      const owner = { id: 424242, name: 'Synthetic owner' };
      const file = 'totale-calcolo.txt';
      const inputFile = 'three-lines.txt';
      const inputText = 'North\nEast\nWest\n';
      const expected = writesFile ? '42' : '3';
      const effect = writesFile ? 'write_project' : 'read_only';
      const capability = writesFile ? 'sys.shell.write' : 'sys.shell';
      const command = writesFile
        ? 'printf "%s\\n" "$((19 + 23))" | tee totale-calcolo.txt'
        : "awk 'END { print NR }' three-lines.txt";
      const call = { tool: { name: 'shell', args: { effect, command, cwd: '.' } } };
      const reply = writesFile ? 'The calculation is complete.' : 'The file has three lines.';
      // The provider sees one tool. The approvals and receipts use the selected native capability.
      const inst = await install({
        main: [
          { tool: { name: 'capability_search', args: { query: 'shell', max_results: 2 } } },
          call,
          { text: reply },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      writeFileSync(join(inst.workspace, inputFile), inputText);
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
        let gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 15_000);

        telegram.deliver(
          privateMessage(
            owner,
            writesFile
              ? 'Esegui un comando da terminale per calcolare 19 + 23 e salva il totale in totale-calcolo.txt.'
              : 'Conta le righe del file three-lines.txt usando il terminale. Lascia il file intatto.',
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
              return {
                callback: allow.callback_data,
                id,
                text: String(message.payload.text ?? ''),
              };
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
              .prepare(
                "SELECT count(*) AS n FROM turn_tool_calls WHERE tool IN ('shell_run', 'shell_run_write')",
              )
              .get(),
          ),
        ).toEqual({ n: 0 });

        // Persist the suspended turn before replacing the actual gateway.
        await until(
          () =>
            inst.db((db) => db.prepare("SELECT 1 FROM turns WHERE status = 'waiting'").get()) !==
            undefined,
          15_000,
        );
        await gateway.stop();
        gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 15_000);
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
        if (writesFile) {
          expect(readFileSync(outputPath, 'utf8')).toBe('42\n');
        } else {
          expect(existsSync(outputPath)).toBe(false);
        }
        expect(readFileSync(join(inst.workspace, inputFile), 'utf8')).toBe(inputText);
        const executions = inst.db((db) =>
          db
            .prepare(`
          SELECT tool, is_error, ended_at, content FROM turn_tool_calls
          WHERE tool IN ('shell_run', 'shell_run_write') ORDER BY started_at, rowid
        `)
            .all(),
        );
        expect(executions).toEqual([
          expect.objectContaining({
            tool: writesFile ? 'shell_run_write' : 'shell_run',
            is_error: 0,
            ended_at: expect.any(String),
            content: expect.stringContaining(`\n${expected}\n`),
          }),
        ]);
        expect(
          inst.db((db) =>
            db.prepare('SELECT capability, decision, consumed_at FROM approvals').all(),
          ),
        ).toEqual([{ capability, decision: 'allow', consumed_at: expect.any(String) }]);
        const requests = inst.provider.main();
        expect(requests).toHaveLength(3);
        expect(requests[0]?.tools).not.toContain('shell_run_write');
        expect(requests[1]?.tools).toContain('shell');
        expect(requests[1]?.tools).not.toContain('shell_run');
        expect(requests[1]?.tools).not.toContain('shell_run_write');
        expect(
          requests[2]?.tools,
          'approved command missing on the first resumed provider request',
        ).toContain('shell');
        expect(requests[2]?.transcript).toContain(`\n${expected}\n`);
        await gateway.stop();
      } finally {
        await inst.cleanup();
        await telegram.close();
      }
    },
    60_000,
  );
}
