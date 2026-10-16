import DatabaseCtor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { paths } from '../core/config/config.js';
import { askRaw, isSafeControlToken } from '../core/gateway/control-socket.js';
import {
  lastAssistantText,
  type ExecutionQuery,
} from '../core/gateway/forward.js';
import { TurnStore } from '../core/turns/store.js';
import type { RunExit } from './run.js';

/**
 * `muffin gateway attach` — la metà poll del percorso attach.
 *
 * Sottomettere resta al socket (`run`/`submitViaGateway`): qui non nasce
 * nessuna execution, si interroga soltanto. Per questo rieseguire lo stesso
 * id non duplica niente per costruzione — la domanda non è un turno.
 *
 * - gateway spento → fail closed con il rimedio, mai attesa silenziosa;
 * - turno esistente → stesso turn_id, poll dello stato durevole (socket vivo
 *   prima, riga dopo) fino a esito terminale o wait-cap;
 * - uscita con codice headless (`run.ts`), così uno script legge la stessa
 *   lingua di `muffin run`.
 */

export const ATTACH_USAGE = `usage:
  muffin gateway attach <turn-id> [--wait-sec N] [--json]
    interroga l'esito di un turno del gateway vivo e lo aspetta fino al
    wait-cap (default 600s, 0 = senza limite). Stesso turn_id, mai una
    riesecuzione. Senza gateway: esce subito con il rimedio, non attende.
`;

export const ATTACH_DEFAULT_WAIT_SEC = 600;
const ATTACH_POLL_MS = 500;

export function exitForAttachStopped(
  stopped: string | null,
  status?: string,
): RunExit {
  switch (stopped) {
    case 'answered':
      return 0;
    case 'ask':
      return 3;
    case 'budget':
      return 4;
    case 'cap':
      return 5;
    case 'suspended':
      return 6;
    case 'continuable':
      return 7;
    case 'aborted':
    case 'error':
      return 1;
    default:
      return status === 'continuable' ? 7 : 1;
  }
}

export type AttachQuery = () => Promise<ExecutionQuery | null>;
export type AttachIdentify = () => Promise<unknown | null>;

/**
 * Interroga un turno: prima il socket (il gateway vivo sa anche delle
 * execution appena finite, oltre la riga), poi la riga letta direttamente —
 * la stessa doppia fonte di `cmdGatewayTurn`, che resta vera anche quando
 * l'execution è uscita dalla memoria del gateway.
 */
