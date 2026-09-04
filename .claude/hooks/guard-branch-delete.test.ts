import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Il guard che impedisce di cancellare un branch remoto che regge una PR
 * aperta (testa o base). La decisione dipende da cosa risponde `gh`, quindi
 * ogni caso gira contro un `gh` finto messo davanti nel PATH: è l'unico modo
 * di esercitare la scelta vera — stessa ragione per cui i casi di
 * `guard-restore-discard` girano contro un repository vero.
 *
 * Il finto risponde come il giorno del guasto: `slice/con-pr` è testa della
 * PR aperta #84, `slice/base` è la base su cui la #84 poggia (la forma
 * impilata di #83→#84), tutto il resto non ha PR.
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-branch-delete.mjs');

let binConGh: string;
let binSenzaGh: string;

function esegui(command: string, env: Record<string, string> = {}): { code: number; err: string } {
  // spawnSync e non execFileSync: qui lo stderr conta anche quando l'exit è 0,
  // perché il percorso "gh non risponde" passa CON un warning — ed è proprio
  // quel warning che i casi devono poter leggere.
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    env: {
      ...process.env,
      PATH: `${binConGh}:${process.env['PATH']}`,
      // Il timeout della guardia e' fissato qui, e non lasciato al suo default
      // di 3s, perche' su timeout la guardia **fallisce aperta**: se lo `sh`
      // finto non risponde in tempo il delete passa, e il caso diventa verde
      // per la ragione opposta a quella che asserisce.
      //
      // Non e' teorico. Il 04/09/2026, con la suite intera in parallelo su
      // questa macchina, «rifiuta il delete di un branch che e' testa di una
      // PR aperta» ha dato `expected +0 to be 2`, e da solo sullo stesso
      // commit passava. Un test cosi' misura quanto e' carica la CPU, non cosa
      // fa la guardia.
      //
      // 30s non e' un'attesa: e' un numero abbastanza grande da non poter
      // essere raggiunto se non quando qualcosa e' rotto davvero. Il caso che
      // prova il timeout lo sovrascrive a 200ms — `...env` viene dopo apposta.
      MUFFIN_GH_TIMEOUT_MS: '30000',
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, err: r.stderr ?? '' };
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'guard-branch-delete-'));
  binConGh = join(base, 'con-gh');
  binSenzaGh = join(base, 'senza-gh');
  mkdirSync(binConGh);
  mkdirSync(binSenzaGh);
  writeFileSync(
    join(binConGh, 'gh'),
    `#!/bin/sh
# gh finto: risponde come il repository il giorno del guasto.
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; echo '[]'; exit 0; fi
case "$*" in
  *"pr view"*)               echo '{"number":83,"headRefName":"slice/base"}' ;;
  *"--head slice/con-pr"*)   echo '[{"number":84,"title":"PR impilata"}]' ;;
  *"--base slice/base"*)     echo '[{"number":84,"title":"PR impilata"}]' ;;
  *)                         echo '[]' ;;
esac
`,
  );
  chmodSync(join(binConGh, 'gh'), 0o755);
});

describe('guard-branch-delete', () => {
  it('rifiuta il delete di un branch che è testa di una PR aperta', () => {
    const r = esegui('git push origin --delete slice/con-pr');
    expect(r.code).toBe(2);
    expect(r.err).toContain('#84');
    // Il messaggio deve insegnare la forma atomica e il gate vero, non solo
    // vietare: è il solo momento in cui quella conoscenza arriva in tempo.
    expect(r.err).toContain('gh pr merge');
    expect(r.err).toContain('isDraft');
    expect(r.err).toContain('mergeable');
  });

  it('rifiuta il delete di un branch che è base di una PR impilata', () => {
    // La forma del primo guasto: il branch non ha una PR con quella testa,
    // ma la #84 ci poggia sopra come base — cancellarlo la chiude a cascata.
    const r = esegui('git push origin --delete slice/base');
    expect(r.code).toBe(2);
    expect(r.err).toContain('base della PR aperta #84');
  });

  it('lascia passare il delete di un branch senza PR aperte', () => {
    expect(esegui('git push origin --delete slice/senza-pr').code).toBe(0);
  });

  it('vede anche la forma storica `git push origin :branch`', () => {
    const r = esegui('git push origin :slice/con-pr');
    expect(r.code).toBe(2);
    expect(r.err).toContain('slice/con-pr');
  });

  it('rifiuta `gh pr close --delete-branch` quando altre PR poggiano su quella testa', () => {
    // Il primo guasto, testuale: chiudere la #83 cancellandone la testa
    // (slice/base) chiude a cascata la #84 che la usa come base.
    const r = esegui('gh pr close 83 --delete-branch');
    expect(r.code).toBe(2);
    expect(r.err).toContain('#84');
  });

  it('vede il delete anche in fondo a una catena — la forma del secondo guasto', () => {
    const r = esegui('gh pr merge 84 --merge; git push origin --delete slice/con-pr');
    expect(r.code).toBe(2);
  });

  it('non si arma per un messaggio che nomina il comando fra virgolette', () => {
    // In un repository i cui messaggi di commit raccontano pratica git, la
    // frase più probabile è proprio questa — e non deve chiamare `gh` né
    // rifiutare niente.
    const r = esegui('git commit -m "git push origin --delete slice/con-pr"');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  it('cede all override esplicito, che resta visibile nel transcript', () => {
    expect(esegui('MUFFIN_BRANCH_DELETE_OK=1 git push origin --delete slice/con-pr').code).toBe(0);
  });

  it('con `gh` assente passa con un warning: il guard non blocca il lavoro offline', () => {
    const r = esegui('git push origin --delete slice/con-pr', { PATH: binSenzaGh });
    expect(r.code).toBe(0);
    expect(r.err).toContain('gh');
    expect(r.err).toContain('passa');
  });

  it('con `gh` lento passa con un warning entro il timeout', () => {
    const r = esegui('git push origin --delete slice/con-pr', {
      FAKE_GH_SLEEP: '2',
      MUFFIN_GH_TIMEOUT_MS: '200',
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain('non posso verificare');
  });
});
