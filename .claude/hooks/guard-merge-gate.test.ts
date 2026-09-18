import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decideGitHubMerge, type GitHubDecision } from './guard-merge-gate.mjs';

/**
 * Il guard che manda ogni merge da un gate vero. Vedi la testa di
 * `guard-merge-gate.mjs` per i due guasti che l'hanno reso necessario
 * (04/09 cieco senza CI, e il collo di bottiglia locale una volta tornata la
 * CI a meta' settembre 2026).
 */
const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-merge-gate.mjs');

function esegui(command: string, env: Record<string, string> = {}): { code: number; err: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    // Fail-closed anche qui: lo spawn non tocca la rete, il percorso GitHub
    // vive nei test di decide() qui sotto con query finte.
    env: { ...process.env, MUFFIN_MERGE_DIRECT: '', MUFFIN_GATE_OFFLINE: '1', ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, err: r.stderr };
}

describe('guard-merge-gate', () => {
  it('rifiuta `gh pr merge` e nomina la porta con il numero della PR', () => {
    const r = esegui('cd /x && gh pr merge 418 --merge --delete-branch=false 2>&1 | tail -1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('npm run merge -- 418');
  });

  it('lascia passare la porta stessa e gli altri verbi di gh', () => {
    for (const c of ['npm run merge -- 418', 'gh pr view 418 --json state', 'gh pr create --base dev', 'gh pr close 416']) {
      expect(esegui(c).code, c).toBe(0);
    }
  });

  it("un `gh pr merge` citato dentro una stringa non e' un merge", () => {
    expect(esegui(`git commit -m 'docs: mai piu gh pr merge a mano'`).code).toBe(0);
  });

  it("il bypass e' esplicito, nel comando o nell'ambiente", () => {
    expect(esegui('MUFFIN_MERGE_DIRECT=1 gh pr merge 5 --merge').code).toBe(0);
    expect(esegui('gh pr merge 5 --merge', { MUFFIN_MERGE_DIRECT: '1' }).code).toBe(0);
  });
});

/**
 * Il percorso GitHub, con query finte: la rete vera non entra negli unit test.
 * Ogni ramo che non e' "tutto verde a base ferma" ricade sul messaggio locale.
 */
describe('decideGitHubMerge', () => {
  const info = (over = {}) => ({
    number: 553,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'dev',
    headRefOid: 'fc2b15f2b4c894080ed1ddc98c9d9ec443282859',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    files: [],
    ...over,
  });
  const run = (name: string, status = 'completed', conclusion: string | null = 'success') => ({ name, status, conclusion });
  const finta = (infoOver = {}, runs = [run('verifica'), run('accettazione'), run('collegamenti'), run('install')]) => {
    const i = info(infoOver);
    return (args: string[]) => {
      if (args[0] === 'pr') return i;
      if (args[0] === 'repo') return 'muffin-project/muffin-agent';
      return { check_runs: runs };
    };
  };

  it('passa con tutto verde a base ferma', () => {
    const d = decideGitHubMerge('553', finta());
    expect(d.ok).toBe(true);
  });

  it('la query che fallisce ricade sulla porta locale, mai un via libera', () => {
    const d = decideGitHubMerge('553', () => {
      throw new Error('rete giu');
    });
    expect(no(d)).toContain('npm run merge -- 553');
  });

  it('PR chiusa o base non-dev non passano di qui', () => {
    expect(decideGitHubMerge('553', finta({ state: 'MERGED' })).ok).toBe(false);
    const main = decideGitHubMerge('10', finta({ baseRefName: 'main' }));
    expect(no(main)).toContain('npm run merge');
  });

  it('base mossa o stato non CLEAN: aggiorna il ramo', () => {
    const d = decideGitHubMerge('553', finta({ mergeStateStatus: 'BEHIND' }));
    expect(no(d)).toContain('Aggiorna il ramo');
  });

  it('zero check-run: nessuna evidenza, nessuna scorciatoia', () => {
    const d = decideGitHubMerge('553', finta({}, []));
    expect(no(d)).toContain('npm run merge -- 553');
  });

  it('rossi e in-corso bloccano, con nomi che dicono quali', () => {
    const rosso = decideGitHubMerge('553', finta({}, [run('verifica'), run('accettazione', 'completed', 'failure')]));
    expect(no(rosso)).toContain('accettazione');

    const corso = decideGitHubMerge('553', finta({}, [run('verifica'), run('accettazione', 'in_progress', null)]));
    expect(no(corso)).toContain('in corso');
  });

  it('skipped e neutral sui sidecar non bloccano quando FAST+DEEP sono success', () => {
    const d = decideGitHubMerge(
      '553',
      finta({}, [run('verifica'), run('accettazione'), run('collegamenti', 'completed', 'skipped')]),
    );
    expect(d.ok).toBe(true);

    const rerun = [
      { name: 'verifica', status: 'completed', conclusion: 'failure', completed_at: '2026-09-17T10:00:00Z' },
      { name: 'verifica', status: 'completed', conclusion: 'success', completed_at: '2026-09-17T09:00:00Z' },
    ];
    expect(decideGitHubMerge('553', finta({}, rerun)).ok).toBe(false);
  });

  it('una bozza non passa di qui: DEEP non gira sulle bozze per disegno', () => {
    const d = decideGitHubMerge('553', finta({ isDraft: true }));
    expect(no(d)).toContain('bozza');
  });

  it('un isDraft assente o inatteso vale come dubbio: rifiuto fail-closed', () => {
    const senza = { ...info() };
    delete (senza as Record<string, unknown>).isDraft;
    const d = decideGitHubMerge('553', (args: string[]) => {
      if (args[0] === 'pr') return senza;
      if (args[0] === 'repo') return 'muffin-project/muffin-agent';
      return { check_runs: [run('verifica'), run('accettazione')] };
    });
    expect(no(d)).toContain('bozza');
  });

  it('accettazione skippata su PR di codice: rifiuto, skipped non e\' evidenza', () => {
    const d = decideGitHubMerge(
      '553',
      finta({ files: [{ path: 'core/policy/gate.ts' }] }, [run('verifica'), run('accettazione', 'completed', 'skipped')]),
    );
    expect(no(d)).toContain('accettazione');
  });

  it('accettazione mancante su PR di codice: rifiuto', () => {
    const d = decideGitHubMerge('553', finta({ files: [{ path: 'core/policy/gate.ts' }] }, [run('verifica')]));
    expect(no(d)).toContain('accettazione');
  });

  it('FAST+DEEP success sulla head: via libera con nota che nomina entrambi', () => {
    const d = decideGitHubMerge(
      '553',
      finta({ files: [{ path: 'core/policy/gate.ts' }] }, [run('verifica'), run('accettazione')]),
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.note).toContain('FAST+DEEP');
  });

  it('docs-only + collegamenti verde: eccezione con allowlist sui file veri', () => {
    const d = decideGitHubMerge(
      '553',
      finta(
        { files: [{ path: 'docs/piano.md' }, { path: '.claude/hooks/g.mjs' }, 'README.md'] },
        [run('collegamenti')],
      ),
    );
    expect(d.ok).toBe(true);
  });

  it('docs + codice senza verifica: rifiuto, e nomina il path fuori insieme', () => {
    const d = decideGitHubMerge(
      '553',
      finta({ files: [{ path: 'docs/piano.md' }, { path: 'core/policy/gate.ts' }] }, [run('collegamenti')]),
    );
    expect(no(d)).toContain('core/policy/gate.ts');
  });

  it('file cambiati illeggibili: rifiuto fail-closed, mai inferenza', () => {
    const d = decideGitHubMerge('553', finta({ files: null }, [run('collegamenti')]));
    expect(no(d)).toContain('npm run merge -- 553');
  });

  it('un sidecar rosso blocca anche con FAST+DEEP verdi', () => {
    const d = decideGitHubMerge(
      '553',
      finta(
        { files: [{ path: '.claude/hooks/g.mjs' }] },
        [run('verifica'), run('accettazione'), run('strumenti', 'completed', 'failure')],
      ),
    );
    expect(no(d)).toContain('strumenti');
  });

  it('una risposta non-oggetto non fa mai passare: fail-closed, non crash', () => {
    // Regressione del flag `-q` (raw invece di JSON): qualunque forma
    // imprevista ricade sulla porta locale invece di lanciare.
    const strana = (args: string[]) => {
      if (args[0] === 'pr') return info();
      return 'muffin-project/muffin-agent';
    };
    const d = decideGitHubMerge('553', strana);
    expect(no(d)).toContain('npm run merge -- 553');
  });
});

function no(d: GitHubDecision): string {
  expect(d.ok).toBe(false);
  if (d.ok) throw new Error('atteso un rifiuto');
  return d.message;
}
