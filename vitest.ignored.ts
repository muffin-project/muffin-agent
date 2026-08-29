import { execFileSync } from 'node:child_process';

/**
 * Vitest non legge ciò che Git si rifiuta di tracciare.
 *
 * Perché esiste: il 30/08/2026, nel checkout dell'owner, `npm test` raccoglieva
 * **945** file di test di cui soltanto **201** appartenevano al repository. Gli
 * altri 744 venivano da due alberi annidati e completi:
 *
 *   .codex/worktrees/  342   worktree di un altro agente (`.git/info/exclude`)
 *   .releases/         402   le release affiancate di `muffin update` (`.gitignore`)
 *
 * Nessuno dei due compare in `git status`: il primo è escluso a mano, il secondo
 * è ignorato. Un gate che chiedeva «working tree pulito» leggeva quindi pulito e
 * poi certificava una misura fatta al 79% su copie congelate di *altri* commit.
 * I 97 rossi che l'owner ha visto venivano da `.codex/worktrees/pr186-*`, cioè
 * dal ramo di una PR aperta, non da HEAD.
 *
 * La lista fissa che c'era prima (`.claude/worktrees`, `.gate-linux`) inseguiva
 * i nomi uno per uno e arrivava sempre dopo il danno: `.releases/` esiste dal
 * giorno di `muffin update` e non era mai stato aggiunto. Questa versione non
 * insegue nomi — chiede a Git. L'invariante è più stretta della lista e si
 * mantiene da sola: se un albero è ignorato, non è il codice sotto misura.
 *
 * `.claude/hooks/` resta dentro, ed è la prova che l'invariante non è troppo
 * larga: è tracciato, quindi non è ignorato, quindi si continua a testare (era
 * il motivo per cui il pattern `**\/.claude/**` era stato ristretto).
 */

/**
 * Le esclusioni che non derivano da Git.
 *
 * `node_modules` è ignorato ovunque e ricadrebbe già nella derivazione, ma è il
 * default di vitest e resta esplicito perché la derivazione può fallire (v.
 * `escludiPerVitest`) e quel fallback non deve mai far girare le dipendenze.
 *
 * `*.accept.ts` non è ignorato da Git — è tracciato e va girato, ma dall'altro
 * comando (`npm run test:acceptance`). Non c'entra con questa invariante.
 */
export const ESCLUSIONI_FISSE = [
  '**/node_modules/**',
  'evals/acceptance/**/*.accept.ts',
];

/**
 * Traduce l'output di `git status --ignored --porcelain -z` in glob per vitest.
 *
 * Le voci di directory arrivano con lo slash finale (`.releases/`), i file
 * singoli senza (`.env`). Le prime diventano un sottoalbero, i secondi restano
 * il percorso esatto.
 */
export function globDaIgnorati(voci: readonly string[]): string[] {
  const glob: string[] = [];
  for (const voce of voci) {
    // `-z` non cita: la riga è `!! <percorso>` e basta togliere il prefisso.
    if (!voce.startsWith('!! ')) continue;
    const percorso = voce.slice(3);
    // Una voce vuota o `./` escluderebbe l'intero albero, e una suite che non
    // raccoglie niente è il caso in cui un rosso si stampa verde. Vitest esce 1
    // su zero file, ma questa riga è la difesa che non dipende da quel default.
    if (percorso === '' || percorso === '/' || percorso === './' || percorso === '.') continue;
    glob.push(percorso.endsWith('/') ? `${percorso}**` : percorso);
  }
  return glob;
}

/**
 * Chiede a Git cosa ignora, o `null` se non può rispondere.
 *
 * `null` e non un errore: la suite deve poter girare in un tarball senza `.git`
 * (dentro il container era così fino al 27/08). Chi chiama ricade sulla lista
 * fissa, che è più larga ma non silenziosamente vuota.
 */
export function ignoratiDaGit(radice: string): string[] | null {
  try {
    const uscita = execFileSync('git', ['status', '--ignored', '--porcelain', '-z'], {
      cwd: radice,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return globDaIgnorati(uscita.split('\0').filter((v) => v !== ''));
  } catch {
    return null;
  }
}

/**
 * La lista che finisce in `vitest.config.ts`.
 *
 * Quando Git non risponde restano le esclusioni fisse più i due alberi noti che
 * la derivazione avrebbe coperto: senza `.git` non c'è modo di scoprirli, e una
 * lista corta è meglio di una lista assente.
 */
export function escludiPerVitest(radice: string): string[] {
  const derivate = ignoratiDaGit(radice);
  if (derivate === null) {
    return [...ESCLUSIONI_FISSE, '**/.claude/worktrees/**', '**/.codex/**', '.releases/**', '**/.gate-linux/**'];
  }
  return [...ESCLUSIONI_FISSE, ...derivate];
}