export async function queryTurn(home: string, id: string): Promise<ExecutionQuery | null> {
  const viaSocket = (await askRaw(home, { verb: 'query', id })) as ExecutionQuery | null;
  if (viaSocket) return viaSocket;
  const file = paths(home).db;
  if (!existsSync(file)) return null;
  const db = new DatabaseCtor(file, { readonly: true });
  try {
    const store = new TurnStore(db, () => new Date(), undefined, { readOnly: true });
    const row = store.get(id);
    if (!row) return { found: false };
    if (row.status === 'done') {
      return {
        found: true,
        status: 'done',
        stopped: row.outcome,
        text: lastAssistantText(row),
        turnId: row.id,
      };
    }
    return { found: true, status: row.status, stopped: null, text: null, turnId: row.id };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Il gateway è vivo adesso: `identify` sul socket risponde. Mai un pid letto da una riga. */
export async function attachIdentify(home: string): Promise<unknown | null> {
  return askRaw(home, { verb: 'identify' });
}

export type PollOutcome =
  | { kind: 'ready'; query: Extract<ExecutionQuery, { found: true }> }
  | { kind: 'missing' }
  | { kind: 'gateway-down' }
  | { kind: 'timeout'; last: ExecutionQuery | null };

/**
 * Aspetta l'esito durevole di un turno, senza mai eseguirlo.
 *
 * Terminale = `stopped` noto (answered/ask/budget/cap/suspended/continuable/
 * aborted/error) oppure riga `done`/`continuable`. Tutto il resto (running,
 * waiting, runnable, interrupted) si ri-interroga fino al wait-cap. Il
 * gateway che muore a metà non si aspetta che torni: fail closed subito.
 */
export async function pollTurn(
  deps: {
    waitSec?: number;
    pollMs?: number;
    identify?: AttachIdentify;
    query?: AttachQuery;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<PollOutcome> {
  const waitSec = deps.waitSec ?? ATTACH_DEFAULT_WAIT_SEC;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const identify = deps.identify ?? (async () => null);
  const query = deps.query ?? (async () => null);
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = waitSec === 0 ? Number.POSITIVE_INFINITY : now() + waitSec * 1000;
  let last: ExecutionQuery | null = null;
  for (;;) {
    const vivo = await identify();
    if (vivo === null) return { kind: 'gateway-down' };
    const q = await query();
    last = q;
    if (!q?.found) return { kind: 'missing' };
    if (q.stopped !== null || q.status === 'done' || q.status === 'continuable') {
      return { kind: 'ready', query: q };
    }
    if (now() >= deadline) return { kind: 'timeout', last };
    await sleep(pollMs);
  }
}

/** Stampa l'esito terminale con la lingua di `muffin run` e ne torna il codice. */
export function emitAttachResult(
  q: Extract<ExecutionQuery, { found: true }>,
  opts: { json?: boolean } = {},
): RunExit {
  const code = exitForAttachStopped(q.stopped, q.status);
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
    return code;
  }
  if (q.text) process.stdout.write(`${q.text}\n`);
  else process.stdout.write(`turno ${q.turnId.slice(0, 12)}: ${q.stopped ?? q.status}\n`);
  if (q.stopped === 'ask') {
    process.stderr.write(
      `serve approvazione — rilancia in \`muffin\` interattivo per decidere (turno ${q.turnId.slice(0, 12)})\n`,
    );
  } else if (q.stopped === 'suspended') {
    process.stderr.write(
      `turno sospeso — riprende dalla corsia del gateway, riattacca con \`muffin gateway attach ${q.turnId}\` (turno ${q.turnId.slice(0, 12)})\n`,
    );
  } else if (q.status === 'continuable' || q.stopped === 'continuable') {
    process.stderr.write(
      `lease esaurita, lavoro salvato — continua con \`muffin resume ${q.turnId}\` (turno ${q.turnId.slice(0, 12)})\n`,
    );
  }
  return code;
}

export function attachNoGatewayLines(): { out: string; err: string } {
  return {
    out: '',
    err:
      `nessun gateway attivo su questa Home — non attendo senza di lui (mai attesa silenziosa)\n` +
      `→ \`muffin gateway install --write --start\` per avviarlo, poi riprova\n` +
      `→ \`muffin gateway status\` per il dettaglio\n`,
  };
}

/** Esito del poll in uscita headless, in un solo posto per `attach` e `run --attach`. */
export function reportPollOutcome(
  outcome: PollOutcome,
  opts: { json?: boolean; id: string; waitSec: number },
): RunExit {
  if (outcome.kind === 'gateway-down') {
    process.stderr.write(
      `il gateway è andato giù mentre attendevo il turno ${opts.id.slice(0, 12)} — non lo aspetto che torni\n` +
        `→ \`muffin gateway status\` per il dettaglio, \`muffin gateway turn ${opts.id}\` per la riga durevole\n`,
    );
    return 1;
  }
  if (outcome.kind === 'missing') {
    process.stderr.write(`nessun turno ${opts.id}\n`);
    return 1;
  }
  if (outcome.kind === 'timeout') {
    const stato =
      outcome.last?.found === true
        ? (outcome.last.stopped ?? outcome.last.status)
        : 'sconosciuto';
    process.stderr.write(
      `timeout dopo ${opts.waitSec}s — turno ${opts.id.slice(0, 12)} ancora ${stato}, niente rieseguito\n` +
        `→ riattacca con \`muffin gateway attach ${opts.id}\` (stesso id)\n`,
    );
    return 1;
  }
  return emitAttachResult(outcome.query, { ...(opts.json === true ? { json: true } : {}) });
}

export async function cmdGatewayAttach(
  home: string,
  argv: string[],
  over: {
    waitSecDefault?: number;
    pollMs?: number;
    identify?: AttachIdentify;
    sleep?: (ms: number) => Promise<void>;
    queryOverride?: (id: string) => AttachQuery;
  } = {},
): Promise<number> {
  let parsed: { values: { 'wait-sec'?: string; json?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      options: { 'wait-sec': { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    });
  } catch {
    process.stderr.write(ATTACH_USAGE);
    return 78;
  }
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1) {
    process.stderr.write(ATTACH_USAGE);
    return 78;
  }
  if (!isSafeControlToken(id)) {
    process.stderr.write(`turn-id non usabile: ${id}\n${ATTACH_USAGE}`);
    return 78;
  }
  let waitSec = over.waitSecDefault ?? ATTACH_DEFAULT_WAIT_SEC;
  if (parsed.values['wait-sec'] !== undefined) {
    const n = Number(parsed.values['wait-sec']);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(`--wait-sec vuole secondi (0 = senza limite), non "${parsed.values['wait-sec']}"\n`);
      return 78;
    }
    waitSec = n;
  }
  const json = parsed.values.json === true;

  const identify = over.identify ?? (() => attachIdentify(home));
  const vivo = await identify();
  if (vivo === null) {
    const lines = attachNoGatewayLines();
    if (lines.out !== '') process.stdout.write(lines.out);
    process.stderr.write(lines.err);
    return 1;
  }
  const query: AttachQuery =
    over.queryOverride?.(id) ?? (() => queryTurn(home, id));
  const outcome = await pollTurn({
    waitSec,
    ...(over.pollMs !== undefined ? { pollMs: over.pollMs } : {}),
    identify,
    query,
    ...(over.sleep !== undefined ? { sleep: over.sleep } : {}),
  });
  return reportPollOutcome(outcome, { json, id, waitSec });
}
