#!/usr/bin/env node
/**
 * PreToolUse hook: un merge in `dev` passa da un gate vero, o non passa.
 *
 * Il 04/09/2026 il gate e' rimasto cieco per giorni: i check di GitHub erano
 * fermi per fatturazione e `ci:local` esisteva ma non veniva usato *come
 * gate* — si faceva girare la suite unitaria sul ramo e poi `gh pr merge`.
 * Risultato misurato: `collegamenti` rosso su ogni PR senza un'asserzione
 * dentro, D10 che asseriva una regola ritirata, D11 READY senza scenario,
 * D7 rotto da una PR al kernel. Tre giorni di rossi invisibili, tutti sotto
 * un `gh pr merge` che nessun controllo precedeva.
 *
 * Il 26/09/2026 la premessa e' caduta: i minuti GitHub sono tornati e la CI
 * gira per-PR in ~10 minuti, mentre il gate locale serializza un host
 * (~40-60 minuti a PR, Docker, host quieto) e un contributore esterno non puo'
 * eseguirlo proprio. Tenere una sola porta locale non scala all'open source.
 * Da qui il gate a due livelli (`docs/BRANCHING.md` §3): per slice→dev vale
 * anche il verde GitHub verificato qui sotto; `npm run merge` resta la porta
 * per dev→main e per tutto ciò che GitHub non prova.
 *
 * ## Cosa rifiuta, e cosa no
 *
 * Solo `gh pr merge` scritto direttamente nel comando. `npm run merge` passa
 * (e' una porta). `gh pr view/list/create/close/edit` passano. L'owner puo'
 * bypassare per una ragione sua con `MUFFIN_MERGE_DIRECT=1` nel comando o
 * nell'ambiente — visibile, mai implicito.
 *
 * ## Il percorso GitHub (solo slice→dev)
 *
 * Passa se e solo se, lette dal vivo in quell'attimo:
 *
 * - la PR e' OPEN con base `dev` (le promozioni dev→main tengono la porta locale);
 * - `mergeable` e' MERGEABLE e `mergeStateStatus` e' CLEAN — base ferma,
 *   quindi il risultato unito coincide con la head (l'obiezione D7 non si applica);
 * - sulla head c'e' almeno un check-run e nessuno e' rosso o in corso
 *   (i nomi non sono hardcoded: qualunque check futuro copre da solo).
 *
 * Tutto il resto — rete giu', PR non OPEN, base mossa, zero check (tutti
 * skippati dai paths), check in corso o rossi — ricade sul messaggio della
 * porta locale. Fail-closed sempre: un dubbio non e' un via libera.
 *
 * `MUFFIN_GATE_OFFLINE=1` forza la ricaduta senza rete. Esiste per i test di
 * questo file e per nient'altro: in produzione un hook che non interroga
 * GitHub e' un hook che mente.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function localGateMessage(pr) {
  return [
    `questo merge salterebbe il gate: \`gh pr merge\` unisce senza che nessun gate abbia visto il risultato unito.`,
    `Il 04/09 e' costato tre giorni di rossi invisibili (collegamenti, D10, D11, D7).`,
    ``,
    `Le porte sono due (\`docs/BRANCHING.md\` §3):`,
    `  npm run merge -- ${pr ?? '<pr>'}`,
    `costruisce dev + la PR in un worktree usa-e-getta, fa girare ci:local, e unisce solo su PASS;`,
    `oppure il verde GitHub sulla head a base ferma, che questo hook verifica da solo prima di lasciarti passare.`,
    ``,
    `Se e' voluto (e sai perche'): MUFFIN_MERGE_DIRECT=1 davanti al comando.`,
  ].join('\n');
}

function ghJson(args) {
  if (process.env['MUFFIN_GATE_OFFLINE'] === '1') throw new Error('offline (tests)');
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return JSON.parse(out);
}

const defaultQuery = (args) => ghJson(args);

/**
 * Il percorso GitHub, puro a meno della `query` iniettata (default: `gh` vero).
 * Ritorna `{ ok: true, note }` oppure `{ ok: false, message }` — mai un'eccezione.
 */
export function decideGitHubMerge(pr, query = defaultQuery) {
  let info;
  try {
    info = query(['pr', 'view', pr, '--json', 'number,state,baseRefName,headRefOid,mergeable,mergeStateStatus']);
  } catch {
    return { ok: false, message: localGateMessage(pr) };
  }
  if (info.state !== 'OPEN') return { ok: false, message: `PR #${pr} e' ${info.state}, non OPEN` };
  if (info.baseRefName !== 'dev') return { ok: false, message: localGateMessage(pr) };
  if (info.mergeable !== 'MERGEABLE' || info.mergeStateStatus !== 'CLEAN') {
    return {
      ok: false,
      message: [
        `PR #${pr}: base non ferma o check non verdi (mergeable=${info.mergeable}, mergeState=${info.mergeStateStatus}).`,
        `Aggiorna il ramo e aspetta la CI, oppure la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
  let repo;
  let runs;
  try {
    repo = query(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
    const payload = query(['api', `repos/${repo}/commits/${info.headRefOid}/check-runs?per_page=100`]);
    runs = Array.isArray(payload?.check_runs) ? payload.check_runs : payload;
    if (!Array.isArray(runs)) throw new Error('no check_runs');
  } catch {
    return { ok: false, message: localGateMessage(pr) };
  }
  // Ultimo run per nome: i rerun non resuscitano un rosso vecchio.
  const latest = new Map();
  for (const run of runs) {
    if (run?.name === undefined) continue;
    const at = Date.parse(run.completed_at ?? run.started_at ?? 0) || 0;
    if ((latest.get(run.name)?.at ?? -1) <= at) latest.set(run.name, { at, run });
  }
  const current = [...latest.values()].map((v) => v.run);
  if (current.length === 0) {
    return {
      ok: false,
      message: [
        `PR #${pr}: nessun check GitHub sulla head ${String(info.headRefOid).slice(0, 10)} (forse tutti skippati dai paths).`,
        `Senza evidenza vale la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
  const pending = current.filter((r) => r.status !== 'completed').map((r) => r.name);
  if (pending.length > 0) {
    return {
      ok: false,
      message: `PR #${pr}: check in corso (${pending.join(', ')}) — aspetta il verde, oppure la porta locale:\n  npm run merge -- ${pr}`,
    };
  }
  const bad = current
    .filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))
    .map((r) => `${r.name} (${r.conclusion})`);
  if (bad.length > 0) {
    return {
      ok: false,
      message: `PR #${pr}: check rossi (${bad.join(', ')}) — la porta locale non li renderebbe verdi: ripara sul ramo.`,
    };
  }
  return {
    ok: true,
    note: `GitHub verde su ${String(info.headRefOid).slice(0, 10)} + base ferma — merge via GitHub (two-tier gate, BRANCHING.md §3).`,
  };
}

function main() {
  let command = '';
  try {
    command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
  } catch {
    process.exit(0);
  }

  if (/\bMUFFIN_MERGE_DIRECT=1\b/.test(command) || process.env['MUFFIN_MERGE_DIRECT'] === '1') process.exit(0);

  // Fuori dalle stringhe: un `gh pr merge` citato dentro un messaggio di
  // commit o un body di PR non e' un merge.
  const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (!/\bgh\s+pr\s+merge\b/.test(bare)) process.exit(0);

  const pr = /\bgh\s+pr\s+merge\s+(\d+)/.exec(bare)?.[1];
  if (pr === undefined) process.exit(2);
  const decision = decideGitHubMerge(pr);
  process.stderr.write(decision.ok ? decision.note : decision.message);
  process.exit(decision.ok ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
