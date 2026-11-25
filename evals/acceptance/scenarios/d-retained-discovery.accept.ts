import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

it('keeps a discovered delivery tool after a second search and delivers the artifact', async () => {
  const owner = { id: 424242, name: 'Synthetic owner' };
  const path = 'fixture-report.md';
  const content = '# Fixture result\n\nThe gateway is running.\n';
  const reply = 'The report is attached.';
  const inst = await install({
    main: [
      { tool: { name: 'capability_search', args: { query: 'send_file', max_results: 1 } } },
      { tool: { name: 'capability_search', args: { query: 'sys_inspect', max_results: 1 } } },
      { tool: { name: 'sys_inspect', args: {} } },
      { tool: { name: 'fs_write', args: { path, content } } },
      { tool: { name: 'send_file', args: { path } } },
      { text: reply },
    ],
    env: { MUFFIN_GATEWAY_TICK_MS: '200' },
  });
  const telegram = await startFakeTelegram();
  try {
    expect((await inst.muffin(['model', 'embed', 'off'])).code).toBe(0);
    expect((await inst.muffin(['secret', 'set', 'telegram_token'], '123:fixture-only')).code).toBe(
      0,
    );
    const connected = await inst.muffin([
      'surface',
      'enable',
      'telegram',
      '--api-base',
      telegram.url,
      '--owner',
      String(owner.id),
    ]);
    expect(connected.code, connected.err).toBe(0);
    seal(inst.home, '1', new Date());
    const gateway = await inst.gateway();
    await gateway.waitFor(/muffin gateway/, 15_000);
    telegram.deliver(
      privateMessage(
        owner,
        'Scrivi un breve promemoria su come sta funzionando Muffin e allegalo in questa chat.',
      ),
    );
    await until(
      () => telegram.sent().some((call) => JSON.stringify(call.payload).includes(reply)),
      15_000,
    );

    expect(readFileSync(join(inst.workspace, path), 'utf8')).toBe(content);
    expect(telegram.documents()).toEqual([
      expect.objectContaining({
        chatId: owner.id,
        filename: path,
        bytes: Buffer.byteLength(content),
      }),
    ]);
    const requests = inst.provider.main();
    expect(requests).toHaveLength(6);
    expect(requests[2]?.tools).toEqual(expect.arrayContaining(['sys_inspect', 'send_file']));
    expect(requests[4]?.tools).toContain('send_file');
    expect(requests[4]?.transcript).toContain('fixture-report.md');
    await gateway.stop();
  } finally {
    await inst.cleanup();
    await telegram.close();
  }
}, 60_000);
