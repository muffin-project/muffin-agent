#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatReport, runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { seal, verify } from '../core/rot/verify.js';
import { formatSpan, readSpans } from './trace.js';
import { runHeadless } from './run.js';
import { runRepl } from './repl.js';
import {
  cmdMemoryCheck,
  cmdMemoryExtract,
  cmdMemorySearch,
  cmdMemoryStats,
  cmdMemoryWhy,
  MEMORY_USAGE,
} from './memory.js';
import { cmdVaultAdd, cmdVaultCheck, cmdVaultLs, cmdVaultReindex, VAULT_USAGE } from './vault.js';
import { cmdSurfaceDisable, cmdSurfaceEnable, cmdSurfaceList, SURFACE_USAGE } from './surface.js';
import { cmdMcpAdd, cmdMcpList, cmdMcpRemove, MCP_USAGE } from './mcp.js';
import { cmdJobsAdd, cmdJobsList, cmdJobsRemove, JOBS_USAGE } from './jobs.js';
import {
  cmdGatewayInstall,
  cmdGatewayRun,
  cmdGatewayStatus,
  cmdGatewayStop,
  GATEWAY_USAGE,
} from './gateway.js';
import { cmdObserve } from './observe.js';
import type { TrustTier } from '../core/policy/types.js';
import {
  loadConfig,
  locateSecret,
  locateSecretAll,
  paths,
  writeSecret,
  ConfigError,
  type ProviderKind,
} from '../core/config/config.js';
import { promptLine, promptSecret } from './prompt.js';
import { inferProvider, isOpenRouterKey, keyHint, looksLikeTelegramToken, OPENROUTER_BASE_URL } from './onboarding.js';

/**
 * Entry point.
 *
 * stdout carries the answer, stderr carries everything else, and the exit code
 * means something — this thing has to be scriptable before it is conversational.
 */

const USAGE = `muffin — personal agent runtime

  muffin (or: muffin repl)      start the agent: REPL + every enabled surface
  muffin run "<goal>"           one goal, headless, meaningful exit code
                                [--json] [--session ID] [--timeout S]

operator commands:
  muffin init [--hardened] [--force] [--provider anthropic|openai-compat]
              [--base-url URL] [--model NAME] [--light-model NAME] [--api-key KEY]
  muffin doctor [--json]
  muffin surface list | enable telegram [--owner <chat-id>] | disable telegram
  muffin gateway status | stop | install [--write]
                                il processo che tiene vivi i job quando non hai
                                nessuna finestra aperta. \`muffin init\` propone
                                di installarlo; \`run\` lo lancia il supervisore.
  muffin mcp list [--verify] | add <name> [--env K=V]... -- <cmd> [args...] | remove <name>
  muffin secret set NAME [--persist]
                                (value on stdin) --persist lo scrive fuori da
                                ~/.muffin, così sopravvive a \`uninstall\` e
                                \`init\` lo ritrova senza re-incollarlo
  muffin rot verify | reseal
  muffin uninstall [--yes]      remove ~/.muffin (config, keys, memory). Una
                                chiave scritta con --persist vive fuori: resta,
                                e il comando lo dice.

inspection:
  muffin memory why <fact-id> | search "<query>" | extract | stats | check
  muffin vault reindex | add <file> | ls | check
  muffin jobs list | add --cron "<expr>" [--tz] [--channel] "<goal>" | remove <id>
  muffin observe [--send]       what has gone quiet, and what the proactivity
                                gate would do with it. Sends only with --send.
  muffin trace tail [-n N] [--errors] | grep PATTERN

Exit codes: 0 ok · 1 warnings · 2 blocking error · 3 needs approval · 78 bad configuration
`;

/**
 * package.json sits one level above `cli/` in source but two levels above once
 * compiled to `dist/cli/`. Walk up until we find it so `--version` answers the
 * same whether run via tsx or the built `muffin` bin.
 */
function readOwnVersion(): string {
  let dir = new URL('./', import.meta.url);
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')) as { version: string };
      return pkg.version;
    } catch {
      dir = new URL('../', dir);
    }
  }
  return '0.0.0';
}

/**
 * Load a .env from the working directory if present — a development convenience
 * for non-secret variables (`MUFFIN_HOME` above all, which is how dev and prod
 * are separated). Real environment variables win (verified against Node 22:
 * loadEnvFile does not override an already-set value); a missing file is a
 * no-op, so production — which ships no .env — is untouched. Node 22 native, no
 * dotenv dependency.
 *
 * **It is no longer where the model key goes** (ADR-0039 amends ADR-0030). The
 * key survived a `muffin uninstall` by living here, which worked — and put the
 * plaintext key inside `root`, the directory `fs_read` is scoped to, at a taint
 * ceiling of 3. `muffin secret set --persist` replaces it. The loader stays,
 * because `MUFFIN_HOME` in a `.env` is a real convenience and carries nothing
 * secret; a key left here anyway still works, and is on the tools' deny-read
 * list so it cannot be read back by the agent.
 */
