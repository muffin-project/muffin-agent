import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * L'identità di una build e chi la legge, senza dipendenze di progetto.
 *
 * Questo modulo è una foglia per costruzione: solo `node:` qui dentro, mai
 * `cli/`, `agent/` o `core/`. La ragione è un ordine di valutazione che morde
 * solo su Linux: `cli/doctor.ts` importava `describeBuild` da `cli/update.ts`,
 * e sotto vite-node il binding statico è stato visto arrivare `undefined` al
 * momento della valutazione (`TypeError: describeBuild is not a function`,
 * solo su CI/hosted, tre test di `agent/capability-gaps.test.ts`, 17/09/2026
 * — verde su macOS, rosso deterministico su Linux, stesso albero). Una foglia
 * non ha cicli possibili in nessuna direzione e si valuta sempre per prima:
 * la forma dell'import (statico o differito) smette di contare.
 * `cli/update.ts` riesporta tutto da qui, quindi la superficie esistente
 * (`./update.js`) non cambia per nessun importatore.
 */

export type SpawnResult = { status: number; stdout: string; stderr: string };
export type GitRunner = (args: string[], cwd: string) => SpawnResult;

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): SpawnResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  const stderr = r.stderr && r.stderr.trim() !== '' ? r.stderr : r.error ? r.error.message : (r.stderr ?? '');
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr };
}

export function git(args: string[], cwd: string): SpawnResult {
  return run('git', args, cwd);
}

export type BuildStamp = { sha: string; date: string; dirty: boolean };

/**
 * L'identità di una build, che qui è un commit e non un numero di versione.
 *
 * `package.json` dice `0.0.0` e non è sbagliato: è vuoto. Questo progetto non
 * si distribuisce per release numerate — `muffin update` costruisce
 * `.releases/<sha>` e scambia il launcher, quindi **la cosa che identifica una
 * build è il suo commit**, ed è già quello che l'aggiornamento maneggia.
 *
 * Misurato il 27/08: per capire quale build fosse installata sulla macchina
 * dell'owner ho dovuto interrogare i sottocomandi — `muffin trace --help` non
 * aveva `turn`, `doctor` non aveva la riga `defaults` — e dedurre da lì che
 * fosse anteriore a #133 e #142. Una domanda a cui il binario dovrebbe
 * rispondere da solo.
 *
 * `dirty` non è un dettaglio: un checkout modificato **non è** quel commit, e
 * dire il suo SHA senza dirlo è la stessa classe di bugia di tutto il resto di
 * questa settimana — precisa, verificabile e falsa.
 *
 * `null` quando non c'è un checkout Git (un'installazione da tarball): non
 * sappiamo, e si dice.
 */
export function describeBuild(moduleDir: string, gitRunner: GitRunner = git): BuildStamp | null {
  const head = gitRunner(['log', '-1', '--format=%H %cs'], moduleDir);
  if (head.status !== 0) return null;
  const [sha, date] = head.stdout.trim().split(' ');
  if (sha === undefined || date === undefined || sha.length < 7) return null;
  const status = gitRunner(['status', '--porcelain'], moduleDir);
  // Uno `status` che fallisce non rende la build pulita: nel dubbio si dichiara
  // toccata, perché l'errore che costa è il contrario.
  return { sha, date, dirty: status.status !== 0 || status.stdout.trim() !== '' };
}

/**
 * Il checkout che possiede `.releases/` — che è il **worktree principale**, non
 * quello da cui questo processo sta girando.
 *
 * `rev-parse --show-toplevel` risponde con il worktree *corrente*, e una release
 * È un worktree collegato (`git worktree add`). Quindi dopo il primo update il
 * processo in esecuzione vive dentro `.releases/<sha>`, `--show-toplevel` da lì
 * risponde con quella directory, e la release successiva viene creata **dentro**
 * la precedente. Misurato sulla macchina dell'owner il 27/08 dopo tre update:
 *
 *     .releases/9a98bbe/.releases/2c35425/.releases/9e1b5af/dist/cli/main.js
 *
 * cioè il percorso a cui puntava davvero il launcher. Non è cosmetico e non si
 * ferma da solo:
 *
 *  - il percorso cresce di un livello a ogni aggiornamento, per sempre;
 *  - `pruneOldReleases` guarda nel `.releases` della radice che ha trovato,
 *    quindi pota i fratelli dentro l'ultimo nido e **non** i gusci esterni: il
 *    disco cresce e nessuno lo rivendica;
 *  - `--rollback` legge il `current` del nido corrente, quindi si può tornare
 *    indietro di un passo solo, e i passi precedenti diventano irraggiungibili;
 *  - `doctor` costruisce i suoi rimedi da questa radice, ed è così che è uscito
 *    un `cp .releases/…/.releases/…/.releases/…/defaults/voice.md` — la riga che
 *    ha reso il difetto visibile.
 *
 * `git worktree list --porcelain` mette il worktree principale **per primo**, ed
 * è documentato che lo faccia: è la domanda giusta da fare, invece di dedurre da
 * dove si sta girando. Il fallback su `--show-toplevel` resta per il caso in cui
 * `worktree list` non risponda — su un checkout normale le due risposte
 * coincidono, quindi il fallback non cambia niente per chi non ha mai aggiornato.
 */
export function findCheckoutRoot(moduleDir: string, gitRunner: GitRunner = git): string | null {
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
