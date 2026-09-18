/**
 * La porta di promozione dev→main: `npm run promote -- [--sha <sha>] [--execute]`.
 *
 * La promozione oggi e' un fast-forward di `main` su un commit di `dev`,
 * fuori da entrambe le porte di merge (lo hook vede solo `gh pr merge`,
 * `merge.ts` rifiuta basi diverse da `dev`, e senza branch protection niente
 * controlla il ref prima che si muova). Questo script e' la porta mancante,
 * e resta piccola perche' il caso e' stretto: `main` e' sempre un antenato di
 * `dev` (verificato qui, non presunto), quindi la promozione e' un avanzamento
 * senza merge e l'albero promosso e' esattamente l'albero di uno SHA noto.
 *
 * ## La garanzia, in tre righe esatte
 *
 * 1. Lo SHA promosso (`target`, default: `origin/dev` appena fetchato) e'
 *    nominato nel verdetto e nel push: si promuove uno SHA, mai "dev".
 * 2. Le prove richieste sono FAST (`verifica`) + DEEP (`accettazione`) con
 *    successo nominale sulla PR dev→main la cui head E' `target`. Se `dev`
 *    si muove dopo il verde, la head non coincide piu' e il gate si chiude:
 *    rieseguire ri-risolve il target (fail-closed sulla corsa, non sul riuso).
  * 3. Il push e' `git push origin <target>:main`, senza force: aggiornamento
  *    atomico del ref con fast-forward imposto dal server. Rifiuta se `main`
  *    contiene commit fuori da `target` (divergenza vera) — ma puo' riuscire
  *    se `main` e' nel frattempo avanzata a un altro antenato di `target`:
  *    quello resta sicuro perche' `target` contiene gia' quella storia, e il
  *    verdetto registra entrambi gli SHA. Non e' un compare-and-swap
  *    sull'esatto `mainSha` osservato, e non finge di esserlo: niente force,
  *    mai. Nessuna branch protection richiesta, nessuna inventata.
 *
 * Sull'uguaglianza degli alberi, detta una volta sola: la CI della PR
 * dev→main gira sul merge-ref sintetico di quell'evento. Con `main` antenato
 * di `target`, quel merge non aggiunge niente: l'albero provato e' l'albero
 * di `target`, che il fast-forward conserva byte per byte (stesso SHA, non
 * solo stesso albero). Se `main` non e' antenato, non c'e' promozione
 * automatica: serve una mano umana, e questo script esce 1 prima di toccare
 * qualunque ref.
 *
 * ## Cosa chiude il gate (fail-closed sempre, un dubbio non e' un via libera)
 *
 * - nessuna PR dev→main aperta (il rifiuto stampa il comando per aprirla);
 * - piu' di una PR dev→main (ambiguo: chiudere a mano prima);
 * - PR non OPEN o in bozza (sulle bozze DEEP non gira per disegno);
 * - head della PR diversa da `target`;
 * - `mergeable`/`mergeStateStatus` non verdi;
 * - qualunque check rosso o in corso sulla head;
 * - `verifica` o `accettazione` mancanti o non-`success` (`skipped` non e'
 *   evidenza), salvo l'eccezione docs-only: ogni file cambiato dentro
 *   l'insieme esentato di `ci.yml` (`docs/**`, `.claude/**`, i tre md in
 *   root) e i check leggeri verdi — file illeggibili chiudono;
  * - push rifiutato dal server (main con storia fuori da target: divergenza
  *   vera, serve una mano umana).
 *
 * ## Cosa NON fa
 *
 * - Non crea la PR dev→main (effetto collaterale: la apre l'umano col comando
 *   suggerito). Non ricontrolla il DCO (applicato all'ingresso in `dev` da
 *   `merge.ts`). Non tocca `dev`, non mergia, non forza mai.
 * - Di default e' un dry-run: verifica tutto e si ferma prima del push. Solo
 *   `--execute` muove il ref. Il verdetto finisce in `.ci-local/verdicts/`
 *   (per macchina, ignorato da Git) con gli SHA esatti, come `merge.ts`.
 *
  * ## Parentela (una sola semantica, due porte)
 *
  * La valutazione dei check (ultimo per nome, richiesti nominali, rossi/
  * pendenti che chiudono, eccezione docs-only con completezza provata
  * `files.length === changedFiles`) vive in `scripts/gate-evidence.mjs`,
  * condivisa con lo hook slice→dev. Qui restano solo target pinnato, base
  * `main`, antenato e push.
  */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDocsOnly, evaluateChecks } from './gate-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

export interface PromotionPr {
  readonly number: number;
  readonly state: string;
  readonly isDraft?: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string;
  readonly changedFiles?: unknown;
  readonly files?: unknown;
}

