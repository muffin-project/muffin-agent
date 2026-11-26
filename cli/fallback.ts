import { AuthProfileError, keySecretName } from '../core/config/auth-profile.js';
import {
  type Config,
  type FallbackLink,
  type InferenceLane,
  inferenceChain,
  loadConfig,
  locateSecret,
  saveConfig,
} from '../core/config/config.js';
import {
  catalogLink,
  clearChainPauses,
  type FailoverReason,
  linkId,
  linkLabel,
  readChainState,
} from '../core/config/provider-chain.js';
import { PROVIDERS, providerFor } from '../core/config/providers.js';
import { XAI_OAUTH_REF, XAI_OAUTH_SECRET, XaiOAuthConnection } from '../core/config/xai-oauth.js';

/**
 * `muffin fallback` — the owner's whole interface to provider chains (ADR-0110).
 *
 * Three verbs and no flags beyond the lane and the account, because the owner
 * asked for fewer commands, not more: list, add, remove. Providers are named
 * by their catalog id; the endpoint, adapter and secret name come from the
 * catalog, so nothing provider-specific is typed or hardcoded here.
 */

export const FALLBACK_USAGE = `usage:
  muffin fallback                                   show the chains and which link is serving
  muffin fallback add <provider> <model> [--light] [--account <id>]
  muffin fallback remove <provider|position> [--light]
  muffin fallback reset [--light|--main]            clear every pause now (account fixed)
providers: ${Object.keys(PROVIDERS).join(', ')}`;

const REASON_TEXT: Readonly<Record<FailoverReason, string>> = {
  quota: 'quota/piano esaurito',
  auth: 'accesso da rifare o credenziale mancante',
  rate_limit: 'troppe richieste',
  outage: 'servizio non raggiungibile',
};

/** Local time with the zone it is in, so a pause read over SSH is not ambiguous. */
function when(epochMs: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = new Date(epochMs).toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  });
  return `${text} (${zone})`;
}

