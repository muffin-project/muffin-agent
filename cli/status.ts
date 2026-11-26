import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import DatabaseCtor from 'better-sqlite3';
import { resolveIdentityLayers, USER_OVERLAY_TOKEN_BUDGET } from '../agent/context/identity.js';
import { diagnoseConfiguredSearch } from '../agent/search-readiness.js';
import {
  type Config,
  ConfigError,
  loadConfig,
  locateSecret,
  paths,
} from '../core/config/config.js';
import { CHATGPT_SEARCH_PROVIDER, SEARCH_PROVIDERS } from '../core/config/providers.js';
import { readGateway } from '../core/gateway/lock.js';
import { type EgressPolicy, loadEgress } from '../core/net/egress.js';
import { describeChain } from './fallback.js';
import { findCheckoutRoot, type GitRunner } from './git-root.js';
import { describeBuild } from './update.js';

/**
 * `muffin status`: the few lines an owner wants before deciding whether to
 * open `muffin doctor`. Read-only — it opens the database readonly, calls no
 * provider and writes nothing — and every line is a sentence, not a probe
 * name. Anything that needs a remedy points at the command that has it.
 */

export const STATUS_USAGE = `uso: muffin status [--json]
  Riassunto in poche righe: versione e canale, gateway, catena dei modelli,
  identità, ricerca web, embedding, memoria. Non chiama provider e non scrive niente.
  Per la diagnosi completa: muffin doctor`;

export type StatusReport = {
  versione: string;
  home: string;
  gateway: string;
  modelli: string[];
  /** The main lane's primary connection is paused right now. */
  degradato: boolean;
  identita: string;
  ricerca: string;
  embedding: string;
  memoria: string;
};

export type StatusDeps = {
  out: (line: string) => void;
  /** `muffin --version`'s answer, computed by the caller. */
  version: string;
  /** Which channel contains this build; default: local Git refs, never a fetch. */
  channel?: () => string | null;
  now?: number;
};

const TENANT = 'host';

const realGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function gatewayLine(home: string, now: number): string {
  const p = paths(home);
  if (existsSync(p.db)) {
    let db: DatabaseCtor.Database | undefined;
    try {
      db = new DatabaseCtor(p.db, { readonly: true, fileMustExist: true });
      const info = readGateway(db, new Date(now));
      if (info !== null) {
        const beat = Math.max(0, Math.round((now - info.lastBeat.getTime()) / 1000));
        return `attivo · pid ${String(info.pid)} · ultimo battito ${String(beat)}s fa`;
      }
    } catch {
      return 'non leggibile (database occupato o rovinato) → muffin doctor';
    } finally {
      db?.close();
    }
  }
  if (existsSync(p.gatewayStopped)) return 'fermo di proposito → muffin gateway start';
  return 'spento: i job girano solo con una sessione aperta → muffin gateway install';
}

function identityLine(home: string): string {
  const layers = resolveIdentityLayers(home);
  switch (layers.mode) {
    case 'foundation':
      return 'fondazione dal prodotto · nessun user.md';
    case 'foundation+user': {
      const tokens = layers.user?.tokens ?? 0;
      return layers.user?.overBudget
        ? `fondazione + user.md OLTRE il tetto (${String(tokens)}/${String(USER_OVERLAY_TOKEN_BUDGET)} token): non caricato`
        : `fondazione dal prodotto + user.md (${String(tokens)}/${String(USER_OVERLAY_TOKEN_BUDGET)} token)`;
    }
    case 'legacy-home':
      return layers.foundationMissing
        ? 'solo rot/identity.md: questa build non ha la fondazione → muffin update'
        : 'rot/identity.md modificato sostituisce ancora la fondazione → muffin rot migrate';
  }
}

function searchLine(config: Config, home: string): string {
  const search = config.search;
  if (search === undefined) return 'spenta → muffin search';
  if (search.provider === CHATGPT_SEARCH_PROVIDER.id) {
    let egress: EgressPolicy;
    try {
      egress = loadEgress(home);
    } catch {
      egress = { allow: [] };
    }
    const d = diagnoseConfiguredSearch(config, egress, home);
    return d.on
      ? 'ChatGPT · quota del piano'
      : `ChatGPT · ${d.gap?.reason ?? 'non pronta'} → muffin doctor`;
  }
  const entry = SEARCH_PROVIDERS[search.provider];
  let found = false;
  try {
    found = locateSecret(search.apiKeyRef, home) !== null;
  } catch {
    found = false;
  }
  return found ? entry.label : `${entry.label} · chiave mancante → muffin search ${entry.id}`;
}

