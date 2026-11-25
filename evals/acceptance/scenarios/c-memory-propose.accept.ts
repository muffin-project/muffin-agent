import { describe, expect, it } from 'vitest';
import { seal } from '../../../core/rot/verify.js';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

describe('acceptance · intentional memory', () => {
  it.each([
    { object: 'lilla', producer: 'owner-stated', origin: 'said' },
    { object: 'ambra', producer: 'agent-inference', origin: 'inferred' },
  ])(
    'preserves the source and authority of a Telegram memory proposal ($producer)',
    async ({ object, producer, origin }) => {
      const owner = { id: 424242, name: 'Synthetic owner' };
      const instruction = 'Ricorda che il mio colore per le etichette è lilla.';
      const reply = 'Memory request processed.';
      let searched = false;
      let proposed = false;
      const inst = await install({
        main: (request) => {
          if (!proposed && request.tools.includes('memory_propose')) {
            proposed = true;
            return {
              tool: {
                name: 'memory_propose',
                args: {
                  subject: 'owner',
                  predicate: 'colore per le etichette',
                  object,
                  instruction,
                },
              },
            };
          }
          if (!proposed && !searched && request.tools.includes('capability_search')) {
            searched = true;
            return {
              tool: {
                name: 'capability_search',
                args: {
                  query: 'remember a fact intentionally from the owner instruction',
                  max_results: 5,
                },
              },
            };
          }
          return { text: reply };
        },
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
        telegram.deliver(privateMessage(owner, instruction));
        await until(() => telegram.messages().some((msg) => msg.text.includes(reply)), 15_000);

        const provider = inst.provider.main();
        expect(provider.some((request) => request.tools.includes('memory_propose'))).toBe(true);
        expect(provider.at(-1)?.transcript).toContain(
          `Ricordo: owner colore per le etichette ${object}`,
        );

        const readProposal = () =>
          inst.db(
            (db) =>
              db
                .prepare(`
            SELECT p.producer, p.origin, p.status, p.trust_tier AS tier,
                   e.connector, e.content AS source, f.id AS factId, f.origin AS factOrigin,
                   f.object_value AS value, f.expired_at AS expiredAt
            FROM memory_proposals p
            JOIN episodes e ON e.id = json_extract(p.source_episodes, '$[0]')
            JOIN facts f ON f.id = json_extract(p.resulting_fact_ids, '$[0]')
                        AND f.episode_id = e.id AND f.tenant_id = p.tenant_id
            WHERE p.tenant_id = 'host' AND e.tenant_id = p.tenant_id
          `)
                .all() as { factId: number }[],
          );
        const records = readProposal();
        expect(records).toEqual([
          expect.objectContaining({
            producer,
            origin,
            status: 'accepted',
            tier: 0,
            connector: 'telegram',
            source: instruction,
            factOrigin: origin,
            value: object,
            expiredAt: null,
          }),
        ]);
        await gateway.stop();
        const restarted = await inst.gateway();
        await restarted.waitFor(/muffin gateway/, 15_000);
        expect(readProposal()).toEqual(records);
        const why = await inst.muffin(['memory', 'why', String(records[0]?.factId)]);
        expect(why.code, why.err).toBe(0);
        expect(why.out).toContain(instruction);
        expect(why.out).toContain('telegram');
        expect(inst.provider.main()).toHaveLength(provider.length);
        expect(telegram.messages().filter((msg) => msg.text.includes(reply))).toHaveLength(1);
        await restarted.stop();
      } finally {
        await inst.cleanup();
        await telegram.close();
      }
    },
    60_000,
  );
});
