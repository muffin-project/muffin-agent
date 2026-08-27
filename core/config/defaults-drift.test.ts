import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from './config.js';
import { sha256 } from '../rot/verify.js';
import { diagnoseDefaultsDrift, isShippedDefault, readDefaultsRegistry, recordCopied, type Git } from './defaults-drift.js';

/**
 * The property that matters most (the task brief's own words): a file the
 * owner edited must never come back as `'adoptable'` — that verdict proposes
 * overwriting it, and a false positive there destroys real work. Every
 * "owner-modified" test below exists to keep that property true across both
 * paths that can reach it (the init-time registry, and the Git-history
 * fallback for an installation that predates the registry).
 *
 * Real temp Git repositories throughout — same call as `cli/update.test.ts`
 * makes for the same reason ("cheap, and it is exactly the part worth not
 * mocking"): a fake `git log`/`git show` pair would only prove this module
 * trusts its own mock, never that the real command syntax works. Only one
 * test (git itself unreadable) injects a fake `Git`, because that is the one
 * branch a real repository cannot be made to hit.
 */

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} in ${cwd} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A checkout with one commit: `defaults/persona.md` = "v1\n", `defaults/voice.md` = "v1 voice\n", `defaults/rot/identity.md` = "v1 identity\n". */
function makeCheckout(): string {
  const dir = tmp('muffin-drift-checkout-');
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 't@t'], dir);
  sh('git', ['config', 'user.name', 't'], dir);
  mkdirSync(join(dir, 'defaults', 'rot'), { recursive: true });
  writeFileSync(join(dir, 'defaults', 'persona.md'), 'v1\n');
  writeFileSync(join(dir, 'defaults', 'voice.md'), 'v1 voice\n');
  writeFileSync(join(dir, 'defaults', 'rot', 'identity.md'), 'v1 identity\n');
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-qm', 'v1'], dir);
  return dir;
}

function commit(dir: string, relPath: string, content: string, message: string): string {
  writeFileSync(join(dir, 'defaults', relPath), content);
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-qm', message], dir);
  return sh('git', ['rev-parse', 'HEAD'], dir).trim();
}

function home(): string {
  return tmp('muffin-drift-home-');
}

function findPersona(drift: ReturnType<typeof diagnoseDefaultsDrift>) {
  return drift.find((d) => d.path === 'persona.md');
}

