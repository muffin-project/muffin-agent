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
 * 3. Il push e' `git push origin <target>:main`, senza force: e' un
 *    compare-and-swap atomico del ref — se `main` si e' mosso nel frattempo,
 *    il push fallisce e il gate resta chiuso. Nessuna branch protection
 *    richiesta, nessuna inventata.
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
 * - push non fast-forward (main mossa sotto i piedi).
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
 * ## Parentela dichiarata (non duplicazione silenziosa)
 *
 * La valutazione dei check (ultimo per nome, richiesti nominali, eccezione
 * docs-only sull'allowlist) specchia `.claude/hooks/guard-merge-gate.mjs`
 * (porta slice→dev) adattata a base `main` e target pinnato. Due porte con
 * basi diverse, una regola condivisa da unificare dietro un'unica funzione
 * quando entrambe saranno atterrate — non prima, per non accoppiare due PR.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** L'insieme esentato di `ci.yml` — stessa parita' esatta dello hook slice→dev (vedi testa file). */
function fuoriInsiemeEsentato(path: string): boolean {
  if (path === 'README.md' || path === 'AGENTS.md' || path === 'CLAUDE.md') return false;
  if (path.startsWith('docs/') || path.startsWith('.claude/')) return false;
  return true;
}

function nomeNudo(name: string): string {
  const i = name.lastIndexOf('/');
  return (i === -1 ? name : name.slice(i + 1)).trim();
}

export interface PromotionPr {
  readonly number: number;
  readonly state: string;
  readonly isDraft?: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string;
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

  const latest = new Map<string, { at: number; run: PromotionCheckRun }>();
  for (const run of runs) {
    if (run?.name === undefined) continue;
    const at = Date.parse(run.completed_at ?? run.started_at ?? '0') || 0;
    const key = nomeNudo(run.name);
    if ((latest.get(key)?.at ?? -1) <= at) latest.set(key, { at, run });
  }
  const current = [...latest.values()].map((v) => v.run);
  if (current.length === 0) {
    return { ok: false, message: `nessun check sulla head ${corta(targetSha)}: senza evidenza il gate resta chiuso.` };
  }
  const pending = current.filter((r) => r.status !== 'completed').map((r) => r.name);
  if (pending.length > 0) {
    return { ok: false, message: `check in corso (${pending.join(', ')}): aspettare il verde e rieseguire.` };
  }
  const bad = current
    .filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''))
    .map((r) => `${r.name} (${r.conclusion})`);
  if (bad.length > 0) {
    return { ok: false, message: `check rossi (${bad.join(', ')}): ripara sul ramo, nessuna promozione.` };
  }
  const esito = (nome: string) => latest.get(nome)?.run?.conclusion;
  const mancanti = ['verifica', 'accettazione'].filter((n) => esito(n) !== 'success');
  if (mancanti.length === 0) {
    return {
      ok: true,
      note: `promozione pronta: main ${corta(mainSha)} → ${corta(targetSha)} (antenato verificato, PR #${pr.number} con verifica + accettazione success sulla head ${corta(targetSha)}).`,
    };
  }
  const files = pr.files;
  if (!Array.isArray(files)) {
    return {
      ok: false,
      message: `manca il successo ${mancanti.join(' + ')} e i file cambiati non sono leggibili: gate chiuso.`,
    };
  }
  const fuori: string[] = [];
  for (const f of files) {
    const path = typeof f === 'string' ? f : (f as { path?: unknown })?.path;
    if (typeof path !== 'string' || fuoriInsiemeEsentato(path)) fuori.push(String(path));
  }
  if (fuori.length > 0) {
    return {
      ok: false,
      message: `manca il successo ${mancanti.join(' + ')} e la promozione tocca file fuori dall'insieme esentato (${fuori.slice(0, 3).join(', ')}${fuori.length > 3 ? ', …' : ''}): gate chiuso.`,
    };
  }
  return {
    ok: true,
    note: `promozione docs-only pronta: main ${corta(mainSha)} → ${corta(targetSha)} (${files.length} file tutti esentati, check leggeri verdi, PR #${pr.number}).`,
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
        'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,files',
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
    process.stderr.write(`push rifiutato (main mossa sotto i piedi?):\n${push.stderr ?? ''}\nGATE CHIUSO: main non si e' mosso.\n`);
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