function loadDotenvIfPresent(): void {
  const envPath = `${process.cwd()}/.env`;
  if (!existsSync(envPath)) return;
  const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  try {
    load?.(envPath);
  } catch {
    // A malformed .env must not stop the CLI from starting.
  }
}

async function main(argv: string[]): Promise<number> {
  loadDotenvIfPresent();
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return cmdRun(rest);
    case 'repl':
      return runRepl();
    case 'init':
      return cmdInit(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'rot':
      return cmdRot(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    case 'memory':
      return cmdMemory(rest);
    case 'vault':
      return cmdVault(rest);
    case 'surface':
      return cmdSurface(rest);
    case 'mcp':
      return cmdMcp(rest);
    case 'jobs':
      return cmdJobs(rest);
    case 'gateway':
      return cmdGateway(rest);
    case 'observe':
      return cmdObserve(paths().home, rest);
    case 'secret':
      return cmdSecret(rest);
    case 'trace':
      return cmdTrace(rest);
    case undefined: {
      // Bare `muffin` opens the REPL — but on a first run there is no config to
      // open it with. Detect that and route into setup instead of failing with a
      // stack trace the user cannot act on.
      if (!existsSync(paths().config)) return firstRun();
      return runRepl();
    }
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
    case '-v': {
      // GNU baseline: every CLI answers --version (docs/PRACTICES.md §3).
      process.stdout.write(`muffin ${readOwnVersion()}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 78;
  }
}

async function cmdInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      hardened: { type: 'boolean' },
      force: { type: 'boolean' },
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'light-model': { type: 'string' },
      'api-key': { type: 'string' },
    },
    allowPositionals: false,
  });

  const providerFlag = values.provider as ProviderKind | undefined;
  if (providerFlag && providerFlag !== 'anthropic' && providerFlag !== 'openai-compat') {
    process.stderr.write(`--provider must be anthropic or openai-compat\n`);
    return 78;
  }

  // Acquire the key: flag > env > an already-stored secret > an interactive
  // prompt on a terminal. A missing key is not fatal — runInit records the step
  // as incomplete and the user can re-run — but on a TTY we ask rather than
  // fail, which is the whole point of a first run (the init.ts docstring
  // promised this; it was never implemented).
  //
  // The stored-secret step is what makes `muffin uninstall --yes && muffin init`
  // a loop again now that the key no longer has to sit in a `.env` the agent can
  // read: `--persist` put it outside the home the wipe reaches, so the chain
  // answers and nothing is prompted or copied.
  let apiKey = values['api-key'] ?? process.env['MUFFIN_API_KEY'];
  const stored = apiKey ? null : locateSecret('secret://provider_api_key');
  if (stored) {
    process.stderr.write(`✓ chiave già presente (${stored.backend}): ${stored.path}\n`);
  }
  if (!apiKey && !stored && process.stdin.isTTY) {
    process.stderr.write(keyHint(providerFlag, values['base-url']));
    apiKey = await promptSecret('API key (hidden — paste, or Enter to skip): ');
  }

  // Infer the provider from the key when the user did not pin one, and default an
  // OpenRouter key to its gateway URL. An explicit flag always wins over both.
  // Catch the mistake before it becomes a confusing 401 at the first message.
  if (apiKey && !providerFlag) {
    if (looksLikeTelegramToken(apiKey)) {
      process.stderr.write(
        `! that looks like a Telegram bot token, not a model API key — not storing it.\n` +
          `  The model key is an OpenRouter (sk-or-…) or Anthropic (sk-ant-…) key: https://openrouter.ai/keys\n` +
          `  A bot token goes elsewhere: muffin secret set telegram_token\n`,
      );
      apiKey = undefined;
    } else if (inferProvider(apiKey) === undefined) {
      process.stderr.write(
        `! that key isn't sk-or- or sk-ant-, so the provider defaults to anthropic.\n` +
          `  If that is wrong, re-run with a valid key or --provider.\n`,
      );
    }
  }

  // The provider is inferred from the key's prefix, so a key that is only
  // *stored* still has to be looked at — otherwise the dev loop that this whole
  // change exists to preserve would start writing `anthropic` for an OpenRouter
  // key the moment the `.env` went away, and ADR-0036 already named where that
  // surfaces: not at setup, but at the first call to the model. Read, never
  // printed, never re-written (`runInit` gets no `apiKey`, so nothing is copied).
  const keyForInference =
    apiKey ?? (stored ? readFileSync(stored.path, 'utf8').trim() : undefined);
  const provider = providerFlag ?? inferProvider(keyForInference);
  const baseUrl =
    values['base-url'] ??
    (isOpenRouterKey(keyForInference) && !providerFlag ? OPENROUTER_BASE_URL : undefined);

  const steps = runInit({
    ...(values.hardened ? { hardened: true } : {}),
    ...(values.force ? { force: true } : {}),
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(values.model ? { mainModel: values.model } : {}),
    ...(values['light-model'] ? { lightModel: values['light-model'] } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  for (const s of steps) process.stderr.write(`${s.done ? '✓' : '!'} ${s.name.padEnd(16)} ${s.detail}\n`);
  const incomplete = steps.filter((s) => !s.done);
  if (incomplete.length > 0) {
    process.stderr.write(`\nRun \`muffin init\` again once resolved — it picks up where it left off.\n`);
    return 1;
  }

  await offerGateway();
  process.stderr.write(`\nNext: muffin doctor\n`);
  return 0;
}

/**
 * The one question that decides whether Muffin is a process or a command.
 *
 * ADR-0035 says to print the unit rather than enable it silently, and that is
 * right about consent and wrong about ergonomics: a manual step at the end of a
 * setup is a step nobody takes — owner, verbatim, about exactly these commands:
 * *"non lancerò mai quei comandi a mano."* A gateway nobody installs leaves the
 * scheduler where it was, which is the defect this whole slice exists to close.
 *
 * So it is asked here, once, inside a setup the owner is already sitting
 * through — still their explicit act, just at the moment they are present. Off
 * a TTY it prints the command instead and installs nothing: `promptLine`
 * returns undefined on a pipe, which is the same rule `cmdInit` uses for the
 * API key and `install.sh` uses for the wizard. An installer that wrote a
 * service unit into a scripted run would be doing exactly what the ADR forbids.
 */
async function offerGateway(): Promise<void> {
  const answer = await promptLine(
    '\nInstallo il gateway, così i job girano anche a finestra chiusa? [Y/n] ',
  );
  if (answer === undefined) {
    process.stderr.write(`\nPer far girare i job senza una finestra aperta:\n  muffin gateway install --write\n`);
    return;
  }
  if (answer !== '' && !/^(y(es)?|s(i|ì)?)$/i.test(answer)) {
    process.stderr.write(`Va bene. Quando vuoi:\n  muffin gateway install\n`);
    return;
  }
  // `--write` and not the enable: writing the file is what the owner just
  // agreed to, and loading it into the supervisor stays their command. The
  // difference matters — one is a file in their home, the other is a service.
  cmdGatewayInstall(paths().home, ['--write']);
}

/**
 * A bare `muffin` with no config is someone's first run. Ask before doing
 * anything (Hermes' pattern — not a silent launch, not a bare error), and off a
 * terminal print the one command to run instead of hanging on a pipe.
 */
async function firstRun(): Promise<number> {
  const answer = await promptLine("Muffin isn't set up on this machine yet. Set it up now? [Y/n] ");
  if (answer === undefined) {
    process.stderr.write('Muffin is not configured. Run:\n  muffin init\n');
    return 78;
  }
  if (answer !== '' && !/^y(es)?$/i.test(answer)) {
    process.stderr.write('Run `muffin init` when ready.\n');
    return 0;
  }
  const code = await cmdInit([]);
  if (code !== 0) return code; // init already said what is missing
  process.stderr.write('\nStarting Muffin.\n');
  return runRepl();
}

async function cmdUninstall(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean' } }, allowPositionals: false });
  const home = paths().home;
  if (!existsSync(home)) {
    process.stderr.write(`Nothing to remove: ${home} does not exist.\n`);
    return 0;
  }
  // Deleting keys and memory is not something a pipe should trigger by accident.
  if (!values.yes) {
    const answer = await promptLine(`Delete ${home} and everything in it — config, keys, memory? [y/N] `);
    if (answer === undefined) {
      process.stderr.write(`Refusing to delete without confirmation on a pipe. Re-run with --yes.\n`);
      return 78;
    }
    if (!/^y(es)?$/i.test(answer)) {
      process.stderr.write(`Cancelled.\n`);
      return 0;
    }
  }
  // Every backend, not the first one that answers: a home copy shadows the
  // persistent one in the read chain, and the whole point of this line is the
  // copy that the wipe does *not* reach.
  const persistent = locateSecretAll('secret://provider_api_key', home).find((l) => l.backend === 'persistent');
  rmSync(home, { recursive: true, force: true });
  process.stderr.write(`Removed ${home}.\n`);
  // The message used to say "config, keys, memory" and that is now half true:
  // a `--persist` key lives outside this directory on purpose — it is what makes
  // `uninstall && init` a loop instead of a re-paste. Saying so is the price of
  // the convenience; an uninstall that quietly leaves a credential behind is the
  // kind of surprise that ends trust in the command.
  if (persistent) {
    process.stderr.write(
      `La chiave persistente resta: ${persistent.path}\n` +
        `  (è ciò che fa ritrovare la chiave a \`muffin init\`; cancellala a mano se non la vuoi)\n`,
    );
  }
  process.stderr.write(`The muffin command itself is still installed; to remove it too: ./install.sh --uninstall\n`);
  return 0;
}

function cmdDoctor(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, online: { type: 'boolean' } },
    allowPositionals: false,
  });
  const report = runDoctor(paths().home, values.online ? { online: true } : {});
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  return report.exitCode;
}

function cmdRot(argv: string[]): number {
  const [sub] = argv;
  let mode: 'hardened' | 'single-user' = 'single-user';
  try {
    mode = loadConfig().rot.mode;
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    return 78;
  }

  if (sub === 'verify') {
    const outcome = verify(paths().home, mode);
    if (outcome.ok) {
      process.stdout.write(`root of trust intact: ${outcome.fileCount} files, mode ${outcome.mode}\n`);
      return 0;
    }
    process.stderr.write(
      `root of trust diverged (${outcome.reason}):\n` +
        outcome.diverged.map((f) => `  ${f}\n`).join('') +
        `→ ${outcome.remedy}\n`,
    );
    return outcome.action === 'refuse' ? 2 : 1;
  }

  if (sub === 'reseal') {
    const manifest = seal(paths().home, '1', new Date());
    process.stdout.write(`resealed ${manifest.files.length} files — the change is now yours and declared\n`);
    return 0;
  }

  process.stderr.write(`usage: muffin rot verify | reseal\n`);
  return 78;
}

async function cmdMemory(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;

  if (sub === 'why') {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`usage: muffin memory why <fact-id>\n`);
      return 78;
    }
    return cmdMemoryWhy(home, id);
  }

  if (sub === 'stats') return cmdMemoryStats(home);

  if (sub === 'extract') {
    const { values } = parseArgs({ args: rest, options: { limit: { type: 'string' } } });
    return cmdMemoryExtract(home, Number(values.limit ?? 200));
  }

  if (sub === 'check') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
    return cmdMemoryCheck(home, values.json === true);
  }

  if (sub === 'search') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { n: { type: 'string', short: 'n' }, history: { type: 'boolean' } },
      allowPositionals: true,
    });
    const query = positionals.join(' ').trim();
    if (query === '') {
      process.stderr.write(`usage: muffin memory search "<query>"\n`);
      return 78;
    }
    return cmdMemorySearch(home, query, {
      ...(values.n ? { limit: Number(values.n) } : {}),
      ...(values.history ? { history: true } : {}),
    });
  }

  process.stderr.write(MEMORY_USAGE);
  return 78;
}

