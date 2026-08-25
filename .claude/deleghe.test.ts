import { cpSync, chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'deleghe.mjs');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function fixture(): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = mkdtempSync(join(tmpdir(), 'muffin-deleghe-'));
  mkdirSync(join(repo, '.claude', 'deleghe'), { recursive: true });
  cpSync(SCRIPT, join(repo, '.claude', 'deleghe.mjs'));

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'base');

  git(repo, 'switch', '-c', 'slice/documenti');
  writeFileSync(join(repo, 'documenti.txt'), 'done\n');
  git(repo, 'add', 'documenti.txt');
  git(repo, 'commit', '-m', 'documents');
  const documents = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'switch', '-c', 'dev', 'main');
  git(repo, 'merge', '--no-ff', 'slice/documenti', '-m', 'Merge pull request #27 from owner/slice/documenti');
  git(repo, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/slice/documenti', documents);

  git(repo, 'switch', '-c', 'slice/aperta');
  writeFileSync(join(repo, 'aperta.txt'), 'open\n');
  git(repo, 'add', 'aperta.txt');
  git(repo, 'commit', '-m', 'open work');
  git(repo, 'update-ref', 'refs/remotes/origin/slice/aperta', 'HEAD');
  git(repo, 'switch', 'dev');

  writeFileSync(
    join(repo, '.claude', 'deleghe', 'registro.jsonl'),
    [
      { id: 'done', slug: 'documenti', branch: 'slice/documenti', cosa: 'C7' },
      { id: 'open', slug: 'aperta', branch: 'slice/aperta', cosa: 'B2' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  );

  const bin = join(repo, 'bin');
  mkdirSync(bin);
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitPath, join(bin, 'git'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  return { repo, env: { ...process.env, PATH: bin } };
}

function run(f: { repo: string; env: NodeJS.ProcessEnv }, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [join(f.repo, '.claude', 'deleghe.mjs'), ...args], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

/**
 * Deleghe misurate finte, sotto una home finta.
 *
 * La home conta: `preventivo` legge i transcript reali sotto `~/.claude`, e un
 * test che dipendesse da quelli misurerebbe la macchina di chi lo esegue invece
 * del comportamento dello script. `homedir()` segue `$HOME` su POSIX.
 */
function transcripts(
  repo: string,
  n: number,
  token: number,
  { chiamate = 0, modello = 'claude-sonnet-5' }: { chiamate?: number; modello?: string } = {},
): NodeJS.ProcessEnv {
  const home = join(repo, 'home');
  const dir = join(home, '.claude', 'projects', 'progetto', 'sessione', 'subagents');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const riga = JSON.stringify({
      type: 'assistant',
      message: {
        model: modello,
        content: Array.from({ length: chiamate }, (_, k) => ({ type: 'tool_use', name: `strumento${k}`, input: {} })),
        usage: { input_tokens: token / 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 9e6, output_tokens: token / 2 },
      },
    });
    writeFileSync(join(dir, `agent-${i}.jsonl`), `${riga}\n`);
  }
  return { HOME: home };
}

describe('a delegation killed by quota', () => {
  it('round-trip: a fresh process recovers what to relaunch and where to restart', () => {
    const f = fixture();
    run(f, 'registra', 'morta1', 'audit-taint', 'D12: l ASK dice cosa');
    const p = run(f, 'parcheggia', 'morta1', 'API 529 overloaded', '--prossima', 'rileggere core/policy/decide.ts');
    expect(p.code).toBe(0);
    expect(p.out).toContain('parcheggiata audit-taint');

    // Il round-trip vero: un processo separato, senza niente in contesto.
    const ripresa = run(f, 'riprendi');
    expect(ripresa.out).toContain('PARCHEGGIATE (1)');
    expect(ripresa.out).toContain('audit-taint');
    expect(ripresa.out).toContain('API 529 overloaded');
    expect(ripresa.out).toContain('D12: l ASK dice cosa');
    expect(ripresa.out).toContain('riparti da: rileggere core/policy/decide.ts');
    expect(ripresa.out).toContain('raccogli morta1');
  });

  it('is not counted as open work: that distinction is the whole point', () => {
    // Prima del parcheggio una delega morta compariva fra le riprendibili
    // identica a una che stava lavorando. Senza questa riga il test passerebbe
    // anche con `parcheggia` che scrive e basta.
    const f = fixture();
    run(f, 'registra', 'morta1', 'audit-taint', 'D12');
    const prima = run(f, 'riprendi');
    expect(prima.out).toContain('SCONOSCIUTE (2)');
    expect(prima.out).toContain('PARCHEGGIATE (0)');

    run(f, 'parcheggia', 'morta1', 'session limit raggiunto');
    const dopo = run(f, 'riprendi');
    expect(dopo.out).toContain('PARCHEGGIATE (1)');
    expect(dopo.out).toContain('SCONOSCIUTE (1)');
    expect(dopo.out).not.toMatch(/SCONOSCIUTE[\s\S]*audit-taint/);
  });

  it('stops being parked once it has been relaunched and closed', () => {
    const f = fixture();
    run(f, 'registra', 'morta1', 'audit-taint', 'D12');
    run(f, 'parcheggia', 'morta1', 'quota');
    run(f, 'chiudi', 'morta1', 'rilanciata come vivo2');

    const dopo = run(f, 'riprendi');
    expect(dopo.out).toContain('PARCHEGGIATE (0)');
    expect(dopo.out).toContain('rilanciata come vivo2');
  });

  it('warns when the error is not a quota death, because then it is a closure', () => {
    const f = fixture();
    run(f, 'registra', 'morta1', 'audit-taint', 'D12');
    const p = run(f, 'parcheggia', 'morta1', 'il test non compilava');
    expect(p.out).toContain('non sembra una morte per quota');
  });
});

describe('a delegation closed without ever having been registered', () => {
  // Quattro righe del registro vero sono così: solo una `chiudi` per id, perché
  // la `registra` non è atterrata mentre la sessione veniva compattata. È lo
  // stato parziale che questo strumento esiste per sopravvivere, e faceva
  // saltare i due comandi con cui una sessione fresca comincia.
  function conOrfana(): ReturnType<typeof fixture> {
    const f = fixture();
    execFileSync(process.execPath, [join(f.repo, '.claude', 'deleghe.mjs'), 'chiudi', 'orfana1', 'judge #47: MERGE'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });
    return f;
  }

  it('does not crash `stato`', () => {
    const r = run(conOrfana(), 'stato');
    expect(r.code).toBe(0);
    expect(r.out).toContain('(mai registrata)');
    expect(r.out).toContain('orfana1');
  });

  it('does not crash `riprendi`, the command a fresh session runs first', () => {
    const r = run(conOrfana(), 'riprendi');
    expect(r.code).toBe(0);
    expect(r.out).toContain('(mai registrata)');
  });

  it('says why it matters: no mandate and no brief survive for those', () => {
    const r = run(conOrfana(), 'riprendi');
    expect(r.out).toContain('1 chiuse senza registrazione');
    expect(r.out).toContain('non sono recuperabili');
  });
});

describe('damaged state, found before new work', () => {
  it('finds real conflict markers and exits non-zero', () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'rotto.ts'), '<<<<<<< HEAD\nmio\n=======\ntuo\n>>>>>>> branch\n');
    git(f.repo, 'add', 'rotto.ts');

    const r = run(f, 'diagnosi');
    expect(r.code).toBe(1);
    expect(r.out).toContain('marcatori di conflitto in 1 file');
    expect(r.out).toContain('rotto.ts');
  });

  it('does not mistake a Markdown h1 underline for a conflict', () => {
    // `grep '======='` segnala ogni titolo sottolineato, e in un repo che tocca
    // più Markdown che TypeScript un controllo così viene disattivato entro una
    // settimana. È la ragione per cui il marcatore si ancora ad aperto + chiuso.
    const f = fixture();
    writeFileSync(join(f.repo, 'titolo.md'), 'Un titolo\n=========\n\ntesto\n');
    git(f.repo, 'add', 'titolo.md');
    git(f.repo, 'commit', '-m', 'docs');

    expect(run(f, 'diagnosi').out).not.toContain('marcatori di conflitto');
  });

  it('reports a merge left half done, and refuses to undo it by itself', () => {
    const f = fixture();
    writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), 'deadbeef\n');

    const r = run(f, 'diagnosi');
    expect(r.code).toBe(1);
    expect(r.out).toContain('merge a metà');
    expect(r.out).toContain('a mano: può distruggere lavoro');
  });

  it('reaches the resume briefing, so it is read before choosing a delegation', () => {
    const f = fixture();
    writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(run(f, 'riprendi').out).toContain('merge a metà');
  });
});

