import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * La radice del checkout che contiene una directory, in un modulo foglia.
 *
 * Viveva in `cli/update.ts`, che `cli/adopt.ts` importava — mentre `update.ts`
 * importa `reconcileDefaults` da `adopt.ts`. Quel ciclo (misurato con madge,
 * non presunto) rendeva l'ordine di valutazione dipendente dall'entry point,
 * e sotto il transform SSR di vitest un binding letto nel momento sbagliato
 * arrivava `undefined`: `describeBuild is not a function` a intermittenza in
 * `capability-gaps.test.ts` (issue #558).
 *
 * La regola è meccanica: i due moduli CLI si parlano in una direzione sola
 * (`update` → `adopt`), e la radice sta qui sotto entrambi. Il runner reale è
 * locale per la stessa ragione — importare quello di `update.ts` sposterebbe
 * il ciclo invece di romperlo — con lo stesso contratto (timeout, mai throw).
 */
export type GitRunner = (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };

function realGitRunner(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function findCheckoutRoot(moduleDir: string, gitRunner: GitRunner = realGitRunner): string | null {
  const wt = gitRunner(['worktree', 'list', '--porcelain'], moduleDir);
  if (wt.status === 0) {
    const prima = wt.stdout.split('\n').find((l) => l.startsWith('worktree '));
    const principale = prima?.slice('worktree '.length).trim();
    if (principale !== undefined && principale !== '') {
      try {
        return realpathSync(principale);
      } catch {
        return principale;
      }
    }
  }
  const r = gitRunner(['rev-parse', '--show-toplevel'], moduleDir);
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  if (top === '') return null;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}
