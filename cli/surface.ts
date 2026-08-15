import DatabaseCtor from 'better-sqlite3';
import { generatePairingCode, startPairing } from '../core/config/pairing.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../agent/runtime.js';
import {
  loadConfig,
  paths,
  readSecret,
  saveConfig,
  ConfigError,
} from '../core/config/config.js';
import { TelegramApi } from '../connectors/telegram/api.js';
import { TelegramConnector } from '../connectors/telegram/connector.js';
import { UpdateInbox } from '../connectors/telegram/updates.js';

/**
 * Surfaces are enabled, not launched.
 *
 * `muffin telegram run` was wrong twice over. As a verb: talking to your agent
 * is not a subcommand, and every mechanism that grew its own imperative buried
 * `muffin` — the thing you actually type — under operator plumbing. As a
 * process: ADR-0022 prescribes a single process, and a connector you launch
 * separately is a second one.
 *
 * So the shape is the one ADR-0021 already wrote: a registry. A surface is
 * *enabled* once, and from then on it is connected whenever Muffin is running —
 * `muffin` starts the REPL in the foreground and every enabled surface inside
 * the same process. The verbs that remain under `muffin surface` are operator
 * verbs about the registry, not ways of running the agent.
 */

export const SURFACE_USAGE = `usage:
  muffin surface list                     le superfici e il loro stato
  muffin surface enable telegram [--owner <chat-id>]
  muffin surface disable telegram
`;

