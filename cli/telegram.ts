import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { paths, readSecret, ConfigError } from '../core/config/config.js';
import { TelegramApi } from '../connectors/telegram/api.js';
import { TelegramConnector } from '../connectors/telegram/connector.js';
import { sendDocument } from '../connectors/telegram/media.js';
import { UpdateInbox } from '../connectors/telegram/updates.js';
import { Vault } from '../core/vault/vault.js';

/**
 * `muffin telegram` — the connector as a process you start, watch and stop.
 *
 * It is a surface, not a mode: the same loop, the same memory, the same kernel.
 * Talking to the bot and typing in the terminal reach the same agent with the
 * same history, which is the property the whole "one engine" decision exists
 * for — and the one that would quietly stop being true if this file grew its own
 * notion of a session.
 */

export const TELEGRAM_USAGE = `usage:
  muffin telegram run          avvia il connector (long polling, Ctrl+C per fermare)
  muffin telegram status       cosa c'è in coda e cosa è fallito
  muffin telegram send <file> [--caption "..."]
`;

const OWNER_ENV = 'MUFFIN_TELEGRAM_OWNER_CHAT';

export async function cmdTelegramRun(home: string): Promise<number> {
  const { buildRuntime } = await import('../agent/runtime.js');

  let token: string;
  try {
    token = readSecret('secret://telegram_token', home);
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    process.stderr.write(
      `  → prendi un token da @BotFather, poi:\n` +
        `    echo -n "<token>" | muffin secret set telegram_token\n`,
    );
    return 78;
  }

  const ownerChatId = Number(process.env[OWNER_ENV]);
  if (!Number.isInteger(ownerChatId) || ownerChatId === 0) {
    // Refused rather than defaulted: without it every message is a stranger's,
    // which is safe but useless, or — far worse under a different default —
    // every message is the owner's.
    process.stderr.write(
      `serve ${OWNER_ENV}: l'id della chat che parla come owner.\n` +
        `  → scrivi al bot, poi \`muffin telegram status\` te lo mostra\n`,
    );
    return 78;
  }

  const runtime = buildRuntime(home);
  const api = new TelegramApi(token);
  const inbox = new UpdateInbox(new DatabaseCtor(paths(home).db));
  const controller = new AbortController();

  const vaultRoot = paths(home).vault;
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
  const vault = new Vault(runtime.memory.store, vaultRoot);

  const connector = new TelegramConnector({
    loop: runtime.deps,
    sessions: runtime.deps.sessions,
    inbox,
    api,
    vault: {
      root: vaultRoot,
      // The tier travels from the sender: a file from a group member is tier-2
      // evidence, and stays tier-2 through every later reindex because the vault
      // keys trust on content rather than on the path.
      reindex: (defaultTier) =>
        vault.reindex('host', { defaultTier, vectors: runtime.memory.recall.vectors }),
    },
    config: { token, ownerChatId },
    log: (line) => process.stderr.write(`${line}\n`),
  });

  // Ctrl+C stops the poll rather than killing it: an interrupted `getUpdates`
  // that never releases the token leaves the next process fighting a 409 with a
  // ghost.
  const onSignal = (): void => {
    process.stderr.write(`\nchiudo il polling…\n`);
    connector.stop();
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await connector.run(controller.signal);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    runtime.close();
  }
}

/**
 * Sends a file to the owner's chat.
 *
 * Deliberately a command the owner runs, not a tool the model calls. Sending is
 * an outward action, and outward actions are the one class this project gates
 * behind a human — the agent gets that capability when the outward module exists
 * with its approval path, not as a side effect of the transport being able to.
 *
 * It also exercises the multipart path, which is the one part of "no library"
 * that a wrapper is usually kept around for.
 */
export async function cmdTelegramSend(home: string, file: string, caption?: string): Promise<number> {
  const full = resolve(file);
  if (!existsSync(full) || !statSync(full).isFile()) {
    process.stderr.write(`non è un file: ${file}\n`);
    return 78;
  }
  const bytes = statSync(full).size;
  if (bytes > 50 * 1024 * 1024) {
    process.stderr.write(`${(bytes / 1e6).toFixed(1)}MB, oltre il limite di 50MB in upload\n`);
    return 78;
  }

  let token: string;
  try {
    token = readSecret('secret://telegram_token', home);
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    return 78;
  }
  const ownerChatId = Number(process.env[OWNER_ENV]);
  if (!Number.isInteger(ownerChatId) || ownerChatId === 0) {
    process.stderr.write(`serve ${OWNER_ENV}\n`);
    return 78;
  }

  try {
    await sendDocument(new TelegramApi(token), ownerChatId, full, {
      ...(caption ? { caption } : {}),
    });
    process.stdout.write(`inviato ${basename(full)} (${Math.round(bytes / 1024)}KB)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function cmdTelegramStatus(home: string): number {
  const db = new DatabaseCtor(paths(home).db, { readonly: true });
  try {
    const has = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='telegram_updates'`)
      .get() as { n: number };
    if (has.n === 0) {
      process.stderr.write(`il connector non è mai partito su questa installazione\n`);
      return 1;
    }

    const stats = db
      .prepare(
        `SELECT count(*) AS total,
                sum(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS pending,
                sum(CASE WHEN failure IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM telegram_updates`,
      )
      .get() as { total: number; pending: number | null; failed: number | null };
    const offset = db.prepare(`SELECT next_offset AS o FROM telegram_offset WHERE connector = 'telegram'`).get() as
      | { o: number }
      | undefined;

    process.stdout.write(
      `${stats.total} update ricevuti · ${stats.pending ?? 0} da processare · ${stats.failed ?? 0} falliti\n` +
        `prossimo offset: ${offset?.o ?? 0}\n`,
    );

    // The chat ids seen, so the owner can find their own without reading JSON.
    const chats = db
      .prepare(
        `SELECT DISTINCT json_extract(payload, '$.message.chat.id') AS id,
                json_extract(payload, '$.message.chat.type') AS type
         FROM telegram_updates WHERE id IS NOT NULL LIMIT 10`,
      )
      .all() as { id: number; type: string }[];
    if (chats.length > 0) {
      process.stdout.write(`\nchat viste:\n`);
      for (const c of chats) process.stdout.write(`  ${c.id}  ${c.type}\n`);
      process.stdout.write(`\n(l'owner è quella in ${OWNER_ENV})\n`);
    }

    for (const row of db
      .prepare(`SELECT update_id, failure FROM telegram_updates WHERE failure IS NOT NULL LIMIT 5`)
      .all() as { update_id: number; failure: string }[]) {
      process.stdout.write(`  ! ${row.update_id}: ${row.failure}\n`);
    }
    return (stats.failed ?? 0) > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
