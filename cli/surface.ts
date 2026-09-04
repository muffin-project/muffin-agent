import DatabaseCtor from 'better-sqlite3';
import { aiuto, eseguiComando, type Controlli } from '../agent/comandi.js';
import { Pausa } from '../core/runtime/pausa.js';
import { decidiVoce, type Voce } from '../core/audio/voce.js';
import { openDb } from '../core/db/open.js';
import { generatePairingCode, startPairing } from '../core/config/pairing.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../agent/runtime.js';
import type { AttachStream, LaneDeliver } from '../agent/turn-lane.js';
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
import { TelegramDeliveryStore } from '../connectors/telegram/delivery.js';
import { telegramSurface } from '../connectors/telegram/surface.js';
import { UpdateInbox } from '../connectors/telegram/updates.js';
import { DiscordApi } from '../connectors/discord/api.js';
import { DiscordConnector, type ConnectorDeps as DiscordConnectorDeps } from '../connectors/discord/connector.js';
import { discordSurface } from '../connectors/discord/surface.js';
import { DiscordInbox } from '../connectors/discord/inbox.js';
import { mandatoryGuards } from '../core/rot/guards.js';
import { makeSendFileTool, sendFileCapability } from '../agent/tools/deliver.js';
import type { FsScope } from '../agent/tools/fs.js';
import { cmdModel } from './model.js';
import type { Approver } from '../agent/loop.js';
import { escapeHtml, splitHtml } from '../connectors/telegram/render.js';
import { SaluteSuperfici } from '../core/surface/salute.js';
import { HEARTBEAT_MS } from '../core/gateway/lock.js';
import { DRAIN_BUDGET_MS } from '../core/gateway/service.js';

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

/**
 * Le superfici che questa build conosce.
 *
 * Una lista sola, perché `surface list` la percorreva con un letterale suo e
 * `surface default` non ce l'aveva affatto: chiedere `default pippo` rimandava
 * a `enable pippo`, che rispondeva «superficie sconosciuta» — un vicolo cieco
 * in due passi. Aggiungere una superficie senza toccarla è il modo in cui i due
 * elenchi finiscono per non essere d'accordo.
 */
export const SUPERFICI_NOTE: readonly string[] = ['cli', 'telegram', 'discord'];

export const SURFACE_USAGE = `usage:
  muffin surface list                     le superfici e il loro stato
  muffin surface enable telegram [--owner <chat-id>]
  muffin surface enable discord [--owner <user-id>]
  muffin surface disable telegram|discord
  muffin surface default <id>             dove Muffin parla quando nessuno ha chiesto
`;

/**
 * `surfaces.default` era una manopola senza porta, e la porta mancante costava
 * una promessa.
 *
 * Il campo si dichiara da sempre come *«dove Muffin parla quando nessuno ha
 * chiesto»* — ed e' cio' che leggono sia `muffin observe` sia la corsia degli
 * impegni (ADR-0060) — ma `DEFAULT_CONFIG` lo mette a `cli`, `muffin surface
 * enable telegram` non lo tocca, e non esisteva nessun comando per cambiarlo.
 * Sull'installazione reale dell'owner: `default: "cli"` con `enabled:
 * ["cli","telegram","discord"]`. Sotto un supervisore quel `cli` e' il journal,
 * quindi un messaggio non richiesto finiva in un log e nessuno poteva
 * spostarlo senza aprire `config.json` a mano.
 *
 * Non lo cambia nessun altro comando, di proposito: `enable` che sposta il
 * canale predefinito sarebbe un effetto che l'owner non ha chiesto sul verbo
 * che usa per fare tutt'altro. Quello che `enable` fa adesso e' **dirlo**.
 */
export function cmdSurfaceDefault(home: string, id: string): number {
  const config = loadConfig(home);
  // `cli` e' sempre abilitata (L0-1) e non compare necessariamente in `enabled`
  // di ogni config scritta a mano: l'unica superficie che non ha bisogno del
  // permesso di essere scelta.
  // Una superficie che non esiste si dice qui. Prima il ramo era uno solo e
  // mandava a `surface enable pippo`, che risponde «superficie sconosciuta»:
  // un vicolo cieco in due passi, trovato da un giudice.
  if (!SUPERFICI_NOTE.includes(id)) {
    process.stderr.write(`superficie sconosciuta: ${id}\n  quelle che esistono: ${SUPERFICI_NOTE.join(', ')}\n`);
    return 78;
  }
  if (id !== 'cli' && !config.surfaces.enabled.includes(id)) {
    process.stderr.write(
      `${id} non è abilitata: non può essere la superficie predefinita
` +
        `→ muffin surface enable ${id}
`,
    );
    return 78;
  }
  if (config.surfaces.default === id) {
    process.stdout.write(`${id} è già la superficie predefinita
`);
    return 0;
  }
  saveConfig({ ...config, surfaces: { ...config.surfaces, default: id } }, home);
  process.stdout.write(
    `superficie predefinita: ${id}
` +
      `  è dove finisce ciò che Muffin dice di sua iniziativa — promemoria scaduti, osservazioni.
` +
      // Vero perché la corsia rilegge `config.json` a ogni giro
      // (`Runtime.defaultChannel`). Prima non lo era, e il giudice l'ha
      // misurato: l'owner girava la manopola, il gateway continuava per giorni
      // a rispondere `cli`, e niente distingueva il rimedio da un difetto.
      `  un gateway già in esecuzione la prende al giro dopo, senza riavvio.
`,
  );
  return 0;
}

