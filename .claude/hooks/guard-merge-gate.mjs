#!/usr/bin/env node
/**
 * PreToolUse hook: un merge in `dev` passa dal gate, o non passa.
 *
 * Il 04/09/2026 il gate e' rimasto cieco per giorni: i check di GitHub erano
 * fermi per fatturazione e `ci:local` esisteva ma non veniva usato *come
 * gate* — si faceva girare la suite unitaria sul ramo e poi `gh pr merge`.
 * Risultato misurato: `collegamenti` rosso su ogni PR senza un'asserzione
 * dentro, D10 che asseriva una regola ritirata, D11 READY senza scenario,
 * D7 rotto da una PR al kernel. Tre giorni di rossi invisibili, tutti sotto
 * un `gh pr merge` che nessun controllo precedeva.
 *
 * Una nota in memoria non basta — si legge prima o dopo, mai nell'attimo in
 * cui si scrive il comando. Un hook parla in quell'attimo: `gh pr merge`
 * viene rifiutato e rimandato all'unica porta, `npm run merge -- <pr>`, che
 * costruisce il risultato unito, ci fa girare `ci:local` e unisce **solo**
 * su PASS (`scripts/merge.ts`).
 *
 * ## Cosa rifiuta, e cosa no
 *
 * Solo `gh pr merge` scritto direttamente nel comando. `npm run merge` passa
 * (e' la porta). `gh pr view/list/create/close/edit` passano. L'owner puo'
 * bypassare per una ragione sua con `MUFFIN_MERGE_DIRECT=1` nel comando o
 * nell'ambiente — visibile, mai implicito.
 */
import { readFileSync } from 'node:fs';

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
process.stderr.write(
  [
    `questo merge salterebbe il gate: \`gh pr merge\` unisce senza che nessuno abbia fatto girare \`ci:local\``,
    `sul risultato unito. Il 04/09 e' costato tre giorni di rossi invisibili (collegamenti, D10, D11, D7).`,
    ``,
    `La porta e' una sola:`,
    `  npm run merge -- ${pr ?? '<pr>'}`,
    `costruisce dev + la PR in un worktree usa-e-getta, fa girare ci:local, e unisce solo su PASS.`,
    ``,
    `Se e' voluto (e sai perche'): MUFFIN_MERGE_DIRECT=1 davanti al comando.`,
  ].join('\n'),
);
process.exit(2);