export interface PromotionCheckRun {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly completed_at?: string;
  readonly started_at?: string;
}

export type PromotionVerdict =
  | { readonly ok: true; readonly note: string; readonly noop?: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * La decisione, pura a meno degli input: ogni ramo che non e' "tutto provato
 * sullo SHA esatto" e' un rifiuto con il comando o il fatto che manca.
 */
export function decidePromotion(args: {
  targetSha: string;
  mainSha: string;
  mainIsAncestor: boolean;
  pr: PromotionPr | null;
  prCount: number;
  runs: readonly PromotionCheckRun[];
}): PromotionVerdict {
  const { targetSha, mainSha, mainIsAncestor, pr, prCount, runs } = args;
  const corta = (sha: string) => sha.slice(0, 12);

  if (!mainIsAncestor) {
    return {
      ok: false,
      message: [
        `main (${corta(mainSha)}) non e' antenato di target (${corta(targetSha)}): niente fast-forward possibile.`,
        `Una promozione automatica qui inventerebbe un merge che nessuno ha provato: serve una mano umana.`,
      ].join('\n'),
    };
  }
  if (targetSha === mainSha) {
    return { ok: true, note: `main e' gia' a ${corta(targetSha)}: niente da promuovere (noop).`, noop: true };
  }
  if (prCount > 1) {
    return {
      ok: false,
      message: `ci sono ${prCount} PR dev→main aperte: ambiguo quale porti le prove. Chiuderne a mano fino a una sola.`,
    };
  }
  if (pr === null) {
    return {
      ok: false,
      message: [
        `nessuna PR dev→main aperta: senza, non c'e' CI sul merge-ref della promozione.`,
        `Aprirla (ready, non bozza — sulle bozze DEEP non gira):`,
        `  gh pr create --base main --head dev --title "promote: dev → main (<data>)" --body "promotion gate: npm run promote"`,
        `poi far girare la CI e rieseguire questo gate.`,
      ].join('\n'),
    };
  }
  if (pr.state !== 'OPEN') return { ok: false, message: `la PR dev→main #${pr.number} e' ${pr.state}, non OPEN` };
  if (pr.isDraft !== false) {
    return {
      ok: false,
      message: `la PR dev→main #${pr.number} e' in bozza: la CI profonda non gira sulle bozze per disegno. Segnarla ready e aspettare DEEP.`,
    };
  }
  if (pr.headRefOid !== targetSha) {
    return {
      ok: false,
      message: [
        `la PR dev→main #${pr.number} punta a ${corta(pr.headRefOid)}, ma il target e' ${corta(targetSha)}: le prove sono per un altro SHA.`,
        `dev si e' mosso dopo il verde (o prima della risoluzione): rieseguire, il target si ri-risolve da origin/dev.`,
      ].join('\n'),
    };
  }
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN') {
    return {
      ok: false,
      message: `PR #${pr.number}: stato non verde (mergeable=${pr.mergeable}, mergeState=${pr.mergeStateStatus}). Aggiorna e aspetta la CI.`,
    };
  }

  // Valutazione dal modulo condiviso con lo hook slice→dev; qui solo i
  // messaggi di questa porta. `skipped` non soddisfa un check richiesto.
  const valutati = evaluateChecks(runs, ['verifica', 'accettazione']);
  if (!valutati.ok && valutati.kind === 'empty') {
    return { ok: false, message: `nessun check sulla head ${corta(targetSha)}: senza evidenza il gate resta chiuso.` };
  }
  if (!valutati.ok && valutati.kind === 'pending') {
    return { ok: false, message: `check in corso (${valutati.names.join(', ')}): aspettare il verde e rieseguire.` };
  }
  if (!valutati.ok && valutati.kind === 'red') {
    return { ok: false, message: `check rossi (${valutati.names.join(', ')}): ripara sul ramo, nessuna promozione.` };
  }
  if (valutati.ok) {
    return {
      ok: true,
      note: `promozione pronta: main ${corta(mainSha)} → ${corta(targetSha)} (antenato verificato, PR #${pr.number} con verifica + accettazione success sulla head ${corta(targetSha)}).`,
    };
  }
  // Eccezione docs-only con completezza provata (stesso modulo condiviso:
  // `files.length === changedFiles`, contro il troncamento oltre 100 voci).
  const mancanti = valutati.kind === 'missing' ? valutati.names : [];
  const docs = classifyDocsOnly(pr.files, pr.changedFiles);
  if (!docs.ok && docs.reason === 'incomplete') {
    return {
      ok: false,
      message: `manca il successo ${mancanti.join(' + ')} e la lista file non e' completa e verificabile (restituiti ${docs.got ?? '?'}, dichiarati ${docs.want ?? '?'}): gate chiuso.`,
    };
  }
  if (!docs.ok) {
    const fuori = docs.reason === 'outside' ? (docs.offending ?? []) : [];
    return {
      ok: false,
      message: `manca il successo ${mancanti.join(' + ')} e la promozione tocca file fuori dall'insieme esentato (${fuori.slice(0, 3).join(', ')}${fuori.length > 3 ? ', …' : ''}): gate chiuso.`,
    };
  }
  return {
    ok: true,
    note: `promozione docs-only pronta: main ${corta(mainSha)} → ${corta(targetSha)} (${docs.count}/${pr.changedFiles} file tutti esentati, check leggeri verdi, PR #${pr.number}).`,
  };
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}