async function cmdVault(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { tier: { type: 'string' } },
    allowPositionals: true,
  });

  const tier = Number(values.tier ?? 0);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    process.stderr.write(`--tier deve essere 0, 1, 2 o 3\n`);
    return 78;
  }

  if (sub === 'reindex') return cmdVaultReindex(home, tier as TrustTier);
  if (sub === 'ls') return cmdVaultLs(home);
  if (sub === 'check') return cmdVaultCheck(home);
  if (sub === 'add') {
    const file = positionals[0];
    if (!file) {
      process.stderr.write(`usage: muffin vault add <file> [--tier N]\n`);
      return 78;
    }
    return cmdVaultAdd(home, file, tier as TrustTier);
  }

  process.stderr.write(VAULT_USAGE);
  return 78;
}

async function cmdGateway(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'run') return cmdGatewayRun(home);
  if (sub === 'status' || sub === undefined) return cmdGatewayStatus(home);
  if (sub === 'stop') return cmdGatewayStop(home);
  if (sub === 'install') return cmdGatewayInstall(home, rest);
  process.stderr.write(GATEWAY_USAGE);
  return 78;
}

function cmdJobs(argv: string[]): number {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) return cmdJobsList(home);
  if (sub === 'add') return cmdJobsAdd(home, rest);
  if (sub === 'remove' && rest[0]) return cmdJobsRemove(home, rest[0]);
  process.stderr.write(JOBS_USAGE);
  return 78;
}

