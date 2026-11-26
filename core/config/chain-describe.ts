import {
  type Config,
  type FallbackLink,
  type InferenceLane,
  inferenceChain,
  locateSecret,
} from './config.js';
import { type FailoverReason, linkId, linkLabel, readChainState } from './provider-chain.js';
import { providerFor } from './providers.js';

/**
 * Human-readable provider-chain status (ADR-0110), shared by `muffin fallback`,
 * `muffin model`, `muffin doctor` and `collectStatus`. Lives in `core/` so
 * status collection does not import `cli/`.
 */

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
  return `muffin secret set ${name}`;
}

export function credentialPresent(link: FallbackLink, home: string): boolean {
  try {
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