function embeddingLine(config: Config): string {
  const emb = config.embedder;
  if (emb?.enabled === false) return 'spenti · ricerca testuale attiva';
  if (emb === undefined)
    return 'ollama (default) · servono Ollama acceso, o `muffin model embed off`';
  return `${emb.kind}${emb.model ? `:${emb.model}` : ''}`;
}

function memoryLine(home: string): string {
  const file = paths(home).db;
  if (!existsSync(file)) return 'vuota (nessun database ancora)';
  let db: DatabaseCtor.Database | undefined;
  try {
    const open = new DatabaseCtor(file, { readonly: true, fileMustExist: true });
    db = open;
    const count = (sql: string): number | null => {
      try {
        return (open.prepare(sql).get(TENANT) as { v: number }).v;
      } catch {
        return null;
      }
    };
    const facts = count(
      'SELECT count(*) AS v FROM facts WHERE tenant_id = ? AND expired_at IS NULL',
    );
    const episodes = count('SELECT count(*) AS v FROM episodes WHERE tenant_id = ?');
    if (facts === null && episodes === null) return 'vuota';
    return `${String(facts ?? 0)} fatti attivi · ${String(episodes ?? 0)} episodi`;
  } catch {
    return 'non leggibile → muffin doctor';
  } finally {
    db?.close();
  }
}

/**
 * The channel that already contains this build, from local refs only
 * (`origin/main`, then `origin/dev`): no fetch, so it says what the last
 * `muffin update` saw. ADR-0057 keeps the channel a per-invocation choice,
 * never a stored setting, so this is read from Git rather than config.
 */
export function channelOf(moduleDir: string, git: GitRunner = realGit): string | null {
  const root = findCheckoutRoot(moduleDir, git);
  const build = describeBuild(moduleDir, git);
  if (root === null || build === null) return null;
  for (const channel of ['main', 'dev']) {
    const r = git(
      ['merge-base', '--is-ancestor', build.sha, `refs/remotes/origin/${channel}`],
      root,
    );
    if (r.status === 0) return channel === 'main' ? 'main' : 'dev (non ancora promosso su main)';
  }
  return 'build locale (non su origin/main né origin/dev)';
}

export function collectStatus(home: string, config: Config, deps: StatusDeps): StatusReport {
  const now = deps.now ?? Date.now();
  const channel = (deps.channel ?? (() => channelOf(dirname(fileURLToPath(import.meta.url)))))();
  const chain = describeChain(config, 'main', home, now);
  return {
    versione: channel === null ? deps.version : `${deps.version} · canale ${channel}`,
    home,
    gateway: gatewayLine(home, now),
    modelli: chain.lines,
    degradato: chain.degraded,
    identita: identityLine(home),
    ricerca: searchLine(config, home),
    embedding: embeddingLine(config),
    memoria: memoryLine(home),
  };
}

export function formatStatus(r: StatusReport): string[] {
  const row = (label: string, value: string) => `${label.padEnd(10)} ${value}`;
  const [first, ...rest] = r.modelli;
  return [
    row('versione', r.versione),
    row('home', r.home),
    row('gateway', r.gateway),
    row('modelli', first ?? 'nessuno configurato → muffin model'),
    ...rest.map((line) => `${' '.repeat(11)}${line}`),
    row('identità', r.identita),
    row('ricerca', r.ricerca),
    row('embedding', r.embedding),
    row('memoria', r.memoria),
    '',
    'Dettagli e rimedi: muffin doctor',
  ];
}

export function cmdStatus(home: string, argv: string[], deps: StatusDeps): number {
  let json = false;
  try {
    json =
      parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false })
        .values.json === true;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${STATUS_USAGE}\n`);
    return 78;
  }
  let config: Config;
  try {
    config = loadConfig(home);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`Muffin non è ancora configurato qui (${message}).\n→ muffin init\n`);
    return 78;
  }
  const report = collectStatus(home, config, deps);
  if (json) {
    deps.out(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const line of formatStatus(report)) deps.out(line);
  return 0;
}
