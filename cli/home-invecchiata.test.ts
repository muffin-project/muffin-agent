import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdAdopt, reconcileDefaults } from './adopt.js';
import { runUpdate } from './update.js';
import { runDoctor } from './doctor.js';
import { paths } from '../core/config/config.js';
import { readDefaultsRegistry } from '../core/config/defaults-drift.js';
import { discoverSkills, skillsPromptSection } from '../core/skills/skills.js';

/**
 * **Una casa creata prima che un default esistesse non lo riceve mai.**
 *
 * Misurato sull'installazione dell'owner il 03/09/2026: spediamo due skill in
 * `defaults/skills/`, `runInit` le installa in una casa nuova, e il suo
 * `defaults-manifest.json` elencava **un** file solo, `persona.md`. Quindi
 * `~/.muffin/skills` non esisteva, `skillsPromptSection` tornava stringa
 * vuota, il modello non sentiva mai la parola «skill» e `skill_read` era un
 * tool senza niente da leggere — mentre ogni test passava, perché una casa di
 * test la crea `runInit` da zero e quindi ha già tutto.
 *
 * La radice non è delle skill: `muffin update` sposta il codice, `runInit`
 * semina una casa nuova, e **nessuno** riconciliava una casa esistente con i
 * default aggiunti dopo la sua nascita. Questi test provano la riconciliazione
 * dal lato che conta: la casa vecchia, non quella appena nata.
 */

function dir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const REPO = process.cwd();

/**
 * Una casa **come quella dell'owner**: nata prima delle skill e prima che il
 * registro sapesse elencarle. Non si simula con una casa vuota — si costruisce
 * una casa vera e le si toglie esattamente ciò che alla sua nascita non
 * esisteva.
 */
