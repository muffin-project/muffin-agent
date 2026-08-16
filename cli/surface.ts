import DatabaseCtor from 'better-sqlite3';
import { generatePairingCode, startPairing } from '../core/config/pairing.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../agent/runtime.js';
import type { LaneDeliver } from '../agent/turn-lane.js';
import {
  loadConfig,
  paths,
  readSecret,
  saveConfig,
  ConfigError,
} from '../core/config/config.js';
import { cliSurface, type CliWriter } from '../core/surface/cli.js';
import { SurfaceRegistry } from '../core/surface/registry.js';
import type { Surface } from '../core/surface/types.js';
import { TelegramApi } from '../connectors/telegram/api.js';
import { TelegramConnector, type ConnectorDeps } from '../connectors/telegram/connector.js';
import { telegramSurface } from '../connectors/telegram/surface.js';
import { UpdateInbox } from '../connectors/telegram/updates.js';
import { DiscordApi } from '../connectors/discord/api.js';
import { DiscordConnector, type ConnectorDeps as DiscordConnectorDeps } from '../connectors/discord/connector.js';
import { discordSurface } from '../connectors/discord/surface.js';
import { DiscordInbox } from '../connectors/discord/inbox.js';
import { mandatoryGuards } from '../core/rot/guards.js';
import { makeSendFileTool, sendFileCapability } from '../agent/tools/deliver.js';
import type { FsScope } from '../agent/tools/fs.js';

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
  muffin surface enable discord [--owner <user-id>]
  muffin surface disable telegram|discord
`;

export function cmdSurfaceList(home: string): number {
  const config = loadConfig(home);
  const lines: string[] = [];

  for (const id of ['cli', 'telegram', 'discord']) {
    const enabled = config.surfaces.enabled.includes(id);
    const isDefault = config.surfaces.default === id;
    let detail = '';

    if (id === 'telegram') {
      const token = hasSecret('secret://telegram_token', home);
      const owner = config.surfaces.telegram?.ownerChatId;
      if (enabled) {
        detail = ` · token ${token ? 'presente' : 'MANCANTE'} · owner ${owner ?? 'MANCANTE'}`;
        const stats = inboxStats(home, 'telegram_updates');
        if (stats) detail += ` · ${stats.pending} in coda${stats.failed > 0 ? ` · ${stats.failed} falliti` : ''}`;
      } else {
        detail = token ? ' · token presente, abilitala con `muffin surface enable telegram`' : '';
      }
    }

    if (id === 'discord') {
      const token = hasSecret('secret://discord_token', home);
      const owner = config.surfaces.discord?.ownerUserId;
      if (enabled) {
        detail = ` · token ${token ? 'presente' : 'MANCANTE'} · owner ${owner ?? 'MANCANTE'}`;
        const stats = inboxStats(home, 'discord_messages');
        if (stats) detail += ` · ${stats.pending} in coda${stats.failed > 0 ? ` · ${stats.failed} falliti` : ''}`;
      } else {
        detail = token ? ' · token presente, abilitala con `muffin surface enable discord`' : '';
      }
    }

    lines.push(`${enabled ? '●' : '○'} ${id.padEnd(10)}${isDefault ? ' (default)' : ''}${detail}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Enabling a surface is the onboarding, in one idempotent command.
 *
 * It verifies the token against the real server, finds or pairs the owner, and
 * writes the config. Run it before messaging the bot and it tells you the
 * missing step; run it again after and it finishes. No environment variable:
 * the owner id is configuration, and configuration lives in the config.
 */
export async function cmdSurfaceEnable(home: string, id: string, ownerFlag?: string): Promise<number> {
  if (id === 'cli') {
    process.stderr.write(`la CLI è sempre abilitata\n`);
    return 0;
  }
  if (id === 'telegram') return enableTelegram(home, ownerFlag);
  if (id === 'discord') return enableDiscord(home, ownerFlag);
  process.stderr.write(`superficie sconosciuta: ${id}\n${SURFACE_USAGE}`);
  return 78;
}

