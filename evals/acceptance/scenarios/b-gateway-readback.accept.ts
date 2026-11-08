import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askRaw } from '../../../core/gateway/control-socket.js';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';

describe('acceptance · gateway turn read-back', () => {
  it(
    'reports the durable turn outcome without borrowing an older reply (#939)',
    async () => {
      const previousReply = 'previous turn reply';
      const currentReply = 'current turn reply';
      const request = 'Read the fixture and give me the current result.';
      const inst = await install({
        main: [
          { text: previousReply },
          { tool: { name: 'fs_read', args: { path: 'fixture.txt' } } },
          { text: currentReply },
        ],
      });
      try {
        writeFileSync(join(inst.workspace, 'fixture.txt'), 'synthetic fixture\n');
        const run = [
          'run',
          '--session',
          'read-back',
          '--timeout',
          String(HEADLESS_TURN_TIMEOUT_SECONDS),
        ];
        const first = await inst.muffin([...run, 'Give me the previous result.']);
        expect(first.code).toBe(0);
        expect(first.out).toContain(previousReply);
        const second = await inst.muffin([...run, request]);
        expect(second.code).toBe(0);
        expect(second.out).toContain(currentReply);
        const row = inst.db((db) =>
          db.prepare('SELECT id FROM turns WHERE input_text = ?').get(request),
        ) as { id: string };

        const gateway = await inst.gateway();
        try {
          await gateway.waitFor(/muffin gateway/, 15_000);
          const modelCalls = inst.provider.main().length;
          const result = await inst.muffin(['gateway', 'turn', row.id]);
          expect(result.code).toBe(0);
          expect(result.out.trim()).toBe(`turno ${row.id.slice(0, 12)}: answered`);
          expect(await askRaw(inst.home, { verb: 'query', id: row.id })).toMatchObject({
            found: true,
            status: 'done',
            stopped: 'answered',
            text: null,
            turnId: row.id,
          });
          expect(inst.provider.main()).toHaveLength(modelCalls);
        } finally {
          await gateway.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(2),
  );
});
