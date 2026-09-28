import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ESCLUSIONI_FISSE, escludiPerVitest, globDaIgnorati, ignoratiDaGit } from './vitest.ignored.js';

/** Regression coverage: Vitest must not collect tests from Git-ignored trees
 * nested inside the checkout. The cases use a real temporary Git repository
 * and inspect the files Vitest discovers. */

const repos: string[] = [];

afterEach(() => {
  while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
});

function repoFinto(): string {
  const radice = mkdtempSync(join(tmpdir(), 'muffin-ignorati-'));
  repos.push(radice);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: radice, stdio: ['ignore', 'ignore', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'gate');
  // Il codice sotto misura: un test tracciato che deve continuare a girare.
  mkdirSync(join(radice, 'core'), { recursive: true });
  writeFileSync(join(radice, 'core', 'suo.test.ts'), 'export {};\n');
  writeFileSync(join(radice, '.gitignore'), '.releases/\nnode_modules/\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return radice;
}

/** L'albero annidato: una copia completa del repo dentro il repo, ignorata. */
function annidaAlberoIgnorato(radice: string, dove: string, quanti: number): void {
  mkdirSync(join(radice, dove, 'core'), { recursive: true });
  for (let i = 0; i < quanti; i++) {
    writeFileSync(join(radice, dove, 'core', `altrui-${i}.test.ts`), 'export {};\n');
  }
}

describe('globDaIgnorati', () => {
  it('trasforma una directory ignorata in un sottoalbero e un file nel percorso esatto', () => {
    expect(globDaIgnorati(['!! .releases/', '!! .env'])).toEqual(['.releases/**', '.env']);
  });

  it('ignora le righe che non sono voci ignorate', () => {
    // `--porcelain` mescola stati: solo `!!` è «ignorato». Se prendessimo anche
    // ` M core/x.ts` escluderemmo dal test proprio il file appena modificato.
    expect(globDaIgnorati([' M core/x.ts', '?? nuovo.ts', '!! dist/'])).toEqual(['dist/**']);
  });

  it('non lascia passare una voce che escluderebbe l intero albero', () => {
    // Una suite che non raccoglie niente è il modo in cui un rosso si stampa
    // verde. Nessuna di queste quattro deve produrre un glob.
    expect(globDaIgnorati(['!! ', '!! /', '!! ./', '!! .'])).toEqual([]);
  });
});

describe('ignoratiDaGit', () => {
  it('risponde null fuori da un repository, invece di lanciare', () => {
    const fuori = mkdtempSync(join(tmpdir(), 'muffin-non-repo-'));
    repos.push(fuori);
    expect(ignoratiDaGit(fuori)).toBeNull();
  });

  it('trova un albero annidato che git status non mostra', () => {
    const radice = repoFinto();
    annidaAlberoIgnorato(radice, '.releases/abc123', 3);
    // La misura che rende il difetto visibile: lo stato è pulito e l albero c è.
    const stato = execFileSync('git', ['status', '--porcelain'], { cwd: radice, encoding: 'utf8' });
    expect(stato).toBe('');
    expect(ignoratiDaGit(radice)).toContain('.releases/**');
  });
});

describe('escludiPerVitest', () => {
  it('tiene le esclusioni fisse anche quando git risponde', () => {
    const radice = repoFinto();
    for (const fissa of ESCLUSIONI_FISSE) expect(escludiPerVitest(radice)).toContain(fissa);
  });

  it('ricade su una lista non vuota quando git non può rispondere', () => {
    const fuori = mkdtempSync(join(tmpdir(), 'muffin-non-repo-'));
    repos.push(fuori);
    const lista = escludiPerVitest(fuori);
    // Il fallback deve nominare gli alberi che la derivazione avrebbe coperto:
    // senza `.git` non c è modo di scoprirli.
    expect(lista).toContain('**/.codex/**');
    expect(lista).toContain('.releases/**');
    expect(lista).toContain('**/.claude/worktrees/**');
  });
});

/**
 * La prova che conta: cosa raccoglie vitest, non cosa ritorna la funzione.
 *
 * Gira vitest vero nel repository finto, una volta con la lista vecchia
 * (mutazione: le sole esclusioni fisse) e una con quella derivata. Se la
 * derivazione si stacca, il primo caso resta verde e il secondo cade —
 * cioè il test muore quando la difesa si scollega, che è il punto.
 */
/**
 * Fa girare vitest **vero** su una radice finta, con la lista di esclusioni
 * passata da riga di comando: nessun file di config nel repo finto, quindi
 * nessun `node_modules` da installare li dentro. Il binario si risolve dal
 * repository che sta girando i test, non da un percorso scritto a mano.
 */
const VITEST_BIN = (() => {
  const richiedi = createRequire(import.meta.url);
  const manifesto = richiedi.resolve('vitest/package.json');
  const bin = JSON.parse(readFileSync(manifesto, 'utf8')).bin;
  return join(dirname(manifesto), typeof bin === 'string' ? bin : bin.vitest);
})();

function raccolti(radice: string, esclusioni: string[]): string[] {
  const argomenti = [VITEST_BIN, 'list', '--filesOnly', '--root', radice];
  for (const glob of esclusioni) argomenti.push('--exclude', glob);
  const run = spawnSync(process.execPath, argomenti, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`vitest list e uscito ${run.status}: ${run.stderr}`);
  return run.stdout
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.endsWith('.test.ts'));
}


describe('vitest, davvero', () => {
  it('senza la derivazione raccoglie l albero annidato — è il difetto misurato', () => {
    const radice = repoFinto();
    annidaAlberoIgnorato(radice, '.releases/abc123', 5);
    const file = raccolti(radice, [...ESCLUSIONI_FISSE]);
    expect(file.filter((f) => f.includes('.releases'))).toHaveLength(5);
    expect(file).toHaveLength(6);
  }, 60_000);

  it('con la derivazione raccoglie solo il codice tracciato', () => {
    const radice = repoFinto();
    annidaAlberoIgnorato(radice, '.releases/abc123', 5);
    const file = raccolti(radice, escludiPerVitest(radice));
    expect(file.filter((f) => f.includes('.releases'))).toHaveLength(0);
    expect(file.some((f) => f.endsWith('core/suo.test.ts'))).toBe(true);
    expect(file).toHaveLength(1);
  }, 60_000);

  it('non esclude un albero tracciato che somiglia a uno ignorato', () => {
    // `.claude/hooks/` è tracciato e va testato: è la prova che l invariante
    // «ciò che git ignora» non è più larga di così. Il pattern che c era prima
    // (`**\/.claude/**`) li aveva esclusi tutti, e un tetto aggiunto lì era
    // partito senza test e sbagliato.
    const radice = repoFinto();
    mkdirSync(join(radice, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(radice, '.claude', 'hooks', 'gancio.test.ts'), 'export {};\n');
    execFileSync('git', ['add', '-A'], { cwd: radice, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'hooks'], { cwd: radice, stdio: 'ignore' });
    const file = raccolti(radice, escludiPerVitest(radice));
    expect(file.some((f) => f.includes('.claude/hooks'))).toBe(true);
  }, 60_000);
});
