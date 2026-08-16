import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';

/**
 * B · Runtime continuity.
 *
 * B1 stands in for "CLI and Telegram share session and memory" with the part
 * of that claim the CLI alone can exercise honestly: no real Telegram bot is
 * reachable from here, but the mechanism the claim actually rests on —
 * `SessionStore` persisting a conversation's transcript to disk rather than
 * to process memory — is exactly as testable, and arguably the harder
 * property, since nothing at all survives the process boundary except the
 * files `--session` points at.
 */

describe('acceptance · B · continuità del runtime', () => {
  scenario(
    'B1',
    async () => {
      const inst = await install({
        main: [{ text: 'il tuo colore preferito è il verde, capito' }, { text: 'mi hai detto il verde' }],
      });
      try {
        const first = await inst.muffin(['run', '--session', 'continuity-1', '--timeout', '20', 'il mio colore preferito è il verde']);
        if (first.code !== 0) throw new Error(`primo processo: exit ${first.code}\n${first.err}`);

        // A second, unrelated process — nothing in common with the first but
        // the files under `inst.home` and the `--session` id.
        const second = await inst.muffin(['run', '--session', 'continuity-1', '--timeout', '20', 'che colore ho detto?']);
        if (second.code !== 0) throw new Error(`secondo processo: exit ${second.code}\n${second.err}`);

        const sentToSecondCall = inst.provider.main()[1];
        if (!sentToSecondCall) throw new Error('il secondo processo non ha mai chiamato il modello');

        // The literal transcript, not a recalled summary — and this distinction
        // is not academic: the first run of this scenario asserted only a
        // substring of `.transcript` and stayed green with `SessionStore.append`
        // mutated into a no-op, because `core/memory/recall.ts` independently
        // re-surfaces the same two lines as a "cose che ricordi" block folded
        // into the *new* user message. That is a real, useful property of
        // recall — and a reason this scenario has to check something recall
        // cannot produce: a literal, separate `role: 'assistant'` wire message
        // carrying the model's own prior reply, which only a persisted
        // multi-turn transcript ever assembles. Recall injects into the
        // current turn's user content; it does not fabricate a past assistant
        // turn.
        const assistantTurn = sentToSecondCall.messages.find(
          (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('il tuo colore preferito è il verde, capito'),
        );
        if (!assistantTurn) {
          throw new Error(
            `nessun messaggio role:assistant con la risposta del primo turno — SessionStore non ha ritrovato la sessione:\n${JSON.stringify(sentToSecondCall.messages, null, 2)}`,
          );
        }
        const priorUserTurn = sentToSecondCall.messages.find(
          (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('il mio colore preferito è il verde') && m !== sentToSecondCall.messages[sentToSecondCall.messages.length - 1],
        );
        if (!priorUserTurn) {
          throw new Error(
            `nessun messaggio role:user precedente con il primo turno letterale:\n${JSON.stringify(sentToSecondCall.messages, null, 2)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'B8',
    async () => {
      const inst = await install({ main: [{ text: 'ecco il tuo brief' }] });
      try {
        // A job addressed to a channel `muffin gateway run` cannot actually
        // reach yet (`cli/gateway.ts`'s own `gatewayDeliver`: only 'cli' is
        // wired — everything else is "consegna remota da cablare" on stderr).
        const added = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 8 * * *',
          '--channel',
          'telegram',
          'manda il brief',
        ]);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);

        // `jobs add` always computes the next fire in the future — the only way
        // to have a due job through the real CLI is to move the fire time back
        // by hand afterwards, exactly like cli/gateway.test.ts's own
        // `overdueJob` fixture does for the same reason.
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        let jobId: string;
        try {
          const row = db.prepare(`SELECT id FROM jobs LIMIT 1`).get() as { id: string } | undefined;
          if (!row) throw new Error('nessun job trovato dopo `jobs add`');
          jobId = row.id;
          db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), jobId);
        } finally {
          db.close();
        }

        // The real gateway process: `serve()` ticks once immediately at boot
        // (core/gateway/service.ts), specifically so a job that came due while
        // nothing was running fires without waiting out a full interval.
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/consegna remota da cablare/, 15_000);
        } finally {
          await gw.stop();
        }

        // The desired invariant a job "said sent" should have to earn: it is
        // only recorded as run if delivery actually reached the channel. Today
        // `Scheduler.run` calls `markRan` unconditionally after the delivery
        // attempt (core/scheduler/scheduler.ts), whether or not the channel
        // exists — so this reads `last_run_at` set even though nothing was
        // delivered anywhere an owner would see it.
        const after = new DatabaseCtor(join(inst.home, 'muffin.db'), { readonly: true });
        let lastRunAt: string | null;
        try {
          lastRunAt = (after.prepare(`SELECT last_run_at FROM jobs WHERE id = ?`).get(jobId) as { last_run_at: string | null })
            .last_run_at;
        } finally {
          after.close();
        }
        if (lastRunAt !== null) {
          throw new Error(
            `il job è marcato eseguito (last_run_at=${lastRunAt}) nonostante la consegna non sia mai arrivata al canale`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
