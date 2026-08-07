#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
import type { TrustTier } from '../core/policy/types.js';
import { loadConfig, paths, writeSecret, ConfigError, type ProviderKind } from '../core/config/config.js';

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
  muffin secret set NAME        (value on stdin)
  muffin rot verify | reseal

inspection:
  muffin memory why <fact-id> | search "<query>" | extract | stats | check
  muffin vault reindex | add <file> | ls | check
  muffin trace tail [-n N] [--errors] | grep PATTERN

Exit codes: 0 ok · 1 warnings · 2 blocking error · 3 needs approval · 78 bad configuration
`;

async function main(argv: string[]): Promise<number> {
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
    case 'memory':
      return cmdMemory(rest);
    case 'vault':
      return cmdVault(rest);
    case 'surface':
      return cmdSurface(rest);
    case 'secret':
      return cmdSecret(rest);
    case 'trace':
      return cmdTrace(rest);
    case undefined:
      // Bare `muffin` opens the REPL: the terminal is the primary surface.
      return runRepl();
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
    case '-v': {
      // GNU baseline: every CLI answers --version, and ours did not — found by
      // checking the checklist instead of assuming (docs/PRACTICES.md §3).
      const pkg = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      process.stdout.write(`muffin ${pkg.version}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 78;
  }
}

function cmdInit(argv: string[]): number {
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

  const provider = values.provider as ProviderKind | undefined;
  if (provider && provider !== 'anthropic' && provider !== 'openai-compat') {
    process.stderr.write(`--provider must be anthropic or openai-compat\n`);
    return 78;
  }

  const steps = runInit({
    ...(values.hardened ? { hardened: true } : {}),
    ...(values.force ? { force: true } : {}),
    ...(provider ? { provider } : {}),
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
    ...(values.model ? { mainModel: values.model } : {}),
    ...(values['light-model'] ? { lightModel: values['light-model'] } : {}),
    ...(values['api-key'] ? { apiKey: values['api-key'] } : {}),
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