async function cmdMcp(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) {
    return cmdMcpList(home, rest.includes('--verify'));
  }
  if (sub === 'remove' && rest[0]) return cmdMcpRemove(home, rest[0]);
  if (sub === 'add' && rest[0]) {
    const name = rest[0];
    // Everything after `--` is the server's own command line, untouched — its
    // flags are not ours to parse. Before it: only repeatable --env K=V.
    const sep = rest.indexOf('--');
    const flags = sep === -1 ? rest.slice(1) : rest.slice(1, sep);
    const commandLine = sep === -1 ? [] : rest.slice(sep + 1);
    const env: Record<string, string> = {};
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] !== '--env' || !flags[i + 1]?.includes('=')) {
        process.stderr.write(MCP_USAGE);
        return 78;
      }
      const eq = flags[i + 1]!.indexOf('=');
      env[flags[i + 1]!.slice(0, eq)] = flags[i + 1]!.slice(eq + 1);
      i++;
    }
    return cmdMcpAdd(home, name, commandLine[0], commandLine.slice(1), env);
  }
  process.stderr.write(MCP_USAGE);
  return 78;
}

async function cmdSurface(argv: string[]): Promise<number> {
  const [sub, id, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) return cmdSurfaceList(home);
  if (sub === 'enable' && id) {
    const { values } = parseArgs({ args: rest, options: { owner: { type: 'string' } } });
    return cmdSurfaceEnable(home, id, values.owner);
  }
  if (sub === 'disable' && id) return cmdSurfaceDisable(home, id);
  process.stderr.write(SURFACE_USAGE);
  return 78;
}