export function cmdSurfaceList(home: string): number {
  const config = loadConfig(home);
  const lines: string[] = [];

  for (const id of SUPERFICI_NOTE) {
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

  /**
   * La riga che mancava, e non e' cosmetica.
   *
   * `default: "cli"` con una superficie remota accesa e' la configurazione
   * dell'owner, ed e' quella in cui un promemoria scaduto finisce sul
   * terminale — cioe' nel journal, sotto un supervisore. Detto qui perche'
   * `surface list` e' il posto dove si va a guardare, e perche' fino a questa
   * slice non esisteva nemmeno il comando per cambiarlo.
   */
  const remote = config.surfaces.enabled.filter((s) => s !== 'cli');
  if (config.surfaces.default === 'cli' && remote.length > 0) {
    lines.push(
      '',
      `! ciò che Muffin dice di sua iniziativa va su "cli": in un processo senza terminale`,
      `  finisce nel log e nessuno lo legge — \`muffin surface default ${remote[0]}\``,
    );
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
export async function cmdSurfaceEnable(
  home: string,
  id: string,
  ownerFlag?: string,
  apiBaseFlag?: string,
): Promise<number> {
  if (id === 'cli') {
    process.stderr.write(`la CLI è sempre abilitata\n`);
    return 0;
  }
  if (id === 'telegram') return enableTelegram(home, ownerFlag, apiBaseFlag);
  if (id === 'discord') return enableDiscord(home, ownerFlag);
  process.stderr.write(`superficie sconosciuta: ${id}\n${SURFACE_USAGE}`);
  return 78;
}

async function enableTelegram(home: string, ownerFlag?: string, apiBaseFlag?: string): Promise<number> {
  let token: string;
  try {
    token = readSecret('secret://telegram_token', home);
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    process.stderr.write(`  → prendi un token da @BotFather, poi:\n    echo -n "<token>" | muffin secret set telegram_token\n`);
    return 78;
  }

  const config = loadConfig(home);
  // `--api-base` wins over what is stored, and what is stored wins over
  // Telegram's own host — the ordinary precedence for a flag that overrides
  // configuration. A self-hosted Bot API server is a documented deployment
  // (core.telegram.org/bots/api), so this is a real knob, not a test hook.
  const apiBase = apiBaseFlag ?? config.surfaces.telegram?.apiBase;

  // Against the real server, now: a bad token should fail here, in the command
  // whose job is configuration, not tonight when the surface tries to connect.
  const api = apiBase === undefined ? new TelegramApi(token) : new TelegramApi(token, apiBase);
  const me = await api.getMe();

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
        ...(apiBase === undefined ? {} : { apiBase }),
      },
    },
  };
  saveConfig(next, home);
  process.stdout.write(`telegram abilitata: @${me.username ?? me.id}, owner ${ownerChatId}\n`);
  process.stdout.write(`si connette al prossimo \`muffin\`\n`);
  ricordaLaPredefinita(home, 'telegram');
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
  ricordaLaPredefinita(home, 'discord');
  return 0;
}
/**
 * Detto, mai fatto di nascosto.
 *
 * `enable` non sposta `surfaces.default` — spostarlo sarebbe un effetto che
 * l'owner non ha chiesto sul verbo che sta usando per altro — ma tacere e'
 * come si e' arrivati a un'installazione con Telegram acceso e i messaggi non
 * richiesti diretti al terminale. Una riga, con il comando esatto.
 */