/** How to give a link its credential, from the catalog — never a guess. */
export function credentialRemedy(link: FallbackLink): string {
  const entry = providerFor(link.provider);
  if (link.provider.kind === 'openai-chatgpt') return 'muffin chatgpt login';
  const name = link.provider.apiKeyRef.replace(/^secret:\/\//, '');
  if (entry?.id === 'openrouter') return 'muffin auth login openrouter';
  if (entry?.id === 'xai' && link.provider.apiKeyRef === XAI_OAUTH_REF)
    return 'muffin auth login xai';
  if (entry?.id === 'xai' && name === PROVIDERS.xai.secretName)
    return `muffin auth login xai (oppure muffin secret set ${name})`;
  return `muffin secret set ${name}`;
}

/** The xAI login is present and xAI has not refused its refresh token. */
export function xaiLoginUsable(home: string): boolean {
  try {
    const status = new XaiOAuthConnection(home).status();
    return status.connected && !status.needsLogin;
  } catch {
    return false;
  }
}

function credentialPresent(link: FallbackLink, home: string): boolean {
  try {
    if (link.provider.apiKeyRef === XAI_OAUTH_REF) return xaiLoginUsable(home);
    return locateSecret(link.provider.apiKeyRef, home) !== null;
  } catch {
    return false;
  }
}

/**
 * One line per link, in priority order, with what is serving and why the
 * others are not. Shared by `muffin fallback`, `muffin model` and `doctor`.
 */
export function describeChain(
  config: Config,
  lane: InferenceLane,
  home: string,
  now = Date.now(),
): { lines: string[]; degraded: boolean; missing: FallbackLink[] } {
  const chain = inferenceChain(config, lane);
  const state = readChainState(home).lanes[lane];
  const ids = chain.map((link) => linkId(link));
  // Only a recorded answer is reported as one: a lane that never failed over
  // has no record, and its first link is simply the one that will be tried.
  const lastServed = state !== undefined && ids.includes(state.active) ? state.active : undefined;
  const paused = (id: string): boolean => (state?.cooldowns[id]?.until ?? 0) > now;
  const lines: string[] = [];
  const missing: FallbackLink[] = [];
  chain.forEach((link, index) => {
    const id = linkId(link);
    const cooldown = state?.cooldowns[id];
    const notes: string[] = [];
    if (id === lastServed) notes.push('ha risposto per ultimo');
    else if (lastServed === undefined && index === 0) notes.push('principale');
    if (cooldown !== undefined && paused(id)) {
      notes.push(
        `in pausa: ${REASON_TEXT[cooldown.reason]}, riprovo dalle ${when(cooldown.until)}` +
          (cooldown.declared ? ' (orario dato dal provider)' : ''),
      );
    }
    const refused = state?.lastFallbackError;
    if (refused !== undefined && refused.link === id) {
      notes.push(
        `ha rifiutato la richiesta${refused.status === undefined ? '' : ` (HTTP ${refused.status})`} il ${when(refused.at)}: controlla modello e account`,
      );
    }
    if (!credentialPresent(link, home)) {
      notes.push(`credenziale mancante → ${credentialRemedy(link)}`);
      missing.push(link);
    }
    lines.push(`${index + 1}. ${linkLabel(link)}${notes.length ? ` — ${notes.join(' · ')}` : ''}`);
  });
  // Degraded means the lane's own connection is paused *now* — whether a
  // fallback has answered since or not (after a restart, or when every link
  // failed). An expired pause is not degraded: the next call tries it first.
  return { lines, degraded: paused(ids[0] as string), missing };
}

export type FallbackDeps = { out: (line: string) => void };

function parseFlags(args: string[]): {
  positional: string[];
  lane: InferenceLane;
  account?: string;
} | null {
  const positional: string[] = [];
  let lane: InferenceLane = 'main';
  let account: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--light') lane = 'light';
    else if (a === '--account') {
      const v = args[++i];
      if (v === undefined) return null;
      account = v;
    } else if (a.startsWith('--')) return null;
    else positional.push(a);
  }
  return { positional, lane, ...(account === undefined ? {} : { account }) };
}

