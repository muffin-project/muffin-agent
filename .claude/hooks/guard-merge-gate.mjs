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
 * A meta' settembre 2026 la premessa e' caduta (osservato 2026-09-18: CI
 * per-PR di nuovo verde nella finestra 12→17/09, branch protection ancora
 * 403 su repo privato): il gate locale serializza un host (~40-60 minuti a
 * PR, Docker, host quieto) e un contributore esterno non puo' eseguirlo
 * proprio. Tenere una sola porta locale non scala all'open source.
 * Da qui il gate a due livelli (`docs/development/BRANCHING.md`, sezione «Slice -> dev»): per slice→dev vale
 * anche il verde GitHub verificato qui sotto; `npm run merge` resta la porta
 * per tutto ciò che GitHub non prova, e per dev→main non esiste ancora
 * nessuna porta codificata (quella promozione oggi e' un fast-forward fuori
 * da entrambe — vedi docs/development/BRANCHING.md).
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
 * - la PR e' OPEN, non-bozza, con base `dev` (dev→main non passa di qui:
 *   nessuna porta codificata la accetta ancora);
 * - `mergeable` e' MERGEABLE e `mergeStateStatus` e' CLEAN — cioe' nessun
 *   conflitto noto con la base *adesso* e stato associato verde. NON e' la
 *   prova che la base non si sia mossa dopo la CI, ne' che l'albero che il
 *   server unira' sia byte-identico allo snapshot provato: la CI di GitHub
 *   gira sul merge-ref sintetico dell'evento `pull_request` (checkout di
 *   default), quindi e' la composizione head+base *di quel run*, non una
 *   garanzia di up-to-date senza branch protection o merge queue;
 * - sulla head ci sono i successi nominali FAST (`verifica`) e DEEP
 *   (`accettazione`) — `skipped` non soddisfa un check richiesto;
 * - nessun altro check sulla head e' rosso o in corso.
 *
 * Eccezione docs-only, fail-closed: se `verifica`/`accettazione` mancano del
 * tutto, la porta passa solo dopo aver letto i path cambiati della PR e aver
 * verificato che OGNI file stia nell'insieme esentato di `ci.yml`
 * (`docs/**`, `.claude/**`, `README.md`, `AGENTS.md`, `CLAUDE.md`) e che i
 * check leggeri che ci sono (es. `collegamenti`) siano verdi. L'assenza di un
 * check non e' evidenza del perche' manca: file illeggibili o incompleti
 * ricadono sulla porta locale — e "completi" e' provato, non presunto
 * (`files.length === changedFiles`, per il troncamento silenzioso oltre 100
 * voci di `gh pr view --json files`).
 *
 * Tutto il resto — rete giu', PR non OPEN o bozza, base mossa, zero check,
 * check in corso o rossi, DEEP mancante o skippato su PR di codice — ricade
 * sul messaggio della porta locale. Fail-closed sempre.
 *
 * `MUFFIN_GATE_OFFLINE=1` forza la ricaduta senza rete. Esiste per i test di
 * questo file e per nient'altro: in produzione un hook che non interroga
 * GitHub e' un hook che mente.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyDocsOnly, evaluateChecks } from '../../scripts/gate-evidence.mjs';

function localGateMessage(pr) {
  return [
    `questo merge salterebbe il gate: \`gh pr merge\` unisce senza che nessun gate abbia visto il risultato unito.`,
    `Il 04/09 e' costato tre giorni di rossi invisibili (collegamenti, D10, D11, D7).`,
    ``,
    `Le porte sono due (docs/development/BRANCHING.md, sezione «Slice -> dev»):`,
    `  npm run merge -- ${pr ?? '<pr>'}`,
    `costruisce dev + la PR in un worktree usa-e-getta, fa girare ci:local, e unisce solo su PASS;`,
    `oppure il verde GitHub FAST+DEEP sulla head non-bozza, che questo hook verifica da solo prima di lasciarti passare.`,
    ``,
    `Se e' voluto (e sai perche'): MUFFIN_MERGE_DIRECT=1 davanti al comando.`,
  ].join('\n');
}

