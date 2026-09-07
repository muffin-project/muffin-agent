import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Il guard che impedisce a un ripristino di cancellare lavoro non committato.
 *
 * La decisione che prende dipende dallo **stato del repository**, non solo dal
 * testo del comando: lo stesso `git checkout -- file` è distruttivo se il file
 * ha modifiche e innocuo se non ne ha. Quindi ogni caso gira contro un
 * repository vero, con o senza modifiche, che è l'unico modo di esercitare la
 * scelta che fa davvero.
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-restore-discard.mjs');

let repo: string;

/** Esegue l'hook nel repo, come farebbe Claude Code: comando su stdin, JSON. */
function esegui(command: string, env: Record<string, string> = {}): { code: number; err: string } {
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    return { code: 0, err: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? -1, err: err.stderr?.toString() ?? '' };
  }
}

beforeAll(() => {
  repo = execFileSync('mktemp', ['-d']).toString().trim();
  const git = (...a: string[]): void => {
    execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  };
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'sporco.ts'), 'committato\n');
  writeFileSync(join(repo, 'pulito.ts'), 'committato\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  // Solo uno dei due ha modifiche da perdere: è la differenza che il guard deve vedere.
  writeFileSync(join(repo, 'sporco.ts'), 'riparazione non committata\n');
});

describe('guard-restore-discard', () => {
  it('rifiuta `git checkout --` su un file con modifiche non committate', () => {
    const r = esegui('git checkout -- sporco.ts');
    expect(r.code).toBe(2);
    expect(r.err).toContain('sporco.ts');
    // Il messaggio deve insegnare la forma sicura, non solo vietare: è il solo
    // momento in cui quella conoscenza arriva in tempo.
    expect(r.err).toContain('cp ');
  });

  it('rifiuta anche `git restore`, che è lo stesso danno con un altro nome', () => {
    expect(esegui('git restore sporco.ts').code).toBe(2);
  });

  it('lascia passare un file che non ha niente da perdere', () => {
    expect(esegui('git checkout -- pulito.ts').code).toBe(0);
  });

  it('lascia passare un ripristino che nomina la sorgente — è come si recupera', () => {
    // `git checkout <ref> -- <file>` non può sorprendere: la sorgente è
    // dichiarata. Ed è esattamente il comando con cui si esce da questo errore.
    expect(esegui('git checkout stash@{0} -- sporco.ts').code).toBe(0);
    expect(esegui('git restore --source=HEAD~1 sporco.ts').code).toBe(0);
    // `--staged` tocca l'indice, non il file nel working tree.
    expect(esegui('git restore --staged sporco.ts').code).toBe(0);
  });

  it('non si lascia disarmare da un messaggio che nomina il comando', () => {
    // In un repository i cui messaggi di commit parlano di pratica git, questa
    // è la frase più probabile che qualcuno scriverà — e non deve spegnere il
    // guard che la descrive. Stesso difetto trovato una volta in
    // `guard-review-branch`, qui prevenuto invece che scoperto.
    const r = esegui('git commit -m "mai usare git checkout -- sporco.ts"');
    expect(r.code).toBe(0);
  });

  it('vede il comando pericoloso anche in fondo a una catena', () => {
    // La forma in cui il difetto è successo davvero: il ripristino non era il
    // comando, era l'ultimo anello di una catena che eseguiva i test.
    const r = esegui('npx vitest run x.test.ts && git checkout -- sporco.ts');
    expect(r.code).toBe(2);
  });

  it('cede all override esplicito, che resta visibile nel transcript', () => {
    expect(esegui('MUFFIN_DISCARD_OK=1 git checkout -- sporco.ts').code).toBe(0);
  });

  /**
   * `git reset --hard` — la terza volta, il 07/09/2026, e in una forma che le
   * prime due non coprivano: non un mutation test, ma un riallineamento del
   * worktree a `origin/dev` a fetta gia' integrata. Nel working tree c'era una
   * riga non committata del registro delle deleghe, e il reset l'ha presa in
   * silenzio.
   */
  describe('git reset --hard', () => {
    it('rifiuta un reset che butterebbe via il working tree', () => {
      const r = esegui('git reset --hard origin/dev');
      expect(r.code).toBe(2);
      expect(r.err).toContain('sporco.ts');
      // Il messaggio deve nominare la forma che sposta HEAD senza toccare i file.
      expect(r.err).toContain('--mixed');
    });

    it('vede anche il reset senza ref e in fondo a una catena', () => {
      expect(esegui('git reset --hard').code).toBe(2);
      expect(esegui('git fetch origin && git reset --hard origin/dev').code).toBe(2);
    });

    it('prende anche cio che e solo in stage, che `git diff` da solo non vedrebbe', () => {
      // `--hard` scarta l'indice quanto il working tree: un file aggiunto con
      // `git add` e mai committato sparisce, e un confronto con l'indice
      // direbbe «niente da perdere».
      execFileSync('git', ['-C', repo, 'add', 'sporco.ts'], { stdio: 'pipe' });
      try {
        expect(esegui('git reset --hard').code).toBe(2);
      } finally {
        execFileSync('git', ['-C', repo, 'reset', '-q'], { stdio: 'pipe' });
      }
    });

    it('lascia passare --soft e --mixed, che i file non li toccano', () => {
      expect(esegui('git reset --soft HEAD~1').code).toBe(0);
      expect(esegui('git reset --mixed HEAD~1').code).toBe(0);
      expect(esegui('git reset HEAD~1').code).toBe(0);
    });

    it('lascia passare un reset su un albero che non ha niente da perdere', () => {
      const pulito = execFileSync('mktemp', ['-d']).toString().trim();
      const git = (...a: string[]): void => {
        execFileSync('git', ['-C', pulito, ...a], { stdio: 'pipe' });
      };
      git('init', '-q');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(pulito, 'a.ts'), 'x\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const r = execFileSync('node', [HOOK], {
        input: JSON.stringify({ tool_input: { command: 'git reset --hard HEAD' } }),
        cwd: pulito,
        stdio: 'pipe',
      });
      expect(String(r)).toBe('');
    });

    it('non si lascia disarmare da un messaggio che nomina il comando', () => {
      expect(esegui('git commit -m "mai usare git reset --hard qui"').code).toBe(0);
    });
  });

  /**
   * Il corpo di un heredoc è dato quanto una stringa fra virgolette, e questo
   * caso non è ipotetico: è successo nell'ora in cui il ramo `reset` è stato
   * scritto. Scrivere la **documentazione** di questo guard — un file di
   * memoria il cui testo spiega perché quel comando è pericoloso — lo faceva
   * scattare su sé stesso, mentre git non toccava niente.
   */
  describe('un heredoc è dato, non sintassi', () => {
    it('un documento che nomina i comandi non arma il guard', () => {
      const doc = [
        "cat > nota.md <<'EOF'",
        'Non ripristinare con git checkout -- sporco.ts.',
        'E prima di git reset --hard, guarda git status.',
        'EOF',
      ].join('\n');
      expect(esegui(doc).code).toBe(0);
    });

    it('ma un comando vero DOPO un heredoc resta visto', () => {
      // Il rischio dell'aggiunta sopra: neutralizzare troppo. Il marcatore
      // chiude, e ciò che viene dopo è di nuovo sintassi.
      const doc = ["cat > nota.md <<'EOF'", 'prosa qualunque', 'EOF', 'git reset --hard'].join('\n');
      expect(esegui(doc).code).toBe(2);
    });
  });
});
