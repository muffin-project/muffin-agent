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
import { cmdObserve } from './observe.js';
import type { TrustTier } from '../core/policy/types.js';
import { loadConfig, paths, writeSecret, ConfigError, type ProviderKind } from '../core/config/config.js';
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
  muffin mcp list [--verify] | add <name> [--env K=V]... -- <cmd> [args...] | remove <name>
  muffin secret set NAME        (value on stdin)
  muffin rot verify | reseal
  muffin uninstall [--yes]      remove ~/.muffin (config, keys, memory)

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
 * so the model key survives a `muffin uninstall` and onboarding can be re-run
 * without re-pasting. Real environment variables win (verified against Node 22:
 * loadEnvFile does not override an already-set value); a missing file is a
 * no-op, so production — which ships no .env — is untouched. Node 22 native, no
 * dotenv dependency.
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

  // Acquire the key: flag > env > an interactive prompt on a terminal. A missing
  // key is not fatal — runInit records the step as incomplete and the user can
  // re-run — but on a TTY we ask rather than fail, which is the whole point of a
  // first run (the init.ts docstring promised this; it was never implemented).
  let apiKey = values['api-key'] ?? process.env['MUFFIN_API_KEY'];
  if (!apiKey && process.stdin.isTTY) {
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

  const provider = providerFlag ?? inferProvider(apiKey);
  const baseUrl =
    values['base-url'] ?? (isOpenRouterKey(apiKey) && !providerFlag ? OPENROUTER_BASE_URL : undefined);

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
  process.stderr.write(`\nNext: muffin doctor\n`);
  return 0;
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
  rmSync(home, { recursive: true, force: true });
  process.stderr.write(`Removed ${home}.\n`);
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
  const [sub, name] = argv;
  if (sub !== 'set' || !name) {
    process.stderr.write(`usage: muffin secret set NAME  (value on stdin)\n`);
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
  writeSecret(name, value);
  process.stdout.write(`stored ${name} (0600), ${value.length} chars\n`);
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