describe('pricing a fanout from measured delegations', () => {
  it('reports the measured distribution instead of a guess', () => {
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 6, 2000) };

    const r = run({ ...f, env }, 'preventivo', '4');
    expect(r.code).toBe(0);
    expect(r.out).toContain('6 deleghe misurate');
    expect(r.out).toContain('p50 2k · p80 2k token');
    expect(r.out).toContain('~8k token');
  });

  it('refuses when there is not enough history to produce a number', () => {
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 2, 2000) };

    const r = run({ ...f, env }, 'preventivo', '3');
    expect(r.code).toBe(1);
    expect(r.out).toContain('campione insufficiente');
  });

  it('gates only when a ceiling is actually passed, and proposes the cheaper sequence', () => {
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 6, 2000) };

    const r = run({ ...f, env }, 'preventivo', '4', '--tetto', '5000');
    expect(r.code).toBe(1);
    expect(r.out).toContain('OLTRE IL TETTO');
    expect(r.out).toContain('2 per giro × 2 giri');
  });

  it('counts tool calls per delegation, the predictor that token totals hide', () => {
    // Il costo vero non è il numero di worker ma le chiamate per worker: ogni
    // chiamata rilegge il contesto accumulato. Due campioni con gli stessi token
    // e chiamate diverse non costano uguale, e il preventivo deve dirlo.
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 6, 2000, { chiamate: 7 }) };

    const r = run({ ...f, env }, 'preventivo', '4');
    expect(r.code).toBe(0);
    expect(r.out).toContain('p50 7 · p80 7 tool call per delega');
    expect(r.out).toContain('banda osservata, non previsione');
  });

  it('separates judges from workers by declared slug, and declares the rest unclassified', () => {
    // Il segnale è l'intenzione scritta al momento della registrazione, non una
    // firma comportamentale dedotta dopo. Le deleghe che non seguono la
    // convenzione restano «non classificate»: attribuirle a una popolazione
    // sarebbe indovinare, ed è la differenza fra una banda e un numero inventato.
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 6, 2000) };
    writeFileSync(
      join(f.repo, '.claude', 'deleghe', 'registro.jsonl'),
      [
        { id: '0', slug: 'judge-70' },
        { id: '1', slug: 'judge-71' },
        { id: '2', slug: 'slice-taint' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const tutte = run({ ...f, env }, 'preventivo', '4');
    expect(tutte.code).toBe(0);
    expect(tutte.out).toContain('2 judge · 1 worker · 3 non classificate');

    // Due judge soli non fanno un campione, e il comando lo dice invece di
    // stampare un p80 costruito su due misure.
    const soloJudge = run({ ...f, env }, 'preventivo', '4', '--tipo', 'judge');
    expect(soloJudge.code).toBe(1);
    expect(soloJudge.out).toContain('campione insufficiente');
    expect(soloJudge.out).toContain('tipo judge');
  });

  it('says to do a single small task directly instead of delegating it', () => {
    const f = fixture();
    const env = { ...f.env, ...transcripts(f.repo, 6, 2000) };

    const r = run({ ...f, env }, 'preventivo', '1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Delegare non è il default');
  });
});