function ricordaLaPredefinita(home: string, id: string): void {
  const config = loadConfig(home);
  if (config.surfaces.default === id) return;
  process.stdout.write(
    `ciò che Muffin dice di sua iniziativa continua ad andare su "${config.surfaces.default}"\n` +
      `  → muffin surface default ${id}\n`,
  );
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
  // Spegnere la superficie predefinita la riporta a `cli`, e lo dice. Lasciarla
  // puntata a una superficie ora spenta era uno stato che nessun comando poteva
  // produrre di proposito: `reachesOwner` avrebbe risposto «sì» (non è `cli`) e
  // la consegna sarebbe tornata `{ delivered: false }` a ogni giro, con
  // l'impegno dovuto per sempre e nessuna riga che nominasse la causa.
  const eraPredefinita = config.surfaces.default === id;
  saveConfig(
    {
      ...config,
      surfaces: {
        ...config.surfaces,
        enabled: config.surfaces.enabled.filter((s) => s !== id),
        ...(eraPredefinita ? { default: 'cli' } : {}),
      },
    },
    home,
  );
  process.stdout.write(`${id} disabilitata\n`);
  if (eraPredefinita) {
    process.stdout.write(
      `  era la superficie predefinita: torna a cli\n` +
        `  → muffin surface default <id> per mandarla altrove\n`,
    );
  }
  return 0;
}

/**
 * Come questa installazione tratta le note vocali.
 *
 * Costruita qui e non dentro il connettore: è il punto che ha già in mano sia
 * la config sia il provider, e il connettore non deve conoscere nessuno dei
 * due. La decisione fra «lo manda al modello» e «lo trascrive in casa» la
 * prende `decidiVoce` misurando le modalità del modello sul provider, non una
 * manopola che qualcuno deve ricordarsi di girare.
 *
 * **Senza chiave.** L'elenco modelli di OpenRouter risponde uguale senza
 * autenticazione — misurato il 28/08/2026 — quindi la domanda «questo modello
 * accetta audio?» non ha nessun bisogno del segreto, e un segreto che non
 * serve non si fa viaggiare. Un endpoint compatibile che invece la volesse
 * risponderebbe non-ok, cioè «non so»: si trascrive in casa, che è il ramo
 * conservativo.
 */
/**
 * A gateway log line carries its time.
 *
 * `gateway.err` recorded only failures and never dated them: it said *how
 * many* times Telegram polling failed, never *for how long* — and deducing a
 * duration from that file cost nineteen hours of misdiagnosis once (handoff,
 * 2026-08-30). One prefix, one place, for every surface that logs here.
 */
export function rigaDiLog(line: string): void {
  process.stderr.write(`\r${rigaDatata(line)}\n`);
}

/**
 * Dove va la riga è del chiamante; **quando è successo** no.
 *
 * Il prefisso sta qui e non nei due scrittori, o il REPL — che dal 03/09/2026
 * scrive le stesse righe passando dal togli/scrivi/rimetti della casella
 * (`makeReplLog`) — avrebbe la sua idea del formato, e la data sarebbe una
 * cosa che una delle due destinazioni può dimenticare. È esattamente il modo
 * in cui `gateway.err` è finito senza date.
 */
export function rigaDatata(line: string): string {
  return `${new Date().toISOString()} ${line}`;
}

/** Dove finisce una riga di log di superficie: stderr, o la regione sopra la casella. */
export type SinkDiLog = (line: string) => void;

function voceFor(runtime: Runtime, home: string): (percorso: string) => Promise<Voce> {
  const audio = runtime.config.audio;
  const modello = audio?.whisperModel ?? paths(home).whisperModel;
  return (percorso) =>
    decidiVoce(percorso, {
      baseUrl: runtime.config.provider.baseUrl,
      model: runtime.config.models.main,
      whisperModel: modello,
      ...(audio?.whisperBin === undefined ? {} : { whisperBin: audio.whisperBin }),
      ...(audio?.ffmpegBin === undefined ? {} : { ffmpegBin: audio.ffmpegBin }),
    });
}

