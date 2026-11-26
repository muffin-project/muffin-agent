import { existsSync } from 'node:fs';
import DatabaseCtor from 'better-sqlite3';
import { readGateway } from '../gateway/lock.js';
import { type EgressPolicy, hostAllowed, loadEgress } from '../net/egress.js';
import { describeChain } from './chain-describe.js';
import { ChatGPTConnection } from './chatgpt-oauth.js';
import { type Config, locateSecret, paths } from './config.js';
import { CHATGPT_SEARCH_PROVIDER, SEARCH_PROVIDERS } from './providers.js';

/**
 * Shared, read-only status collector (ADR-0114, slice 1).
 *
 * Moved out of `cli/` so Telegram `/status` (a later slice) can reuse the
 * exact same report without `agent/` importing from `cli/`. The collector
 * opens the database read-only, calls no provider, and writes nothing.
 *
 * Identity layer resolution still lives in `agent/context/identity.ts`.
 * Callers pass `identityLine` so `core/` does not import `agent/`
 * (`core/layering.test.ts`). `formatIdentityLine` keeps the wording in this
 * module so CLI and Telegram cannot drift.
 */

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

export type IdentityStatusLayers = {
  mode: 'foundation' | 'foundation+user' | 'legacy-home';
  user?: { tokens: number; overBudget: boolean } | null;
  foundationMissing?: boolean;
};

export type StatusDeps = {
  /** `muffin --version`'s answer, computed by the caller. */
  version: string;
  /** Which channel contains this build; default: omit (no channel suffix). */
  channel?: () => string | null;
  now?: number;
  /**
   * One-line identity status. Required so this module stays free of `agent/`
   * imports; use `formatIdentityLine(resolveIdentityLayers(home))`.
   */
  identityLine: (home: string) => string;
};

const TENANT = 'host';

/** Same ceiling as `USER_OVERLAY_TOKEN_BUDGET` in the identity overlay (ADR-0112). */
export const STATUS_USER_TOKEN_BUDGET = 1000;

export function formatIdentityLine(
  layers: IdentityStatusLayers,
  tokenBudget: number = STATUS_USER_TOKEN_BUDGET,
): string {
  switch (layers.mode) {
    case 'foundation':
      return 'fondazione dal prodotto · nessun user.md';
    case 'foundation+user': {
      const tokens = layers.user?.tokens ?? 0;
      return layers.user?.overBudget
        ? `fondazione + user.md OLTRE il tetto (${String(tokens)}/${String(tokenBudget)} token): non caricato`
        : `fondazione dal prodotto + user.md (${String(tokens)}/${String(tokenBudget)} token)`;
    }
    case 'legacy-home':
      return layers.foundationMissing
        ? 'solo rot/identity.md: questa build non ha la fondazione → muffin update'
        : 'rot/identity.md modificato sostituisce ancora la fondazione → muffin rot migrate';
  }
}

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

/**
 * Local, read-only ChatGPT search readiness — the same facts
 * `diagnoseConfiguredSearch` uses, without building a search backend or
 * touching the network.
 */
function chatGPTSearchLine(config: Config, home: string): string {
  let egress: EgressPolicy;
  try {
    egress = loadEgress(home);
  } catch {
    egress = { allow: [] };
  }
  if (config.provider.kind !== 'openai-chatgpt') {
    return 'ChatGPT · ChatGPT is not selected as the main provider → muffin doctor';
  }
  let connected = false;
  try {
    connected = new ChatGPTConnection(home).session()?.connected === true;
  } catch {
    connected = false;
  }
  if (!connected) {
    return 'ChatGPT · ChatGPT plan permission is unavailable → muffin doctor';
  }
  const endpointHost = new URL(CHATGPT_SEARCH_PROVIDER.endpoint).hostname;
  if (!hostAllowed(endpointHost, egress)) {
    return `ChatGPT · ${endpointHost} non è in rot/egress.json → muffin doctor`;
  }
  return 'ChatGPT · quota del piano';
}

function searchLine(config: Config, home: string): string {
  const search = config.search;
  if (search === undefined) return 'spenta → muffin search';
  if (search.provider === CHATGPT_SEARCH_PROVIDER.id) return chatGPTSearchLine(config, home);
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

export function collectStatus(home: string, config: Config, deps: StatusDeps): StatusReport {
  const now = deps.now ?? Date.now();
  const channel = deps.channel?.() ?? null;
  const chain = describeChain(config, 'main', home, now);
  return {
    versione: channel === null ? deps.version : `${deps.version} · canale ${channel}`,
    home,
    gateway: gatewayLine(home, now),
    modelli: chain.lines,
    degradato: chain.degraded,
    identita: deps.identityLine(home),
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