function ghJson(args: string[]): unknown {
  const out = execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT, timeout: 30000 });
  return JSON.parse(out);
}

function main(): void {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const shaFlag = argv.indexOf('--sha');
  const shaArg = shaFlag === -1 ? undefined : argv[shaFlag + 1];
  if (shaFlag !== -1 && (shaArg === undefined || !/^[0-9a-f]{4,40}$/i.test(shaArg))) {
    process.stderr.write('uso: npm run promote -- [--sha <sha>] [--execute]  (default: dry-run, non muove main)\n');
    process.exit(64);
  }

  git(['fetch', '--quiet', 'origin', 'dev', 'main']);
  const devSha = git(['rev-parse', 'origin/dev']);
  const mainSha = git(['rev-parse', 'origin/main']);
  const targetSha = shaArg === undefined ? devSha : git(['rev-parse', `${shaArg}^{commit}`]);
  process.stdout.write(`target ${targetSha.slice(0, 12)}   main ${mainSha.slice(0, 12)}   ${execute ? 'EXECUTE' : 'dry-run (il ref non si muove)'}\n`);

  let ancestor = false;
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'merge-base', '--is-ancestor', mainSha, targetSha], { stdio: 'ignore' });
    ancestor = true;
  } catch {
    ancestor = false;
  }

  let pr: PromotionPr | null = null;
  let prCount = 0;
  if (ancestor && targetSha !== mainSha) {
    const list = ghJson(['pr', 'list', '--base', 'main', '--head', 'dev', '--json', 'number']) as Array<{ number: number }>;
    prCount = list.length;
    if (prCount === 1) {
      pr = ghJson([
        'pr',
        'view',
        String(list[0]!.number),
        '--json',
        'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,changedFiles,files',
      ]) as PromotionPr;
    }
  }

  let runs: PromotionCheckRun[] = [];
  if (pr !== null) {
    const repo = (ghJson(['repo', 'view', '--json', 'nameWithOwner']) as { nameWithOwner: string }).nameWithOwner;
    const payload = ghJson(['api', `repos/${repo}/commits/${targetSha}/check-runs?per_page=100`]) as {
      check_runs?: PromotionCheckRun[];
    };
    runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  }

  const verdict = decidePromotion({ targetSha, mainSha, mainIsAncestor: ancestor, pr, prCount, runs });
  const verdicts = join(REPO_ROOT, '.ci-local', 'verdicts');
  mkdirSync(verdicts, { recursive: true });
  const esito = verdict.ok ? (verdict.noop === true ? 'noop' : execute ? 'promosso-o-tentato' : 'aperto-dry-run') : 'chiuso';
  writeFileSync(
    join(verdicts, `promote-${targetSha.slice(0, 10)}-${mainSha.slice(0, 10)}.json`),
    JSON.stringify({ targetSha, mainSha, esito, at: new Date().toISOString() }, null, 2),
  );

  if (!verdict.ok) {
    process.stderr.write(`${verdict.message}\nGATE CHIUSO: main non si muove.\n`);
    process.exit(1);
  }
  process.stdout.write(`${verdict.note}\n`);
  if (verdict.noop === true) return;
  if (!execute) {
    process.stdout.write('DRY-RUN: push non eseguito. Rieseguire con --execute per promuovere davvero.\n');
    return;
  }
  const push = spawnSync('git', ['-C', REPO_ROOT, 'push', 'origin', `${targetSha}:main`], { encoding: 'utf8' });
  if (push.status !== 0) {
    process.stderr.write(`push rifiutato dal server (divergenza vera: main con storia fuori da target):\n${push.stderr ?? ''}\nGATE CHIUSO: main non si e' mosso.\n`);
    process.exit(1);
  }
  const remoto = git(['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0];
  if (remoto !== targetSha) {
    process.stderr.write(`verifica post-push fallita: origin/main e' ${remoto}, atteso ${targetSha}.\n`);
    process.exit(1);
  }
  process.stdout.write(`PROMOSSO: origin/main = ${targetSha.slice(0, 12)} (verificato via ls-remote).\n`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
