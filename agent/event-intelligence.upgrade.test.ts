import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMuffinEventIntelligence, type EventWakePort } from './event-intelligence.js';

// Safety-only negative control. Not a real 0.11.0-produced Home and NOT
// proof of historical watch/receipt migration; track that under EI #426.
describe('Event Intelligence historical stored-state refusal', () => {
  it('does not change an unmarked populated Home or fabricate a v1 marker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-upgrade-block-'));
    const dataDir = join(home, 'event-intelligence');
    mkdirSync(dataDir);

    const triggerBytes = JSON.stringify({
      triggerId: 'legacy-watch',
      version: '1',
      clauses: [{ id: 'a', event: 'legacy.changed', where: [], arguments: {} }],
      pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
      withinMs: 60000,
    }) + '\n';
    const receiptBytes = JSON.stringify({
      wakeId: 'legacy-wake',
      triggerId: 'legacy-watch',
      matchId: 'legacy-match',
      runtime: 'muffin',
      status: 'delivered',
      runtimeReceiptId: 'legacy-host-receipt',
    }) + '\n';

    const triggerFile = join(dataDir, 'triggers.jsonl');
    const receiptFile = join(dataDir, 'wake-deliveries.jsonl');
    writeFileSync(triggerFile, triggerBytes);
    writeFileSync(receiptFile, receiptBytes);

    const port: EventWakePort = {
      source: () => null,
      has: () => false,
      openSession: (id) => ({ id, file: join(home, 'stub-session.jsonl') }),
      enqueue: () => { throw new Error('No wake may execute during upgrade preflight'); },
    };

    try {
      await expect(createMuffinEventIntelligence([], home, port))
        .rejects.toMatchObject({ code: 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE' });
      expect(readFileSync(triggerFile, 'utf8')).toBe(triggerBytes);
      expect(readFileSync(receiptFile, 'utf8')).toBe(receiptBytes);
      expect(existsSync(join(dataDir, 'pattern-v2-signature-contract.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