async function enableTelegram(home: string, ownerFlag?: string): Promise<number> {
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

/**
 * Same shape as `enableTelegram`, one real difference: there is no chat id to
 * derive alongside the user id. A Discord DM channel is its own id, resolved
 * lazily through `openDm` (`connectors/discord/surface.ts`) rather than stored
 * — Telegram's `ownerChatId` exists because a private chat id and a user id
 * happen to coincide there and Telegram hands it over for free; Discord hands
 * over neither for free, and inventing a stored "owner channel id" would be a
 * second cache to keep in sync with something `openDm` already keeps current.
 *
 * **The onboarding step this cannot skip, stated so it is not discovered the
 * hard way**: Discord does not offer a public "message this bot" search the
 * way opening a Telegram chat by username does. The realistic path — not
 * verified live against a real application, since this slice runs with no
 * Discord token (see the brief) — is inviting the bot to a server the owner
 * controls via an OAuth2 URL with the `bot` scope and no permissions, then
 * DMing it there; printed below so the step is not silently assumed.
 */
async function enableDiscord(home: string, ownerFlag?: string): Promise<number> {
  let token: string;
  try {
    token = readSecret('secret://discord_token', home);
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    process.stderr.write(`  → crea un'app su discord.com/developers/applications, prendi il token del bot, poi:\n    echo -n "<token>" | muffin secret set discord_token\n`);
    return 78;
  }

  const api = new DiscordApi(token);
  const me = await api.me();

  const config = loadConfig(home);
  let ownerUserId = config.surfaces.discord?.ownerUserId;

  if (ownerFlag !== undefined) {
    if (!/^[0-9]{5,25}$/.test(ownerFlag)) {
      process.stderr.write(`--owner deve essere uno snowflake Discord (solo cifre)\n`);
      return 78;
    }
    ownerUserId = ownerFlag;
  }

  let pairing = config.surfaces.discord?.pairing;
  if (ownerUserId === undefined) {
    const code = generatePairingCode();
    pairing = startPairing(code, new Date());
    process.stderr.write(`\n  @${me.username} (${me.id}) è raggiungibile.\n\n`);
    process.stderr.write(
      `  Se non l'hai già fatto: invitalo su un server che controlli —\n` +
        `  https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=0\n` +
        `  — poi mandagli questo codice in DM, entro 10 minuti:\n\n`,
    );
    process.stderr.write(`      ${code}\n\n`);
    process.stderr.write(`  Fino ad allora nessuno è l'owner — chi scrive è uno sconosciuto.\n\n`);
  }

  const next = {
    ...config,
    surfaces: {
      ...config.surfaces,
      enabled: config.surfaces.enabled.includes('discord')
        ? config.surfaces.enabled
        : [...config.surfaces.enabled, 'discord'],
      discord: {
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
        ...(pairing === undefined ? {} : { pairing }),
      },
    },
  };
  saveConfig(next, home);
  process.stdout.write(`discord abilitata: @${me.username} (${me.id})${ownerUserId ? `, owner ${ownerUserId}` : ''}\n`);
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
 * Called by the REPL and by headless serve alike. Returns the stops, a line per
 * surface for the prompt — including the surface that *should* be up and is
 * not, because a surface silently missing is how "Muffin non risponde su
 * Telegram" becomes a mystery instead of a line of output — and **the registry**,
 * which is what anything wanting to *send* now asks.
 *
 * The registry is the half that was missing. Delivery used to be three
 * hand-rolled `Deliver` functions, one per caller, each with its own opinion
 * about which channels were real; two of the three said "consegna remota da
 * cablare" for everything that was not the terminal, so a job targeting Telegram
 * never arrived even on a home where Telegram was connected and answering
 * messages a metre away. The connector and the delivery path did not know about
 * each other. Now they are built together, here, from the same token.
 */
export function connectSurfaces(
  runtime: Runtime,
  home: string,
  /**
   * Where the CLI surface writes. The REPL has to reprint its prompt after, and
   * a gateway's stdout is the journal — so the destination is the caller's, and
   * only the decision to *have* a CLI surface is made here (L0-1: it is the
   * surface of last resort and is never absent).
   */
  cliWrite: CliWriter = (text) => process.stdout.write(`${text}\n`),
): { lines: string[]; stop: () => void; registry: SurfaceRegistry; deliver: LaneDeliver } {
  const lines: string[] = [];
  const stops: (() => void)[] = [];
  const surfaces: Surface[] = [cliSurface(cliWrite)];
  /**
   * How a turn the **lane** finished gets back to whoever asked for it.
   *
   * Keyed by `turn.surface`, and separate from `SurfaceRegistry` above rather
   * than folded into it: the lane resumes a row whose address is the opaque
   * `replyTo` a connector wrote at creation time (a chat id *and* a message
   * id, for Telegram), not a `SurfaceRegistry` channel string — the two
   * addressing schemes exist for different callers (a job has no message to
   * reply to; a resumed turn does) and collapsing them would mean inventing a
   * channel string with nowhere to put the part `SurfaceRegistry.find` does
   * not need. This map is filled by whichever surfaces actually came up, so a
   * turn addressed to a surface that failed to connect is reported as
   * undeliverable rather than sent nowhere.
   */
  const doors = new Map<string, (replyTo: Record<string, unknown>, text: string) => Promise<void>>();

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
        const connector = new TelegramConnector({
          loop: runtime.deps,
          sessions: runtime.deps.sessions,
          inbox,
          api,
          vault: telegramVault(runtime, vaultRoot),
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
        // The door for the lane. Registered next to the connector that owns it,
        // so a surface that did not come up simply has none — the honest state,
        // rather than a door onto a dead poller.
        doors.set('telegram', (replyTo, text) => connector.deliverTo(replyTo, text));
        // Delivery for `SurfaceRegistry`, from the same token the listener
        // uses. `ownerChatId` is what makes `handles('telegram')` true, so an
        // unpaired surface listens but does not claim to be a destination —
        // which is the honest answer while nobody is the owner yet.
        surfaces.push(telegramSurface(api, ownerChatId));
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

  if (runtime.config.surfaces.enabled.includes('discord')) {
    try {
      const token = readSecret('secret://discord_token', home);
      const dc = runtime.config.surfaces.discord;
      const ownerUserId = dc?.ownerUserId;
      if (ownerUserId === undefined && dc?.pairing === undefined) {
        lines.push('discord: abilitata ma senza owner — `muffin surface enable discord`');
      } else {
        const api = new DiscordApi(token);
        const inbox = new DiscordInbox(new DatabaseCtor(paths(home).db));
        const vaultRoot = paths(home).vault;
        mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
        const connector = new DiscordConnector({
          loop: runtime.deps,
          sessions: runtime.deps.sessions,
          inbox,
          api,
          vault: discordVault(runtime, vaultRoot),
          config: {
            token,
            ...(ownerUserId === undefined ? {} : { ownerUserId }),
            ...(dc?.pairing === undefined ? {} : { pairing: dc.pairing }),
          },
          savePairing: (next) => {
            const current = loadConfig(home);
            saveConfig(
              {
                ...current,
                surfaces: {
                  ...current.surfaces,
                  discord: {
                    ...current.surfaces.discord,
                    ...(next.ownerUserId === undefined ? {} : { ownerUserId: next.ownerUserId }),
                    ...(next.pairing === null ? { pairing: undefined } : { pairing: next.pairing }),
                  },
                },
              },
              home,
            );
          },
          log: (line) => process.stderr.write(`\r${line}\n`),
        });

        void connector.run().catch((error: unknown) => {
          process.stderr.write(`\rdiscord: caduta — ${error instanceof Error ? error.message : String(error)}\n`);
        });
        stops.push(() => connector.stop());
        surfaces.push(discordSurface(api, ownerUserId));
        // N2 (judge, PR #42): this used to say "connessa" before `api.me()` —
        // called inside `connector.run()`, fire-and-forget above — had
        // actually answered. A bad token would print "connessa" and then, a
        // moment later, "discord: caduta" from the `.catch` above: two lines
        // that contradict each other, in the order that hides which one is
        // true. `connector.run()` already logs the real confirmation once
        // `me()` succeeds ("discord: connesso come @…", `connector.ts`), so
        // this line only ever claims what it can see synchronously: that the
        // connector was started, not that Discord has answered it.
        lines.push(
          ownerUserId === undefined
            ? 'discord: in connessione, in attesa del codice — nessuno è owner finché non arriva'
            : `discord: in connessione (owner ${ownerUserId})`,
        );
      }
    } catch (error) {
      lines.push(`discord: abilitata ma non parte — ${(error as ConfigError).message}`);
    }
  }

  return {
    lines,
    stop: () => stops.forEach((s) => s()),
    registry: new SurfaceRegistry(surfaces),
    /**
     * The lane's delivery, over whichever surfaces are up.
     *
     * `cli` writes to stdout — under a supervisor that is the journal, which is
     * the honest place for an answer nobody was there to read, and the same
     * choice `SurfaceRegistry`'s own `cliSurface` makes for a scheduled job. An
     * unknown surface **throws**, so the row gets `failed:` and the answer
     * stays visible as owed instead of being reported as sent.
     */
    deliver: async (turn, text) => {
      if (turn.surface === 'cli') {
        process.stdout.write(`↩︎ ${text}\n`);
        return;
      }
      const door = doors.get(turn.surface);
      if (!door) throw new Error(`superficie "${turn.surface}" non connessa in questo processo`);
      if (turn.replyTo === null) throw new Error(`turno ${turn.id.slice(0, 12)} senza indirizzo di risposta`);
      await door(turn.replyTo, text);
    },
  };
}

/**
 * Registers `send_file` (M5-BIS B14) against the registry `connectSurfaces`
 * just built.
 *
 * Separate call, not folded into `connectSurfaces`, for the reason `attachMcp`
 * is separate from `buildRuntime`: the tool needs a `SurfaceRegistry` that
 * does not exist until surfaces have connected, and `Runtime.register` is
 * exactly the seam built for a tool that cannot exist at `buildRuntime` time.
 * Called identically by `runRepl` and `cmdGatewayRun`, right after
 * `connectSurfaces`, so a home with no surfaces enabled still gets `send_file`
 * wired to `cliSurface` — the terminal is always in the registry (L0-1).
 */
export function attachSendFile(runtime: Runtime, home: string, registry: SurfaceRegistry): void {
  const vaultRoot = paths(home).vault;
  const guards = mandatoryGuards(home, vaultRoot);
  const scope: FsScope = { root: vaultRoot, denyWrite: guards.denyWrite, denyRead: guards.denyRead };
  runtime.register(makeSendFileTool({ scope, deliverFile: registry.deliverFile }), sendFileCapability);
}

/**
 * The attachment adapter shared by production and its connector acceptance test.
 *
 * The tenant is an authority boundary, not decoration. Keeping this adapter as
 * one named unit means the test exercises the exact place where production once
 * replaced every resolved group tenant with `host`.
 */
export function telegramVault(runtime: Runtime, root: string): NonNullable<ConnectorDeps['vault']> {
  return {
    root,
    reindexPath: (tenantId, vaultPath, defaultTier) =>
      runtime.vault.reindexPath(tenantId, vaultPath, {
        defaultTier,
        vectors: runtime.memory.recall.vectors,
      }),
  };
}

/** Same adapter as `telegramVault`, over Discord's connector deps shape. */
export function discordVault(runtime: Runtime, root: string): NonNullable<DiscordConnectorDeps['vault']> {
  return {
    root,
    reindexPath: (tenantId, vaultPath, defaultTier) =>
      runtime.vault.reindexPath(tenantId, vaultPath, {
        defaultTier,
        vectors: runtime.memory.recall.vectors,
      }),
  };
}

function hasSecret(ref: string, home: string): boolean {
  try {
    readSecret(ref, home);
    return true;
  } catch {
    return false;
  }
}

function inboxStats(home: string, table: 'telegram_updates' | 'discord_messages'): { pending: number; failed: number } | null {
  const db = new DatabaseCtor(paths(home).db, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT sum(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS pending,
                sum(CASE WHEN failure IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM ${table}`,
      )
      .get() as { pending: number; failed: number };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