describe('diagnoseDefaultsDrift — up to date', () => {
  it('reports up-to-date when the installed copy matches what HEAD ships', () => {
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('up-to-date');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('diagnoseDefaultsDrift — adoptable (rule 1: the registry recorded at copy time)', () => {
  it('is adoptable when the installed hash equals the registered one and HEAD has moved on', () => {
    const checkout = makeCheckout();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);

    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('adoptable');
    expect(d?.adoptCommand).toBe(`cp ${join(checkout, 'defaults', 'persona.md')} ${join(h, 'persona.md')}`);
    expect(d?.detail).toContain('registrato');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('never proposes adoption for a sealed rot/ file without naming the safe-mode consequence to the caller — sealed flag is true', () => {
    const checkout = makeCheckout();
    commit(checkout, 'rot/identity.md', 'v2 identity\n', 'identity v2');
    const h = home();
    mkdirSync(join(h, 'rot'), { recursive: true });
    writeFileSync(join(h, 'rot', 'identity.md'), 'v1 identity\n');
    recordCopied(h, [{ path: 'rot/identity.md', content: Buffer.from('v1 identity\n') }]);

    const d = diagnoseDefaultsDrift(h, checkout).find((x) => x.path === 'rot/identity.md');
    expect(d?.status).toBe('adoptable');
    expect(d?.sealed).toBe(true);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('diagnoseDefaultsDrift — owner-modified must never read as adoptable', () => {
  it('rule 1: registry hash present but does not match the installed file — owner-modified, no adoptCommand implied as safe', () => {
    const checkout = makeCheckout();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'la mia versione, scritta a mano\n');
    // Registry still says the file was copied as "v1\n" — the owner edited
    // it afterwards without ever running `muffin init` again.
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);

    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('owner-modified');
    expect(d?.adoptCommand).toBeUndefined();
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('rule 2: no registry at all, and the content matches no version ever shipped — owner-modified', () => {
    const checkout = makeCheckout();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    commit(checkout, 'persona.md', 'v3\n', 'persona v3');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'testo mai spedito, scritto dall\'owner\n');
    // No recordCopied at all: this simulates an installation that predates
    // the registry — the owner's own machine in the research doc.

    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('owner-modified');
    expect(d?.adoptCommand).toBeUndefined();
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('rule 2, the exact shape measured in the research doc: an old shipped commit, no registry — adoptable, with the matched commit named', () => {
    const checkout = makeCheckout();
    const v2sha = commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    commit(checkout, 'persona.md', 'v3\n', 'persona v3');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v2\n'); // matches the v2 commit, not HEAD (v3)

    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('adoptable');
    expect(d?.detail).toContain(v2sha.slice(0, 7));
    expect(d?.adoptCommand).toBe(`cp ${join(checkout, 'defaults', 'persona.md')} ${join(h, 'persona.md')}`);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('diagnoseDefaultsDrift — missing files', () => {
  it('reports missing when the installed copy does not exist at all', () => {
    const checkout = makeCheckout();
    const h = home(); // never wrote persona.md into this home
    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('missing');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('diagnoseDefaultsDrift — declared unknown (ADR-0008), never a silent guess', () => {
  it('returns nothing tracked when there is neither a registry nor a checkout to compare against', () => {
    const h = home();
    expect(diagnoseDefaultsDrift(h, null)).toEqual([]);
    rmSync(h, { recursive: true, force: true });
  });

  it('with a registry but no checkout: unchanged-since-copy is known, but "is it stale" is honestly unknown rather than assumed adoptable', () => {
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);

    const d = findPersona(diagnoseDefaultsDrift(h, null));
    expect(d?.status).toBe('unknown');
    expect(d?.adoptCommand).toBeUndefined();
    rmSync(h, { recursive: true, force: true });
  });

  it('with a checkout but a broken `git log`: unknown, not misread as owner-modified', () => {
    const checkout = makeCheckout();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n'); // really is an old shipped version

    const brokenGit: Git = {
      isShallow: () => false,
      log: () => ({ ok: false, why: 'git log fallito (simulato)' }),
      show: () => null,
    };
    const d = findPersona(diagnoseDefaultsDrift(h, checkout, brokenGit));
    expect(d?.status).toBe('unknown');
    expect(d?.detail).toContain('non è leggibile');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('diagnoseDefaultsDrift — discovery and sealed flag', () => {
  it('discovers files recursively under defaults/rot/ and marks only those sealed', () => {
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
    mkdirSync(join(h, 'rot'), { recursive: true });
    writeFileSync(join(h, 'rot', 'identity.md'), 'v1 identity\n');

    const drift = diagnoseDefaultsDrift(h, checkout);
    const byPath = new Map(drift.map((d) => [d.path, d]));
    expect(byPath.get('persona.md')?.sealed).toBe(false);
    expect(byPath.get('voice.md')?.sealed).toBe(false);
    expect(byPath.get('rot/identity.md')?.sealed).toBe(true);
    expect([...byPath.keys()].sort()).toEqual(['persona.md', 'rot/identity.md', 'voice.md']);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

describe('recordCopied / readDefaultsRegistry', () => {
  it('records the hash of the content actually passed in, readable back', () => {
    const h = home();
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);
    const reg = readDefaultsRegistry(h);
    expect(reg?.schemaVersion).toBe(1);
    expect(reg?.files).toEqual([{ path: 'persona.md', sha256: sha256(Buffer.from('v1\n')) }]);
    expect(typeof reg?.installedAt).toBe('string');
    rmSync(h, { recursive: true, force: true });
  });

  it('merges across calls instead of overwriting siblings', () => {
    const h = home();
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);
    recordCopied(h, [{ path: 'voice.md', content: Buffer.from('v1 voice\n') }]);
    const reg = readDefaultsRegistry(h);
    expect((reg?.files ?? []).map((f) => f.path).sort()).toEqual(['persona.md', 'voice.md']);
    rmSync(h, { recursive: true, force: true });
  });

  it('overwrites only the path it is given, on a later re-copy (e.g. `muffin init --force`)', () => {
    const h = home();
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v2\n') }]);
    const reg = readDefaultsRegistry(h);
    expect(reg?.files).toEqual([{ path: 'persona.md', sha256: sha256(Buffer.from('v2\n')) }]);
    rmSync(h, { recursive: true, force: true });
  });

  it('is a true no-op on an empty list — never creates the file for a resumed `init` that copied nothing', () => {
    const h = home();
    recordCopied(h, []);
    expect(existsSync(paths(h).defaultsManifest)).toBe(false);
    expect(readDefaultsRegistry(h)).toBeNull();
    rmSync(h, { recursive: true, force: true });
  });

  it('readDefaultsRegistry degrades to null, not a throw, on a missing or malformed file', () => {
    const h = home();
    expect(readDefaultsRegistry(h)).toBeNull();
    mkdirSync(h, { recursive: true });
    writeFileSync(paths(h).defaultsManifest, 'not json at all');
    expect(readDefaultsRegistry(h)).toBeNull();
    writeFileSync(paths(h).defaultsManifest, JSON.stringify({ schemaVersion: 99, files: [] }));
    expect(readDefaultsRegistry(h)).toBeNull();
    rmSync(h, { recursive: true, force: true });
  });
});

describe('the installed-file bytes are hashed exactly as git stores them', () => {
  // A regression guard for the one subtle way this could silently break: if
  // `Git.show` ever decoded its subprocess output as text instead of raw
  // bytes, a file whose committed bytes are not valid UTF-8 would hash
  // differently than the identical bytes read straight off disk, and every
  // binary-ish default would permanently read as "owner-modified".
  it('matches content containing bytes that are not valid UTF-8', () => {
    const checkout = makeCheckout();
    const weird = Buffer.from([0x76, 0x31, 0xff, 0xfe, 0x0a]); // "v1" + invalid UTF-8 + newline
    writeFileSync(join(checkout, 'defaults', 'persona.md'), weird);
    sh('git', ['add', '.'], checkout);
    sh('git', ['commit', '-qm', 'binary-ish persona'], checkout);

    const h = home();
    writeFileSync(join(h, 'persona.md'), weird);
    const d = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(d?.status).toBe('up-to-date');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

/**
 * I tre modi in cui la diagnosi poteva **buttare giù tutto il rapporto**
 * invece di costare la propria riga. Trovati dal judge su #142, che li ha
 * fatti crashare davvero prima che qualcuno li scrivesse.
 */
describe('un incidente su un file costa una riga, non il rapporto', () => {
  it('un file installato illeggibile diventa una riga dichiarata, e gli altri restano diagnosticati', () => {
    // Prima: `readFileSync` lanciava EACCES fin fuori da `runDoctor`, e ogni
    // check in coda — budget, database, schema, gateway, sandbox, tracce — non
    // girava affatto. L'owner riceveva uno stack trace proprio quando la
    // macchina era già nello stato che gli aveva fatto lanciare `doctor`.
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
    chmodSync(join(h, 'persona.md'), 0o000);
    try {
      const all = diagnoseDefaultsDrift(h, checkout);
      expect(findPersona(all)?.status).toBe('unknown');
      expect(findPersona(all)?.detail).toContain('non ho potuto leggerla');
      // La prova che conta: la diagnosi degli **altri** file è sopravvissuta.
      expect(all.find((d) => d.path === 'voice.md')?.status).toBe('up-to-date');
    } finally {
      chmodSync(join(h, 'persona.md'), 0o600);
      rmSync(checkout, { recursive: true, force: true });
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('una voce malformata è scartata, non fatale — e le altre restano', () => {
    // JSON valido, schema giusto, `files` è un array — ma una voce è `null`.
    // La guardia originale controllava solo l array e lasciava arrivare `null`
    // fino a `.find()`, tre funzioni più in là, su `null.path`.
    const h = home();
    writeFileSync(
      paths(h).defaultsManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        installedAt: '2026-08-01T00:00:00Z',
        files: [null, { path: 'voice.md', sha256: 'abc' }],
      })}\n`,
    );
    // Filtrato, non rifiutato: la voce buona sopravvive alla voce rotta.
    expect(readDefaultsRegistry(h)?.files).toEqual([{ path: 'voice.md', sha256: 'abc' }]);

    const checkout = makeCheckout();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    expect(findPersona(diagnoseDefaultsDrift(h, checkout))?.status).toBe('up-to-date');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('una voce corrotta NON trascina gli altri file sulla regola 2 — il raggio di scoppio è una voce', () => {
    // Il difetto che la prima riparazione ha *introdotto*, trovato dal judge
    // fresco: azzerare l'intero registro per una voce rotta spinge ogni altro
    // file dalla regola 1 — hash esatto registrato alla copia, deterministica
    // — giù sulla regola 2, che cerca nella storia e porta il limite noto per
    // cui un contenuto uguale a un vecchio commit si legge come adottabile.
    //
    // Lo scenario è quello dell'owner che ha **deliberatamente ripristinato**
    // un testo vecchio: con il registro sano è `owner-modified` e non gli si
    // propone niente. Senza, diventa `adoptable` con un `cp` pronto che
    // cancella la sua scelta — per colpa di una voce che non lo riguarda.
    const checkout = makeCheckout();
    const oldSha = commit(checkout, 'persona.md', 'TESTO_VECCHIO\n', 'persona vecchia');
    commit(checkout, 'persona.md', 'TESTO_NUOVO\n', 'persona nuova');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'TESTO_VECCHIO\n'); // ripristino voluto
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('TESTO_DI_INIT\n') }]);

    // Con il registro integro: la regola 1 decide, e decide bene.
    expect(findPersona(diagnoseDefaultsDrift(h, checkout))?.status).toBe('owner-modified');

    // Ora si corrompe una voce che non c'entra niente con persona.md.
    const registry = JSON.parse(readFileSync(paths(h).defaultsManifest, 'utf8')) as { files: unknown[] };
    registry.files.push({ path: 'un-altro-file.md' }); // manca `sha256`
    writeFileSync(paths(h).defaultsManifest, `${JSON.stringify(registry)}\n`);

    const after = findPersona(diagnoseDefaultsDrift(h, checkout));
    expect(after?.status).toBe('owner-modified');
    expect(after?.adoptCommand).toBeUndefined();
    expect(after?.detail).not.toContain(oldSha.slice(0, 7));
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('una directory `defaults/` illeggibile costa il rapporto? no: ripiega su ciò che il registro sa — e lo dice', () => {
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);
    chmodSync(join(checkout, 'defaults'), 0o000);
    try {
      const all = diagnoseDefaultsDrift(h, checkout);
      // Non lancia, e i percorsi che il registro conosce restano diagnosticati.
      expect(all.map((d) => d.path)).toContain('persona.md');
      // Ma il ripiego non è gratis: la lista è più corta di quella vera, e una
      // lista più corta di righe sicure di sé è esattamente il modo in cui
      // questo modulo mentiva prima di esistere. Quindi lo dichiara.
      const declared = all.find((d) => d.path === 'defaults/');
      expect(declared?.status).toBe('unknown');
      expect(declared?.detail).toContain('registro');
    } finally {
      chmodSync(join(checkout, 'defaults'), 0o755);
      rmSync(checkout, { recursive: true, force: true });
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('una **sottodirectory** illeggibile costa quella sottodirectory, non i fratelli già trovati', () => {
    // Il terzo giro di review, la terza volta con la stessa forma: un guasto
    // locale cancellava più stato di quanto il guasto giustificasse. Qui il
    // walk lanciava, la rete un livello sopra prendeva tutto, e sei file
    // diventavano uno — i cinque spariti erano perfettamente leggibili.
    const checkout = makeCheckout();
    mkdirSync(join(checkout, 'defaults', 'sub'), { recursive: true });
    writeFileSync(join(checkout, 'defaults', 'sub', 'e.md'), 'e\n');
    writeFileSync(join(checkout, 'defaults', 'rot', 'identity.md'), 'id\n');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
    chmodSync(join(checkout, 'defaults', 'sub'), 0o000);
    try {
      const all = diagnoseDefaultsDrift(h, checkout);
      const paths = all.map((d) => d.path);
      // I fratelli fuori dal sottoalbero rotto — inclusi quelli *già trovati*
      // prima di incontrarlo, e quelli sotto un'altra sottodirectory.
      expect(paths).toContain('persona.md');
      expect(paths).toContain('voice.md');
      expect(paths).toContain('rot/identity.md');
      // E il buco è visibile, al suo posto, invece di essere un'assenza.
      const hole = all.find((d) => d.path === 'sub/');
      expect(hole?.status).toBe('unknown');
      expect(hole?.detail).toContain('non ho potuto elencarla');
    } finally {
      chmodSync(join(checkout, 'defaults', 'sub'), 0o755);
      rmSync(checkout, { recursive: true, force: true });
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('un symlink penzolante sotto defaults/ è una riga, non la fine del walk', () => {
    // Il trigger che non chiede nessun permesso ostile: `statSync` segue i
    // symlink, quindi uno rotto lancia durante l'elenco. Stessa famiglia di
    // un checkout che un deploy sta ancora scrivendo mentre `doctor` legge.
    const checkout = makeCheckout();
    symlinkSync(join(checkout, 'defaults', 'non-esiste.md'), join(checkout, 'defaults', 'penzola.md'));
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
    const all = diagnoseDefaultsDrift(h, checkout);
    expect(all.find((d) => d.path === 'persona.md')?.status).toBe('up-to-date');
    expect(all.find((d) => d.path === 'voice.md')?.status).toBe('up-to-date');
    expect(all.find((d) => d.path === 'penzola.md')?.status).toBe('unknown');
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });

  it('`recordCopied` riscrive il registro senza cancellare le voci che non sa leggere', () => {
    // Leggere oltre una voce incomprensibile è prudenza; cancellarla non è lo
    // stesso atto. Succedeva su un `init` ordinario, senza bisogno di nessuna
    // corruzione propria, senza traccia e senza ritorno — mentre ciò che
    // l'aveva scritta è precisamente la cosa che qualcuno vorrebbe guardare.
    const h = home();
    writeFileSync(
      paths(h).defaultsManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        installedAt: '2026-08-01T00:00:00Z',
        files: [{ path: 'voice.md', sha256: 'abc' }, { path: 'bad.md' }],
      })}\n`,
    );
    recordCopied(h, [{ path: 'persona.md', content: Buffer.from('v1\n') }]);

    const onDisk = JSON.parse(readFileSync(paths(h).defaultsManifest, 'utf8')) as { files: unknown[] };
    expect(onDisk.files).toContainEqual({ path: 'bad.md' });
    // E la voce illeggibile non è diventata leggibile per finta: chi legge
    // continua a scartarla, come prima.
    expect(readDefaultsRegistry(h)?.files.map((f) => f.path).sort()).toEqual(['persona.md', 'voice.md']);
    rmSync(h, { recursive: true, force: true });
  });

  it('un checkout shallow lo dice, invece di cercare in una fetta di storia e chiamarla storia', () => {
    // Misurato dal judge: in un clone `--depth 1`, `git log -- <path>` esce 0
    // e restituisce il solo commit di punta. La regola 2 cercava in una
    // frazione della storia mentre il messaggio parlava della storia intera.
    const checkout = makeCheckout();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    const h = home();
    writeFileSync(join(h, 'persona.md'), 'v1\n'); // è davvero una vecchia versione spedita

    // Il finto `git` risponde **con successo** e trova la corrispondenza:
    // senza la guardia il verdetto sarebbe `adoptable`, cioè un `cp` proposto
    // sulla fede di una ricerca fatta su una fetta di storia. Un finto che
    // lancia proverebbe solo che il `try/catch` per-file funziona — che è una
    // riparazione diversa, e mascherava questa.
    const shallowGit: Git = {
      isShallow: () => true,
      log: (cwd, relPath) => {
        calls.push(relPath);
        return { ok: true, commits: [{ sha: 'aaaaaaaaaaaa', date: '2026-08-01' }] };
      },
      show: () => Buffer.from('v1\n'),
    };
    const calls: string[] = [];
    const d = findPersona(diagnoseDefaultsDrift(h, checkout, shallowGit));
    expect(d?.status).toBe('unknown');
    expect(d?.adoptCommand).toBeUndefined();
    // E non ci prova nemmeno: la storia non viene interrogata affatto.
    expect(calls).toEqual([]);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(h, { recursive: true, force: true });
  });
});

/**
 * La spazzatura del sistema operativo dentro `defaults/` non è un default.
 *
 * Misurato sul checkout dell'owner il 27/08: un `.DS_Store` da 6148 byte in
 * `defaults/`, non tracciato da Git, creato dal Finder mesi prima. `doctor` lo
 * diagnosticava come default mancante e proponeva `muffin init` per
 * «ricrearlo» — una riga permanente che non vuol dire niente, in mezzo a
 * quelle che contano.
 *
 * La porta più pericolosa però è l'altra: `installTree` copia tutto ciò che
 * trova, e uno dei tre alberi che copia è `defaults/rot/`, che è **sigillato**.
 * Il test di `cli/init.test.ts` guarda quella.
 */
describe('defaults/ non spedisce spazzatura', () => {
  it('un .DS_Store nel checkout non diventa un default mancante', () => {
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(checkout, 'defaults', '.DS_Store'), 'binaria del Finder\n');
    writeFileSync(join(h, 'persona.md'), 'v1\n');
    writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
    mkdirSync(join(h, 'rot'), { recursive: true });
    writeFileSync(join(h, 'rot', 'identity.md'), 'v1 identity\n');

    const drift = diagnoseDefaultsDrift(h, checkout);
    expect(drift.find((d) => d.path === '.DS_Store')).toBeUndefined();
    // E non ha ingoiato i file veri insieme a quello.
    expect(drift.find((d) => d.path === 'persona.md')?.status).toBe('up-to-date');
  });

  it('nemmeno dentro una sottocartella, che è il caso del sigillo', () => {
    const checkout = makeCheckout();
    const h = home();
    writeFileSync(join(checkout, 'defaults', 'rot', '.DS_Store'), 'binaria\n');
    const drift = diagnoseDefaultsDrift(h, checkout);
    expect(drift.find((d) => d.path === 'rot/.DS_Store')).toBeUndefined();
  });

  /**
   * Elenco esplicito, non un'euristica sui punti iniziali: `defaults/` ha tutto
   * il diritto di spedire un file che comincia per punto, e una regola larga
   * che ne salta uno vero fallirebbe **in silenzio** — nella direzione
   * peggiore, perché un default che non arriva non lo nota nessuno.
   */
  it('un file che comincia per punto ma è un default vero passa', () => {
    expect(isShippedDefault('.muffinrc')).toBe(true);
    expect(isShippedDefault('rot/policy.json')).toBe(true);
    expect(isShippedDefault('.DS_Store')).toBe(false);
    expect(isShippedDefault('rot/.DS_Store')).toBe(false);
    expect(isShippedDefault('persona.md~')).toBe(false);
    expect(isShippedDefault('.persona.md.swp')).toBe(false);
  });
});