describe('delegation handoff without GitHub', () => {
  it('keeps locally integrated work closed and uncertain work non-actionable', () => {
    const f = fixture();
    const output = execFileSync(process.execPath, [join(f.repo, '.claude', 'deleghe.mjs'), 'riprendi'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });

    expect(output).toContain('GitHub non disponibile');
    expect(output).toContain('CHIUSE (1)');
    expect(output).toContain('documenti');
    expect(output).toContain('ancestry Git locale');
    expect(output).toContain('APERTE (0)');
    expect(output).toContain('SCONOSCIUTE (1)');
    expect(output).toContain('aperta');
    expect(output).toContain('non riprendere senza verifica');
  });

  it('a hand closure keeps a branchless delegation out of the resumable set', () => {
    // A read-only extraction or an agent that died before producing anything
    // has no branch, so nothing can ever derive "closed" for it: without the
    // `chiudi` row it stays "APERTE — riprendibili" forever, and a fresh session
    // would resume it. Eight such rows sat in the register on one day.
    const f = fixture();
    const script = join(f.repo, '.claude', 'deleghe.mjs');
    execFileSync(process.execPath, [script, 'registra', 'estrazione', 'mappa-tools', 'estrazione read-only'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });
    const prima = execFileSync(process.execPath, [script, 'riprendi'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    // Without GitHub a branchless row is "unknown", never resumable — but it is
    // still not closed, which is the state this verb exists to record.
    expect(prima).toContain('SCONOSCIUTE (2)');
    expect(prima).toContain('CHIUSE (1)');

    execFileSync(process.execPath, [script, 'chiudi', 'estrazione', 'digest letto, niente da riprendere'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });
    const dopo = execFileSync(process.execPath, [script, 'riprendi'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    expect(dopo).toContain('CHIUSE (2)');
    expect(dopo).toContain('chiusa: digest letto, niente da riprendere');
    expect(dopo).toContain('SCONOSCIUTE (1)');
    expect(dopo).not.toMatch(/SCONOSCIUTE[\s\S]*mappa-tools/);
  });
});