function cmdSecret(argv: string[]): number {
  const [sub, ...rest] = argv;
  const persist = rest.includes('--persist');
  const name = rest.find((a) => !a.startsWith('-'));
  if (sub !== 'set' || !name) {
    process.stderr.write(`usage: muffin secret set NAME [--persist]  (value on stdin)\n`);
    return 78;
  }
  // Read from stdin, never from argv: a key in a shell argument is a key in the
  // shell history and in every `ps` on the machine.
  let value = '';
  try {
    value = readFileSync(0, 'utf8').trim();
  } catch {
    /* empty stdin falls through to the check below */
  }
  if (!value) {
    process.stderr.write(`no value on stdin — pipe it: echo -n "$KEY" | muffin secret set ${name}\n`);
    return 78;
  }
  // Default is this home's own store, so the command keeps meaning what it
  // meant and `muffin uninstall` keeps deleting what it says it deletes.
  // `--persist` is the opt-in that replaces the `.env`: outside the wiped home,
  // outside the working directory, 0700/0600, and on the tools' deny-read list.
  const at = writeSecret(name, value, paths().home, persist ? 'persistent' : 'home');
  process.stdout.write(`stored ${name} (0600), ${value.length} chars → ${at}\n`);
  return 0;
}

function cmdTrace(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub !== 'tail' && sub !== 'grep') {
    process.stderr.write(`usage: muffin trace tail [-n N] [--errors] | muffin trace grep PATTERN\n`);
    return 78;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      n: { type: 'string', short: 'n' },
      errors: { type: 'boolean' },
      json: { type: 'boolean' },
      trace: { type: 'string' },
    },
    allowPositionals: true,
  });

  const pattern = sub === 'grep' ? positionals[0] : undefined;
  if (sub === 'grep' && !pattern) {
    process.stderr.write(`usage: muffin trace grep PATTERN\n`);
    return 78;
  }

  const spans = readSpans(paths().home, {
    limit: Number(values.n ?? 40),
    ...(pattern ? { pattern } : {}),
    ...(values.trace ? { traceId: values.trace } : {}),
    ...(values.errors ? { errorsOnly: true } : {}),
  });

  if (spans.length === 0) {
    process.stderr.write(`no spans matched\n`);
    return 1;
  }
  process.stdout.write(
    values.json
      ? `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`
      : `${spans.map(formatSpan).join('\n')}\n`,
  );
  return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
      session: { type: 'string' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });
  const goal = positionals.join(' ').trim();
  if (goal === '') {
    process.stderr.write(`usage: muffin run "<goal>"\n`);
    return 78;
  }
  return runHeadless({
    goal,
    ...(values.json ? { json: true } : {}),
    ...(values.session ? { sessionId: values.session } : {}),
    ...(values.timeout ? { timeoutSeconds: Number(values.timeout) } : {}),
  });
}

process.exitCode = await main(process.argv.slice(2));