export function cmdSurfaceList(home: string): number {
  const config = loadConfig(home);
  const lines: string[] = [];

  for (const id of ['cli', 'telegram']) {
    const enabled = config.surfaces.enabled.includes(id);
    const isDefault = config.surfaces.default === id;
    let detail = '';

    if (id === 'telegram') {
      const token = hasSecret('secret://telegram_token', home);
      const owner = config.surfaces.telegram?.ownerChatId;
      if (enabled) {
        detail = ` · token ${token ? 'presente' : 'MANCANTE'} · owner ${owner ?? 'MANCANTE'}`;
        const stats = inboxStats(home);
        if (stats) detail += ` · ${stats.pending} in coda${stats.failed > 0 ? ` · ${stats.failed} falliti` : ''}`;
      } else {
        detail = token ? ' · token presente, abilitala con `muffin surface enable telegram`' : '';
      }
    }

    lines.push(`${enabled ? '●' : '○'} ${id.padEnd(10)}${isDefault ? ' (default)' : ''}${detail}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Enabling Telegram is the onboarding, in one idempotent command.
 *
 * It verifies the token against the real server (`getMe`), finds the owner chat
 * — from `--owner`, or from the chats the bot has already seen — and writes the
 * config. Run it before messaging the bot and it tells you the missing step;
 * run it again after and it finishes. No environment variable: the owner chat
 * id is configuration, and configuration lives in the config.
 */
export async function cmdSurfaceEnable(home: string, id: string, ownerFlag?: string): Promise<number> {
  if (id === 'cli') {
    process.stderr.write(`la CLI è sempre abilitata\n`);
    return 0;
  }
  if (id !== 'telegram') {
    process.stderr.write(`superficie sconosciuta: ${id}\n${SURFACE_USAGE}`);
    return 78;
  }

  let token: string;
  try {
    token = readSecret('secret://telegram_token', home);
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    process.stderr.write(`  → prendi un token da @BotFather, poi:\n    echo -n "<token>" | muffin secret set telegram_token\n`);
    return 78;
  }

  // Against the real server, now: a bad token should fail here, in the command
  // whose job is configuration, not tonight when the surface tries to connect.
  const api = new TelegramApi(token);
  const me = await api.getMe();

  const config = loadConfig(home);
  let ownerChatId = config.surfaces.telegram?.ownerChatId;
  let ownerUserId = config.surfaces.telegram?.ownerUserId;

  if (ownerFlag !== undefined) {
    const parsed = Number(ownerFlag);
    if (!Number.isInteger(parsed) || parsed === 0) {
      // A *user* id now, not a chat id: the escape hatch for someone who
      // already knows theirs and does not want the round trip.
      process.stderr.write(`--owner deve essere una user id numerica\n`);
      return 78;
    }
    ownerUserId = parsed;
    ownerChatId = parsed; // in a private chat the two coincide
  }

  /**
   * Pairing, not election.
   *
   * This used to make the owner whoever had messaged the bot first — and the
   * bot's username is discoverable, so you only had to arrive before the owner
   * did. A code printed here and echoed to the bot binds "whoever holds this
   * machine" to "whoever holds that account", which is a claim nothing else in
   * the system can make. Ten minutes, one use, five wrong guesses and it burns.
   */
  let pairing = config.surfaces.telegram?.pairing;
  if (ownerUserId === undefined) {
    const code = generatePairingCode();
    pairing = startPairing(code, new Date());
    // The one secret in this system deliberately shown to a human: the file
    // gets the digest, the plaintext exists only on this screen.
    process.stderr.write(`\n  @${me.username ?? me.id} è raggiungibile.\n\n`);
    process.stderr.write(`  Mandagli questo codice dal tuo account, entro 10 minuti:\n\n`);
    process.stderr.write(`      ${code}\n\n`);
    process.stderr.write(`  Fino ad allora nessuno è l'owner — chi scrive è uno sconosciuto.\n\n`);
  }

  const next = {
    ...config,
    surfaces: {
      ...config.surfaces,
      enabled: config.surfaces.enabled.includes('telegram')
        ? config.surfaces.enabled
        : [...config.surfaces.enabled, 'telegram'],
      // All three, or the code printed above would be generated and thrown
      // away — the message on screen promising a pairing that nothing stored.
      telegram: {
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
        ...(ownerChatId === undefined ? {} : { ownerChatId }),
        ...(pairing === undefined ? {} : { pairing }),
      },
    },
  };
  saveConfig(next, home);
  process.stdout.write(`telegram abilitata: @${me.username ?? me.id}, owner ${ownerChatId}\n`);
  process.stdout.write(`si connette al prossimo \`muffin\`\n`);
  return 0;
}

export function cmdSurfaceDisable(home: string, id: string): number {
  if (id === 'cli') {
    // L0-1: the CLI is the surface of last resort and cannot be turned off.
    process.stderr.write(`la CLI non si disabilita: è la superficie di ultima istanza\n`);
    return 78;
  }
  const config = loadConfig(home);
  if (!config.surfaces.enabled.includes(id)) {
    process.stderr.write(`${id} non è abilitata\n`);
    return 1;
  }
  saveConfig(
    { ...config, surfaces: { ...config.surfaces, enabled: config.surfaces.enabled.filter((s) => s !== id) } },
    home,
  );
  process.stdout.write(`${id} disabilitata\n`);
  return 0;
}

/**
 * Connects every enabled surface, inside this process.
 *
 * Called by the REPL and by headless serve alike. Returns the stops, and a line
 * per surface for the prompt — including the surface that *should* be up and is
 * not, because a surface silently missing is how "Muffin non risponde su
 * Telegram" becomes a mystery instead of a line of output.
 */
export function connectSurfaces(runtime: Runtime, home: string): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const stops: (() => void)[] = [];

  if (runtime.config.surfaces.enabled.includes('telegram')) {
    try {
      const token = readSecret('secret://telegram_token', home);
      const tg = runtime.config.surfaces.telegram;
      const ownerUserId = tg?.ownerUserId;
      const ownerChatId = tg?.ownerChatId;
      // Unpaired but with a code outstanding is a legitimate running state: the
      // surface has to be up to receive the code. What it must not do is treat
      // anyone as the owner while it waits.
      if (ownerUserId === undefined && tg?.pairing === undefined) {
        lines.push('telegram: abilitata ma senza owner — `muffin surface enable telegram`');
      } else {
        const api = new TelegramApi(token);
        const inbox = new UpdateInbox(new DatabaseCtor(paths(home).db));
        const vaultRoot = paths(home).vault;
        mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
        // The runtime's own vault, not a second one: `document_read` reads
        // through that instance, and a connector indexing into a different root
        // would produce documents the model cannot open.
        const vault = runtime.vault;

        const connector = new TelegramConnector({
          loop: runtime.deps,
          sessions: runtime.deps.sessions,
          inbox,
          api,
          vault: {
            root: vaultRoot,
            reindex: (defaultTier) =>
              vault.reindex('host', { defaultTier, vectors: runtime.memory.recall.vectors }),
          },
          config: {
            token,
            ...(ownerUserId === undefined ? {} : { ownerUserId }),
            ...(ownerChatId === undefined ? {} : { ownerChatId }),
            ...(tg?.pairing === undefined ? {} : { pairing: tg.pairing }),
          },
          // The pairing outcome has to reach disk, or the bind lasts until the
          // process exits and the owner has to do it again every restart.
          savePairing: (next) => {
            const current = loadConfig(home);
            saveConfig(
              {
                ...current,
                surfaces: {
                  ...current.surfaces,
                  telegram: {
                    ...current.surfaces.telegram,
                    ...(next.ownerUserId === undefined ? {} : { ownerUserId: next.ownerUserId }),
                    ...(next.ownerChatId === undefined ? {} : { ownerChatId: next.ownerChatId }),
                    ...(next.pairing === null ? { pairing: undefined } : { pairing: next.pairing }),
                  },
                },
              },
              home,
            );
          },
          log: (line) => process.stderr.write(`\r${line}\n`),
        });

        // Same process, background. A crash of the surface is reported and does
        // not take the REPL down: the terminal is the surface of last resort,
        // and it stays up when the others fall over.
        void connector.run().catch((error: unknown) => {
          process.stderr.write(`\rtelegram: caduta — ${error instanceof Error ? error.message : String(error)}\n`);
        });
        stops.push(() => connector.stop());
        lines.push(
          ownerUserId === undefined
            ? 'telegram: connessa, in attesa del codice — nessuno è owner finché non arriva'
            : `telegram: connessa (owner ${ownerUserId})`,
        );
      }
    } catch (error) {
      lines.push(`telegram: abilitata ma non parte — ${(error as ConfigError).message}`);
    }
  }

  return { lines, stop: () => stops.forEach((s) => s()) };
}

function hasSecret(ref: string, home: string): boolean {
  try {
    readSecret(ref, home);
    return true;
  } catch {
    return false;
  }
}


function inboxStats(home: string): { pending: number; failed: number } | null {
  const db = new DatabaseCtor(paths(home).db, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT sum(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS pending,
                sum(CASE WHEN failure IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM telegram_updates`,
      )
      .get() as { pending: number; failed: number };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