export function cmdFallback(home: string, argv: string[], deps: FallbackDeps): number {
  const [verb, ...rest] = argv;
  let config: Config;
  try {
    config = loadConfig(home);
  } catch (error) {
    deps.out(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (verb === undefined || verb === 'list') {
    for (const lane of ['main', 'light'] as const) {
      deps.out(`${lane}:`);
      for (const line of describeChain(config, lane, home).lines) deps.out(`  ${line}`);
    }
    if (!config.fallbacks?.main?.length && !config.fallbacks?.light?.length) {
      deps.out('nessun ripiego: aggiungine uno con `muffin fallback add <provider> <model>`');
    }
    return 0;
  }
  const flags = parseFlags(rest);
  if (flags === null) {
    deps.out(FALLBACK_USAGE);
    return 2;
  }
  const { positional, lane } = flags;
  const current = config.fallbacks?.[lane] ?? [];

  if (verb === 'add') {
    const [providerId, model, extra] = positional;
    if (providerId === undefined || model === undefined || extra !== undefined) {
      deps.out(FALLBACK_USAGE);
      return 2;
    }
    let secretName: string | undefined;
    // xAI without --account: the login when there is one (ADR-0113), otherwise
    // the default key. `--account default` names the key explicitly.
    if (providerId === 'xai' && flags.account === undefined && xaiLoginUsable(home)) {
      secretName = XAI_OAUTH_SECRET;
    }
    if (flags.account !== undefined) {
      if (providerId !== 'openrouter' && providerId !== 'anthropic' && providerId !== 'xai') {
        deps.out(`--account vale per i provider a chiave, non per ${providerId}`);
        return 2;
      }
      try {
        secretName = keySecretName(providerId, flags.account);
      } catch (error) {
        deps.out(error instanceof AuthProfileError ? error.message : String(error));
        return 2;
      }
    }
    const link = catalogLink(providerId, model, secretName);
    if (link === null) {
      deps.out(`provider sconosciuto: ${providerId}\n${FALLBACK_USAGE}`);
      return 2;
    }
    const id = linkId(link);
    if (inferenceChain(config, lane).some((l) => linkId(l) === id)) {
      deps.out(`${linkLabel(link)} è già nella catena ${lane}`);
      return 0;
    }
    if (current.length >= 4) {
      deps.out('la catena ha già 4 ripieghi: togline uno prima');
      return 1;
    }
    const next: Config = {
      ...config,
      fallbacks: { ...config.fallbacks, [lane]: [...current, link] },
    };
    saveConfig(next, home);
    deps.out(`aggiunto alla catena ${lane}: ${linkLabel(link)}`);
    if (link.provider.apiKeyRef === XAI_OAUTH_REF) {
      deps.out('credenziale: il tuo login xAI (secret://xai_oauth), rinnovato da solo');
    }
    if (!credentialPresent(link, home)) {
      deps.out(`manca la credenziale: ${credentialRemedy(link)}`);
    }
    if (link.provider.kind !== 'openai-chatgpt') {
      deps.out('nota: quando serve questo ripiego la spesa conta nei tetti di budget');
    }
    return 0;
  }

  if (verb === 'reset') {
    if (rest.some((a) => a !== '--light' && a !== '--main')) {
      deps.out(FALLBACK_USAGE);
      return 2;
    }
    const lanes: InferenceLane[] = rest.includes('--light')
      ? ['light']
      : rest.includes('--main')
        ? ['main']
        : ['main', 'light'];
    const cleared = clearChainPauses(home, { lanes });
    deps.out(
      cleared === 0
        ? 'nessuna pausa da togliere'
        : `${cleared === 1 ? 'tolta 1 pausa' : `tolte ${cleared} pause`}: il prossimo messaggio riprova dalla connessione principale`,
    );
    return 0;
  }

  if (verb === 'remove') {
    const [target, extra] = positional;
    if (target === undefined || extra !== undefined) {
      deps.out(FALLBACK_USAGE);
      return 2;
    }
    const position = /^\d+$/.test(target) ? Number(target) : undefined;
    let index = -1;
    if (position !== undefined) {
      // Positions are the ones `muffin fallback` prints: 1 is the lane's own
      // connection, which is changed with `muffin model`, not removed here.
      if (position === 1) {
        deps.out('la posizione 1 è la connessione della corsia: cambiala con `muffin model`');
        return 2;
      }
      index = position - 2;
    } else {
      const matches = current
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => providerFor(l.provider)?.id === target);
      if (matches.length > 1) {
        deps.out(
          `${matches.length} ripieghi ${target} nella catena ${lane}: togline uno per posizione ` +
            `(${matches.map(({ i }) => i + 2).join(', ')}), vedi \`muffin fallback\``,
        );
        return 2;
      }
      index = matches[0]?.i ?? -1;
    }
    if (index < 0 || index >= current.length) {
      deps.out(`nessun ripiego ${target} nella catena ${lane}`);
      return 1;
    }
    const removed = current[index];
    if (removed === undefined) return 1;
    const remaining = current.filter((_, i) => i !== index);
    const fallbacks = { ...config.fallbacks, [lane]: remaining };
    if (remaining.length === 0) delete fallbacks[lane];
    const next: Config = { ...config, fallbacks };
    if (Object.keys(fallbacks).length === 0) delete next.fallbacks;
    saveConfig(next, home);
    deps.out(`tolto dalla catena ${lane}: ${linkLabel(removed)}`);
    return 0;
  }

  deps.out(FALLBACK_USAGE);
  return 2;
}