// La semantica di valutazione (allowlist, nomi, completezza) vive in
// `scripts/gate-evidence.mjs`, condivisa con la porta dev→main.
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
    info = query(['pr', 'view', pr, '--json', 'number,state,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,changedFiles,files']);
  } catch {
    return { ok: false, message: localGateMessage(pr) };
  }
  if (info.state !== 'OPEN') return { ok: false, message: `PR #${pr} e' ${info.state}, non OPEN` };
  // `isDraft !== false` e' rifiuto: il campo esiste sempre nella risposta vera,
  // quindi assente/inatteso vale come dubbio, e un dubbio non e' un via libera.
  if (info.isDraft !== false) {
    return {
      ok: false,
      message: [
        `PR #${pr} e' in bozza: la CI profonda non gira sulle bozze per disegno (accettazione skippata).`,
        `Segna ready (parte un run con DEEP) oppure la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
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
  // La valutazione dell'evidenza vive in `scripts/gate-evidence.mjs`,
  // condivisa con la porta dev→main: qui restano solo i messaggi di questa
  // porta. `skipped` non soddisfa un check richiesto (da quando l'accettazione
  // gira solo sulle non-bozza, uno `skipped` qui e' una bozza — gia' rifiutata
  // sopra — o un run che non ha provato il profondo: mai un via libera).
  let runs;
  try {
    const repo = query(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
    const payload = query(['api', `repos/${repo}/commits/${info.headRefOid}/check-runs?per_page=100`]);
    runs = Array.isArray(payload?.check_runs) ? payload.check_runs : payload;
    if (!Array.isArray(runs)) throw new Error('no check_runs');
  } catch {
    return { ok: false, message: localGateMessage(pr) };
  }
  const valutati = evaluateChecks(runs, ['verifica', 'accettazione']);
  if (!valutati.ok && valutati.kind === 'empty') {
    return {
      ok: false,
      message: [
        `PR #${pr}: nessun check GitHub sulla head ${String(info.headRefOid).slice(0, 10)} (forse tutti skippati dai paths).`,
        `Senza evidenza vale la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
  if (!valutati.ok && valutati.kind === 'pending') {
    return {
      ok: false,
      message: `PR #${pr}: check in corso (${valutati.names.join(', ')}) — aspetta il verde, oppure la porta locale:\n  npm run merge -- ${pr}`,
    };
  }
  if (!valutati.ok && valutati.kind === 'red') {
    return {
      ok: false,
      message: `PR #${pr}: check rossi (${valutati.names.join(', ')}) — la porta locale non li renderebbe verdi: ripara sul ramo.`,
    };
  }
  if (valutati.ok) {
    return {
      ok: true,
      note: `GitHub verde FAST+DEEP su ${String(info.headRefOid).slice(0, 10)} (verifica + accettazione success sulla head; CI sul merge-ref di quell'evento) — merge via GitHub (two-tier gate, BRANCHING.md sezione «Slice -> dev»).`,
    };
  }
  // Eccezione docs-only, fail-closed: l'assenza di un check non dice perche'
  // manca — allowlist e completezza (`files.length === changedFiles`, contro
  // il troncamento silenzioso oltre 100 voci) le decide il modulo condiviso.
  const mancanti = valutati.kind === 'missing' ? valutati.names : [];
  const docs = classifyDocsOnly(info.files, info.changedFiles);
  if (!docs.ok && docs.reason === 'incomplete') {
    return {
      ok: false,
      message: [
        `PR #${pr}: manca il successo ${mancanti.join(' + ')} sulla head e la lista file non e' completa e verificabile (restituiti ${docs.got ?? '?'}, dichiarati ${docs.want ?? '?'}).`,
        `Senza evidenza vale la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
  if (!docs.ok) {
    const fuori = docs.reason === 'outside' ? (docs.offending ?? []) : [];
    return {
      ok: false,
      message: [
        `PR #${pr}: manca il successo ${mancanti.join(' + ')} sulla head e tocca file fuori dall'insieme esentato (${fuori.slice(0, 3).join(', ')}${fuori.length > 3 ? ', …' : ''}).`,
        `Aspetta la CI completa, oppure la porta locale:`,
        `  npm run merge -- ${pr}`,
      ].join('\n'),
    };
  }
  return {
    ok: true,
    note: `GitHub verde docs-only su ${String(info.headRefOid).slice(0, 10)} (${docs.count}/${info.changedFiles} file, tutti nell'insieme esentato di ci.yml, check leggeri verdi) — merge via GitHub (two-tier gate, BRANCHING.md sezione «Slice -> dev»).`,
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