/**
 * La domanda di approvazione, su Telegram, con i pulsanti.
 *
 * Prima di questa funzione il kernel su Telegram poteva solo dire «su questa
 * superficie non posso chiederla»: cioè dal telefono non era usabile niente di
 * ciò che chiede conferma — che oggi è quasi tutto, perché finché `muffin rot
 * harden` non è stato fatto `sys.shell` chiede **sempre**.
 *
 * **Torna `asked`, non una promessa.** La funzione manda il messaggio e finisce;
 * la risposta arriverà come un `callback_query`, forse fra un'ora, forse a un
 * altro processo dopo un riavvio. È il turno a sospendersi su una barriera
 * persistita (`approval:<id>`), e questa è l'unica forma che sopravvive a un
 * riavvio: tenere aperta una promessa in memoria vorrebbe dire che spegnere il
 * gateway perde la domanda e il lavoro dietro.
 *
 * **Cosa mostra.** L'azione concreta e il taint del turno — i due fatti che
 * DAY-1 requirement D12 chiede per non fare teatro: «approvi sys.shell?» non è una
 * domanda a cui qualcuno possa rispondere. Il testo del kernel è riportato
 * com'è: parafrasarlo è l'occasione di far sembrare la richiesta più piccola di
 * quello che è. Dal 03/09 anche la frase del modello su *cosa fa* il comando
 * (`ApprovalRequest.description`), **sopra** il comando e mai al suo posto.
 *
 * **Intera, sempre.** L'owner ha ricevuto un comando lungo tagliato nel
 * messaggio stesso che gli chiedeva se eseguirlo (`summarizeCallArgs` tagliava
 * a 220; non più). Qui il testo si spezza con `splitHtml` come una risposta
 * qualunque: se non entra in un messaggio ne prende due, e i pulsanti stanno
 * sull'ultimo — la domanda è sempre l'ultima cosa che si legge.
 */
function approvatoreTelegram(api: TelegramApi): Approver {
  const ETICHETTA_TAINT = ['', 'contatto noto', 'gruppo/sconosciuto', 'contenuto esterno (web o tool)'];
  return async (request, where) => {
    const chatId = where.replyTo?.['chatId'];
    // Nessun indirizzo durevole vuol dire nessun posto dove far comparire la
    // domanda. Non si inventa la chat dell'owner: un turno il cui indirizzo non
    // sappiamo leggere è un turno di cui non sappiamo a chi stiamo parlando.
    if (typeof chatId !== 'number' || where.approvalId === undefined) return 'unavailable';

    const righe = [`⚠ <b>${escapeHtml(request.prompt)}</b>`];
    if (request.description !== undefined && request.description !== '') {
      righe.push(`<i>${escapeHtml(request.description)}</i>`);
    }
    if (request.resource !== undefined && request.resource !== '') {
      righe.push(`<pre><code>${escapeHtml(request.resource)}</code></pre>`);
    }
    if (request.taint > 0) {
      const etichetta = ETICHETTA_TAINT[request.taint];
      righe.push(
        `contesto: turno a taint ${request.taint}${etichetta ? ` — ${etichetta}` : ''} ` +
          `(contenuto non tuo è già entrato in questo turno)`,
      );
    }

    const parti = splitHtml(righe.join('\n\n'));
    for (let i = 0; i < parti.length - 1; i++) await api.sendMessage(chatId, parti[i]!);
    await api.sendMessage(chatId, parti[parti.length - 1] ?? '', {
      keyboard: [
        [
          { text: `Consenti "${request.capability}"`, callback_data: `ok:${where.approvalId}`, style: 'success' },
          { text: 'Rifiuta', callback_data: `no:${where.approvalId}`, style: 'danger' },
        ],
      ],
    });
    return 'asked';
  };
}

/**
 * I comandi della CLI, eseguibili da Telegram.
 *
 * L'owner l'ha chiesto con una parola sola: «tutti i / commands che abbiamo
 * nella CLI dobbiamo riportarli su telegram, SEMPRE». Il "sempre" non regge
 * copiandoli — regge perché `agent/comandi.ts` è l'unico posto dove sono
 * scritti, e qui si costruisce soltanto il **contesto** che quel modulo non
 * può avere: la config di questa home, il conto, il profilo caricato.
 *
 * Le tre differenze fra le due superfici, e perché stanno qui e non lì:
 *
 * - **`/exit`** non esiste. Su Telegram non c'è nessun processo da chiudere,
 *   e `puoiUscire: false` lo toglie sia dall'aiuto sia dal menu.
 * - **`/new`** non apre un id nuovo. L'id di sessione lo decide la chat
 *   (`telegram:<chatId>`), quindi «una conversazione nuova» è `rotate`: il
 *   file viene messo da parte e la stessa chat riparte vuota. Il messaggio lo
 *   dice esplicitamente, perché qui la storia resta visibile scorrendo in su
 *   — e la cosa peggiore sarebbe che l'owner rilegga uno scambio che Muffin
 *   non ha più.
 * - **Un comando che non esiste** riceve l'aiuto invece di finire al modello.
 *   Su Telegram lo slash è un gesto: apre il menu, non capita per sbaglio a
 *   inizio frase come un percorso in un terminale.
 *
 * `runtime.config` viene riscritta in memoria dopo `/model` e `/think` per lo
 * stesso motivo per cui lo fa il REPL: senza, il turno dopo continuerebbe a
 * leggere la config di prima, e la manopola sembrerebbe non aver fatto niente.
 */