function casaVecchia(): string {
  const home = dir('muffin-vecchia-');
  runInit({ home, apiKey: 'sk-non-reale' });
  rmSync(join(home, 'skills'), { recursive: true, force: true });
  const manifest = paths(home).defaultsManifest;
  const reg = JSON.parse(readFileSync(manifest, 'utf8')) as { files: { path: string }[] };
  reg.files = reg.files.filter((f) => f.path === 'persona.md');
  writeFileSync(manifest, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  return home;
}

describe('una casa nata prima di un default lo riceve lo stesso', () => {
  it('`muffin adopt --tutto` installa le skill di serie mancanti, e diventano davvero visibili al modello', () => {
    const home = casaVecchia();
    expect(existsSync(join(home, 'skills'))).toBe(false);

    const righe: string[] = [];
    const code = cmdAdopt(home, ['--tutto'], { out: (l) => void righe.push(l), checkoutRoot: REPO });

    expect(code, righe.join('\n')).toBe(0);
    expect(readdirSync(join(home, 'skills')).sort()).toEqual(readdirSync(join(REPO, 'defaults', 'skills')).sort());

    const scan = discoverSkills(home);
    expect(scan.problems).toEqual([]);
    expect(scan.skills.map((s) => s.name).sort()).toEqual(['collega-telegram', 'studia-un-documento']);
    expect(skillsPromptSection(scan.skills)).not.toBe('');
  });

  it('il registro torna a dire la verità: i file installati ora ci sono dentro', () => {
    const home = casaVecchia();
    reconcileDefaults(home, REPO);
    const paths2 = readDefaultsRegistry(home)?.files.map((f) => f.path) ?? [];
    expect(paths2).toContain('skills/studia-un-documento/SKILL.md');
    expect(paths2).toContain('skills/collega-telegram/SKILL.md');
  });

  it("un default riscritto dall'owner non viene mai sovrascritto, e viene dichiarato divergente", () => {
    const home = casaVecchia();
    const mio = '# la mia persona, non la vostra\n';
    writeFileSync(paths(home).persona, mio, 'utf8');

    const esito = reconcileDefaults(home, REPO);

    expect(readFileSync(paths(home).persona, 'utf8')).toBe(mio);
    expect(esito.divergenti.map((d) => d.path)).toContain('persona.md');
    expect(esito.installati).not.toContain('persona.md');
  });

  it('una casa appena installata non fa lavoro doppio: niente copie, registro immutato', () => {
    const home = dir('muffin-fresca-');
    runInit({ home, apiKey: 'sk-non-reale' });
    const prima = readFileSync(paths(home).defaultsManifest, 'utf8');

    const esito = reconcileDefaults(home, REPO);

    expect(esito.installati).toEqual([]);
    expect(esito.falliti).toEqual([]);
    expect(readFileSync(paths(home).defaultsManifest, 'utf8')).toBe(prima);
  });

  it("`muffin doctor` lo dice da solo, con un rimedio eseguibile", async () => {
    const home = casaVecchia();
    const report = await runDoctor(home, { checkoutRoot: REPO });
    const riga = report.checks.find((c) => c.name === 'default skills/studia-un-documento/SKILL.md');
    expect(riga?.level).toBe('warn');
    expect(riga?.remedy ?? '').toContain('muffin adopt');
  });
});

/**
 * Il punto di produzione. Un meccanismo che esiste e che la produzione non
 * raggiunge è il modo di fallire che questo repository ha già avuto più volte:
 * qui l'aggiornamento vero, con il suo vero `git worktree`, deve portarsi in
 * casa un default che nella release nuova esiste e nella casa no.
 */
describe('`muffin update` riconcilia i default della release nuova', () => {
  function sh(cmd: string, args: string[], cwd: string): void {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  }

  it('installa in una casa esistente un default comparso dopo la sua nascita', () => {
    const remote = dir('muffin-up-remote-');
    sh('git', ['init', '-q', '-b', 'main', '--bare', remote], remote);
    const seed = dir('muffin-up-seed-');
    sh('git', ['init', '-q', '-b', 'main'], seed);
    sh('git', ['config', 'user.email', 't@t'], seed);
    sh('git', ['config', 'user.name', 't'], seed);
    writeFileSync(join(seed, 'version.txt'), 'v1\n');
    sh('git', ['add', '.'], seed);
    sh('git', ['commit', '-qm', 'v1'], seed);
    sh('git', ['remote', 'add', 'origin', remote], seed);
    sh('git', ['push', '-q', '-u', 'origin', 'main'], seed);

    const installed = dir('muffin-up-installed-');
    sh('git', ['clone', '-q', remote, installed], tmpdir());

    // Il default che nasce **dopo** la casa: esattamente la forma del difetto.
    mkdirSync(join(seed, 'defaults', 'skills', 'nuova'), { recursive: true });
    writeFileSync(join(seed, 'defaults', 'skills', 'nuova', 'SKILL.md'), '# nuova\n');
    sh('git', ['add', '.'], seed);
    sh('git', ['commit', '-qm', 'v2'], seed);
    sh('git', ['push', '-q', 'origin', 'main'], seed);

    const entry0 = join(installed, 'dist', 'cli', 'main.js');
    mkdirSync(dirname(entry0), { recursive: true });
    writeFileSync(entry0, '// v1\n');
    const bindir = dir('muffin-up-bindir-');
    symlinkSync(entry0, join(bindir, 'muffin'));

    const home = dir('muffin-up-home-');
    mkdirSync(home, { recursive: true });

    const result = runUpdate({
      moduleDir: installed,
      home,
      bindirs: [bindir],
      npmCi: () => ({ status: 0, stdout: '', stderr: '' }),
      smokeTest: () => ({ status: 0, stdout: '', stderr: '' }),
      readNewSchemaVersion: () => 1,
    });

    expect(result.code, JSON.stringify(result.steps, null, 2)).toBe(0);
    expect(result.steps.map((s) => s.name)).toContain('default');
    expect(readFileSync(join(home, 'skills', 'nuova', 'SKILL.md'), 'utf8')).toBe('# nuova\n');
  });
});