function comandiPerTelegram(
  runtime: Runtime,
  home: string,
): (riga: string, sessionId: string, controlli: Controlli) => Promise<{ testo: string } | null> {
  return async (riga, sessionId, controlli) => {
    const esito = await eseguiComando(riga, {
      home,
      // Le leve sul turno vivo le tiene il connettore, che sa quale chat è
      // (ADR-0054); qui passano e basta.
      controlli,
      config: runtime.config,
      onConfig: (next) => {
        runtime.config = next;
      },
      profilo: { name: runtime.deps.profile.name, thinking: runtime.deps.profile.thinking },
      onThinking: (t) => {
        runtime.deps.profile.thinking = t;
      },
      budget: runtime.budget,
      sessionId,
      // Telegram non ha una riga di stato né un footer dove metterli: il
      // livello di dettaglio parte da quello normale a ogni avvio, e `/debug`
      // qui cambia soltanto cosa risponde il comando stesso. Vedi
      // `agent/comandi.ts`.
      verbosity: 'normale',
      puoiUscire: false,
      model: (argv, out) => cmdModel(home, argv, { out }),
    });
    if (esito.sconosciuto === true) return { testo: `comando sconosciuto.\n${aiuto(false)}` };
    if (esito.nuovaSessione === true) {
      const archivio = runtime.deps.sessions.rotate(runtime.deps.sessions.open(sessionId));
      return {
        testo:
          archivio === null
            ? "non c'era niente da archiviare: la conversazione era già nuova."
            : `${esito.testo}\nQui sopra resta scritto, ma per me quella conversazione è chiusa.`,
      };
    }
    return { testo: esito.testo };
  };
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
  /**
   * «C'è un turno pronto adesso»: una spinta alla corsia, non un secondo
   * esecutore.
   *
   * Serve a una cosa sola, ed è la differenza fra usabile e irritante: quando
   * l'owner preme «consenti», il connettore riporta la riga a `runnable` ma a
   * farla girare è la corsia del gateway, che batte ogni 30 secondi. Senza
   * questa spinta, premere il pulsante e non veder succedere niente per mezzo
   * minuto è la forma che ha «non ha funzionato».
   *
   * Assente dove non c'è nessuna corsia da spingere: il REPL cede i turni al
   * gateway (ADR-0035), quindi lì non esiste niente da svegliare — e un turno
   * sospeso su un'installazione senza gateway aspetta la sua scadenza, che è
   * la stessa cosa che vale già per `wait`.
   */
  onWork?: () => void,
  /**
   * Dove i connettori scrivono le loro righe — e perché è un parametro.
   *
   * Una riga di log è una scrittura **fuori banda**, della stessa classe di una
   * consegna: arriva quando arriva, e in un REPL arriva mentre la casella
   * dell'input è a schermo. Fino al 03/09/2026 `rigaDiLog` scriveva dritto su
   * stderr, quindi ogni riga si stampava *dentro* la casella e ne mangiava il
   * bordo — visto in `tmux capture-pane` sull'installazione dell'owner, due
   * secondi dopo l'avvio, che è il motivo per cui la casella «non si vedeva».
   *
   * Il rimedio non è tacere: è passare dalla stessa strada che il REPL ha già
   * per le consegne (togli il riquadro, scrivi, rimettilo). Quella strada la
   * conosce solo chi possiede il terminale, cioè `cli/repl.ts` — e questo file
   * non deve importare la textzone per saperlo, o la dipendenza si
   * rovescerebbe. Quindi il sink lo dà il chiamante: il REPL il suo
   * (`makeReplLog`), `cli/gateway.ts` niente, cioè `rigaDiLog` — dove stderr è
   * un file e una sequenza di escape sarebbe sporcizia dentro `gateway.err`.
   */
  log: SinkDiLog = rigaDiLog,
  /**
   * «Le superfici le sta gia' servendo il gateway?» — e chi.
   *
   * Il difetto che ha prodotto questo parametro, 03/09/2026, macchina
   * dell'owner: con un gateway sotto supervisore, aprire il REPL stampava
   * `telegram: 409, un altro getUpdates e' attivo — attendo` ogni pochi
   * secondi, per sempre. Questa funzione veniva chiamata da **entrambi** i
   * processi senza che nessuno dei due si chiedesse se l'altro c'era gia': due
   * `getUpdates` sullo stesso token, Telegram ne serve uno e risponde 409
   * all'altro. ADR-0022 dice un processo; il REPL cedeva gia' lo scheduler
   * (ADR-0035) e non cedeva la bocca.
   *
   * E' un **cancello, non un muro**, e distingue ricevere da mandare. Chi cede
   * non fa partire il poller: niente `getUpdates`, niente websocket, nessuna
   * riga a timer. Ma la superficie entra lo stesso nel `SurfaceRegistry`, la
   * porta della corsia resta registrata e l'approvatore pure — cioe' consegne,
   * approvazioni e `send_file` da un turno del REPL continuano ad arrivare,
   * perche' mandare non e' contendere: `sendMessage` non ha nessun 409, ce
   * l'ha solo il long-poll.
   *
   * Ri-chiesto ogni `HEARTBEAT_MS`, non solo all'avvio, perche' entrambi gli
   * ordini sono ordinari: un gateway installato mentre il terminale e' aperto,
   * e un gateway che muore (o un coperchio chiuso che gli fa scadere la
   * claim). Chi passa la funzione decide anche come si annuncia il passaggio —
   * `surfaceStandDown` in `cli/repl.ts`. Assente = «sono io il processo che
   * serve», che e' il caso del gateway stesso e di `observe`.
   */
  gatewayServes?: () => { pid: number } | null,
): {
  lines: string[];
  /**
   * Stops every connector this call started, and — unlike the `void` fire-
   * and-forget `stop()` this used to be — **waits** for each of them to be
   * genuinely gone: no `getUpdates` still in flight, no drain still writing,
   * before the caller (`cli/gateway.ts`'s `close`) lets the database under
   * them close. `budgetMs` is the gateway's own drain budget, passed through
   * rather than a second one invented here — a connector that does not answer
   * in time gives up honestly (each connector's own `stop()` logs the line)
   * instead of hanging this past the drain the owner was already told about.
   *
   * `budgetMs` defaults to the same `DRAIN_BUDGET_MS` the gateway's own drain
   * uses, for the callers that are not the gateway (`muffin observe --send`,
   * `cli/repl.ts`'s own shutdown) and so have no `remainingMs` of their own to
   * pass through.
   */
  stop: (budgetMs?: number) => Promise<void>;
  registry: SurfaceRegistry;
  deliver: LaneDeliver;
  attachStream: AttachStream;
  salute: SaluteSuperfici;
} {
  const lines: string[] = [];
  /**
   * Letto una volta qui, e poi solo dal sorvegliante in fondo: le righe di
   * avvio devono dire *la stessa cosa* che il cancello ha deciso, e due
   * letture a distanza di qualche riga potrebbero non dirla.
   */
  const gatewayAtBoot = gatewayServes?.() ?? null;
  /**
   * I poller che il cancello governa — uno per superficie che ne ha uno.
   *
   * Registrati invece che avviati sul posto, perche' il passaggio avviene in
   * due direzioni: `start` viene richiamata quando il gateway se ne va, `stop`
   * quando arriva. Sono le stesse due funzioni dell'avvio e della chiusura, non
   * una seconda coppia.
   */
  const pollers: { start: () => void; stop: () => void }[] = [];
  /**
   * Chi sta rispondendo, adesso.
   *
   * Le righe qui sotto raccontano **l'avvio** e poi tacciono per sempre: e' il
   * caso opposto quello che nessuno sapeva vedere — connessa all'avvio e poi
   * caduta, con `doctor` che restava verde sia durante un blip sia durante
   * un'interruzione, perche' guardava il processo e non la superficie. Questo
   * registro lo tengono aggiornato i connettori mentre girano, e il socket di
   * controllo lo serve a `doctor`.
   */
  const salute = new SaluteSuperfici();
  const adesso = (): Date => new Date();
  const stops: ((budgetMs: number) => Promise<void>)[] = [];
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
  const doors = new Map<
    string,
    (turnId: string, replyTo: Record<string, unknown>, text: string) => Promise<void | 'possibly_sent'>
  >();
  /**
   * The lane's own half of B11/B13 for a resumed turn — same shape as
   * `doors` immediately above, and for the same reason: keyed by
   * `record.surface`, filled only by whichever connector actually came up
   * in this process. Absent for a surface with no live sink to attach (a
   * job, `cli` — the REPL never resumes a turn, ADR-0035) means exactly
   * what it always meant before this slice: the resumed turn runs silent
   * until its final answer.
   */
  const streams = new Map<string, AttachStream>();

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
        salute.caduta('telegram', 'abilitata ma senza owner', adesso(), '`muffin surface enable telegram`');
        lines.push('telegram: abilitata ma senza owner — `muffin surface enable telegram`');
      } else {
        const base = tg?.apiBase;
        const api = base === undefined ? new TelegramApi(token) : new TelegramApi(token, base);
        const telegramDb = openDb(paths(home).db);
        const inbox = new UpdateInbox(telegramDb);
        const delivery = new TelegramDeliveryStore(telegramDb);
        const vaultRoot = paths(home).vault;
        mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
        // The runtime's own vault, not a second one: `document_read` reads
        // through that instance, and a connector indexing into a different root
        // would produce documents the model cannot open.
        const connector = new TelegramConnector({
          loop: runtime.deps,
          sessions: runtime.deps.sessions,
          inbox,
          delivery,
          api,
          vault: telegramVault(runtime, vaultRoot),
          voce: voceFor(runtime, home),
          comandi: comandiPerTelegram(runtime, home),
          // ADR-0054 §4: il fatto durevole che scheduler e corsia leggono.
          pausa: new Pausa(runtime.db),
          // La metà che torna indietro: i pulsanti li manda l'approvatore qui
          // sotto, il dito che li preme lo gestisce il connettore. Condizionale
          // e non un cast: `LoopDeps.approvals` è opzionale nel tipo, e un
          // runtime senza registro è un runtime dove i pulsanti non si mandano —
          // quindi non c'è niente da gestire quando tornano.
          ...(runtime.deps.approvals === undefined ? {} : { approvals: runtime.deps.approvals }),
          ...(onWork === undefined ? {} : { onWork }),
          salute,
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
          log,
        });

        // Registrato prima di far partire il connettore: un turno che chiede
        // un'approvazione al primo messaggio non deve trovare l'instradatore
        // vuoto e rispondere «qui non posso chiedertelo».
        runtime.approvers.set('telegram', approvatoreTelegram(api));

        // Same process, background. A crash of the surface is reported and does
        // not take the REPL down: the terminal is the surface of last resort,
        // and it stays up when the others fall over.
        // Sincrono, prima che il connettore abbia parlato con qualcuno: fra qui
        // e il primo battito passano fino a due minuti se la rete e' lenta, e
        // in quella finestra l'assenza di una riga non deve poter essere letta
        // come «non e' stata nemmeno tentata».
        const avviaTelegram = (): void => {
          salute.inAvvio('telegram', adesso());
          void connector.run().catch((error: unknown) => {
            const causa = error instanceof Error ? error.message : String(error);
            salute.caduta('telegram', causa, adesso());
            log(`telegram: caduta — ${causa}`);
          });
        };
        // Fire-and-forget on purpose here: the mouth handoff is not a
        // shutdown, nothing downstream is about to close the database, and
        // the interval callback that calls this must not block on it.
        pollers.push({ start: avviaTelegram, stop: () => void connector.stop() });
        if (gatewayAtBoot === null) avviaTelegram();
        stops.push((budgetMs) => connector.stop(budgetMs).then(() => undefined));
        // The door for the lane. Registered next to the connector that owns it,
        // so a surface that did not come up simply has none — the honest state,
        // rather than a door onto a dead poller.
        doors.set('telegram', async (turnId, replyTo, text) => {
          const outcome = await connector.deliverTo(turnId, replyTo, text);
          return outcome === 'possibly_sent' ? outcome : undefined;
        });
        streams.set('telegram', connector.resumeStream);
        // Delivery for `SurfaceRegistry`, from the same token the listener
        // uses. `ownerChatId` is what makes `handles('telegram')` true, so an
        // unpaired surface listens but does not claim to be a destination —
        // which is the honest answer while nobody is the owner yet.
        surfaces.push(telegramSurface(api, ownerChatId));
        lines.push(
          gatewayAtBoot !== null
            ? `telegram: la riceve il gateway (pid ${gatewayAtBoot.pid}) — questa finestra manda soltanto`
            : ownerUserId === undefined
              ? 'telegram: connessa, in attesa del codice — nessuno è owner finché non arriva'
              : `telegram: connessa (owner ${ownerUserId})`,
        );
      }
    } catch (error) {
      // Il rimedio esplicito, perche' quello di default direbbe «riavvia il
      // gateway» e un segreto che manca non si ripara riavviando.
      salute.caduta(
        'telegram',
        `non parte — ${(error as ConfigError).message}`,
        adesso(),
        'non e la rete: risolvi cio che la causa nomina (di solito `muffin secret set`), poi riavvia il gateway',
      );
      lines.push(`telegram: abilitata ma non parte — ${(error as ConfigError).message}`);
    }
  }

  if (runtime.config.surfaces.enabled.includes('discord')) {
    try {
      const token = readSecret('secret://discord_token', home);
      const dc = runtime.config.surfaces.discord;
      const ownerUserId = dc?.ownerUserId;
      if (ownerUserId === undefined && dc?.pairing === undefined) {
        salute.caduta('discord', 'abilitata ma senza owner', adesso(), '`muffin surface enable discord`');
        lines.push('discord: abilitata ma senza owner — `muffin surface enable discord`');
      } else {
        const api = new DiscordApi(token);
        const inbox = new DiscordInbox(openDb(paths(home).db));
        const vaultRoot = paths(home).vault;
        mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
        const connector = new DiscordConnector({
          loop: runtime.deps,
          sessions: runtime.deps.sessions,
          inbox,
          api,
          vault: discordVault(runtime, vaultRoot),
          salute,
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
          log,
        });

        // Sincrono, prima che il connettore abbia parlato con qualcuno: fra qui
        // e il primo battito passano fino a due minuti se la rete e' lenta, e
        // in quella finestra l'assenza di una riga non deve poter essere letta
        // come «non e' stata nemmeno tentata».
        const avviaDiscord = (): void => {
          salute.inAvvio('discord', adesso());
          void connector.run().catch((error: unknown) => {
            const causa = error instanceof Error ? error.message : String(error);
            salute.caduta('discord', causa, adesso());
            log(`discord: caduta — ${causa}`);
          });
        };
        // Fire-and-forget for the same reason Telegram's poller stop is.
        pollers.push({ start: avviaDiscord, stop: () => void connector.stop() });
        // Stessa ragione di Telegram: una sola gateway websocket per token,
        // altrimenti ogni messaggio viene servito due volte.
        if (gatewayAtBoot === null) avviaDiscord();
        stops.push((budgetMs) => connector.stop(budgetMs).then(() => undefined));
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
          gatewayAtBoot !== null
            ? `discord: la riceve il gateway (pid ${gatewayAtBoot.pid}) — questa finestra manda soltanto`
            : ownerUserId === undefined
              ? 'discord: in connessione, in attesa del codice — nessuno è owner finché non arriva'
              : `discord: in connessione (owner ${ownerUserId})`,
        );
      }
    } catch (error) {
      // Il rimedio esplicito, perche' quello di default direbbe «riavvia il
      // gateway» e un segreto che manca non si ripara riavviando.
      salute.caduta(
        'discord',
        `non parte — ${(error as ConfigError).message}`,
        adesso(),
        'non e la rete: risolvi cio che la causa nomina (di solito `muffin secret set`), poi riavvia il gateway',
      );
      lines.push(`discord: abilitata ma non parte — ${(error as ConfigError).message}`);
    }
  }

  /**
   * Il passaggio della bocca, mentre il processo gira.
   *
   * Un poller non e' un tick: non basta una condizione ri-chiesta a ogni giro,
   * perche' il giro qui e' un long-poll che dura. Quindi il cancello si rilegge
   * a `HEARTBEAT_MS` — lo stesso ritmo con cui il gateway batte, cioe' il piu'
   * fitto che possa dire qualcosa di nuovo — e sul cambio si passa la bocca:
   * il gateway compare e questa finestra smette di ricevere, il gateway sparisce
   * e ricomincia. `gatewayServes` annuncia da se' il passaggio (una riga per
   * cambio, mai a timer).
   *
   * `unref` perche' questo timer non e' una ragione per restare vivi: un
   * processo che ha finito deve poter uscire, e un test non deve restare
   * appeso a un intervallo di trenta secondi.
   */
  if (gatewayServes !== undefined && pollers.length > 0) {
    let served = gatewayAtBoot !== null;
    const vigile = setInterval(() => {
      const now = gatewayServes() !== null;
      if (now === served) return;
      served = now;
      for (const p of pollers) (now ? p.stop : p.start)();
    }, HEARTBEAT_MS);
    vigile.unref();
    stops.push(async () => {
      clearInterval(vigile);
    });
  }

  return {
    lines,
    salute,
    // Concurrent, not sequential: each connector's `stop()` already carries
    // its own bounded wait against the *same* budget, so running them one
    // after another would let two slow connectors add their waits together
    // instead of sharing one clock.
    stop: (budgetMs = DRAIN_BUDGET_MS) => Promise.all(stops.map((s) => s(budgetMs))).then(() => undefined),
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
      return door(turn.id, turn.replyTo, text);
    },
    attachStream: (record) => streams.get(record.surface)?.(record),
  };
}

/**
 * Registers `send_file` (DAY-1 requirement B14) against the registry `connectSurfaces`
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
function discordVault(runtime: Runtime, root: string): NonNullable<DiscordConnectorDeps['vault']> {
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
