import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdAdopt } from './adopt.js';
import { diagnoseDefaultsDrift, readDefaultsRegistry, recordCopied } from '../core/config/defaults-drift.js';

/**
 * Repository Git veri, come `core/config/defaults-drift.test.ts` e per la
 * stessa ragione: la diagnosi che questo comando *esegue* è quella, e un finto
 * `git log` proverebbe solo che il comando si fida del proprio mock.
 */
function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} in ${cwd} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeCheckout(): string {
  const dir = tmp('muffin-adopt-checkout-');
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

function commit(dir: string, relPath: string, content: string, message: string): void {
  writeFileSync(join(dir, 'defaults', relPath), content);
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-qm', message], dir);
}

/**
 * Un'installazione come la fa `muffin init`: i file copiati, e il registro che
 * dice quale contenuto è stato copiato.
 */
function makeHome(): string {
  const h = tmp('muffin-adopt-home-');
  mkdirSync(join(h, 'rot'), { recursive: true });
  writeFileSync(join(h, 'persona.md'), 'v1\n');
  writeFileSync(join(h, 'voice.md'), 'v1 voice\n');
  writeFileSync(join(h, 'rot', 'identity.md'), 'v1 identity\n');
  recordCopied(h, [
    { path: 'persona.md', content: Buffer.from('v1\n') },
    { path: 'voice.md', content: Buffer.from('v1 voice\n') },
    { path: 'rot/identity.md', content: Buffer.from('v1 identity\n') },
  ]);
  return h;
}

function run(home: string, checkoutRoot: string | null, argv: string[]): { code: number; out: string } {
  const righe: string[] = [];
  const code = cmdAdopt(home, argv, { out: (l) => righe.push(l), checkoutRoot });
  return { code, out: righe.join('\n') };
}

describe('muffin adopt — senza argomenti guarda e basta', () => {
  /**
   * La lista di cosa cambierebbe serve **prima** di decidere. Un comando che
   * adotta tutto appena lo digiti non la lascia leggere a nessuno.
   */
  it('elenca cosa e adottabile e non tocca un byte', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');

    const r = run(h, checkout, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('persona.md');
    expect(r.out).toContain('muffin adopt --tutto');
    // Il file installato e' ancora quello di prima.
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('v1\n');
  });

  it("quando non c'e' niente da fare lo dice, invece di stampare una lista muta", () => {
    const r = run(makeHome(), makeCheckout(), []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Niente da adottare');
  });
});

describe('muffin adopt — adotta, e registra', () => {
  it('copia il file spedito su quello installato', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');

    const r = run(h, checkout, ['persona.md']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('v2\n');
    // Non ha toccato quello che non era stato nominato.
    expect(readFileSync(join(h, 'voice.md'), 'utf8')).toBe('v1 voice\n');
  });

  /**
   * **Il difetto che il `cp` a mano ha e questo comando non deve avere.**
   *
   * `recordCopied` registra l'hash di cio' che e' stato copiato: e' la regola 1
   * di `defaults-drift.ts`, quella che non ha bisogno di Git. Un `cp`
   * incollato non la aggiorna, quindi al giro dopo — HEAD si muove ancora —
   * l'installato non corrisponde ne' a HEAD ne' all'hash registrato, e la
   * diagnosi risponde `owner-modified`: «modificato dall'owner, non toccato».
   * Da li' in poi quel file non e' piu' adottabile e non lo sara' mai piu'.
   *
   * Il test guarda il secondo giro, perche' e' li' che il difetto si vede: al
   * primo, `cp` e `adopt` sembrano identici.
   */
  it('e al giro dopo il file e ancora adottabile, non "modificato da te"', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    expect(run(h, checkout, ['persona.md']).code).toBe(0);

    expect(readDefaultsRegistry(h)?.files.find((f) => f.path === 'persona.md')).toBeDefined();

    // HEAD si muove di nuovo.
    commit(checkout, 'persona.md', 'v3\n', 'persona v3');
    const d = diagnoseDefaultsDrift(h, checkout).find((x) => x.path === 'persona.md');
    expect(d?.status).toBe('adoptable');

    // E infatti si puo' adottare una seconda volta.
    expect(run(h, checkout, ['persona.md']).code).toBe(0);
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('v3\n');
  });

  it('--tutto prende ogni file adottabile fuori dal sigillo', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    commit(checkout, 'voice.md', 'v2 voice\n', 'voice v2');

    const r = run(h, checkout, ['--tutto']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(h, 'voice.md'), 'utf8')).toBe('v2 voice\n');
  });
});

describe('muffin adopt — cosa si rifiuta di fare', () => {
  /**
   * La proprieta' che conta di piu' di tutte: un file che l'owner ha scritto
   * non viene sovrascritto. La diagnosi lo classifica `owner-modified`, e
   * questo comando non ha una scorciatoia per ignorarla.
   */
  it('non sovrascrive mai un file che hai modificato tu', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    writeFileSync(join(h, 'persona.md'), 'la mia versione, scritta a mano\n');

    const r = run(h, checkout, ['persona.md']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('non adottabile');
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('la mia versione, scritta a mano\n');
  });

  it('e --tutto non lo prende comunque per la strada', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'persona.md', 'v2\n', 'persona v2');
    writeFileSync(join(h, 'persona.md'), 'la mia versione\n');

    run(h, checkout, ['--tutto']);
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('la mia versione\n');
  });

  /**
   * Adottare dentro `rot/` fa divergere l'hash sigillato e manda
   * l'installazione in safe mode finche' non gira `muffin rot reseal` — un
   * atto dell'autorita' dell'owner (ADR-0003). La porta sul sigillo resta una
   * sola, e non e' questa.
   */
  it('non scrive mai dentro il sigillo, nemmeno se lo nomini', () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'rot/identity.md', 'v2 identity\n', 'identity v2');

    const r = run(h, checkout, ['rot/identity.md']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('safe mode');
    expect(r.out).toContain('muffin rot reseal');
    expect(readFileSync(join(h, 'rot', 'identity.md'), 'utf8')).toBe('v1 identity\n');
  });

  it("e `--tutto` non lo tira dentro: lo nomina e lo lascia stare", () => {
    const checkout = makeCheckout();
    const h = makeHome();
    commit(checkout, 'rot/identity.md', 'v2 identity\n', 'identity v2');

    const r = run(h, checkout, ['--tutto']);
    expect(readFileSync(join(h, 'rot', 'identity.md'), 'utf8')).toBe('v1 identity\n');
    expect(r.out).toContain('rot/identity.md');
    expect(r.out).toContain('rot reseal');
  });

  it('un file che non esiste in defaults/ e un errore, non un silenzio', () => {
    const r = run(makeHome(), makeCheckout(), ['inventato.md']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('inventato.md');
  });

  /**
   * Senza checkout la diagnosi cade sul registro e risponde `unknown`: non sa
   * se HEAD sia andato avanti. Un comando che copiasse comunque non avrebbe
   * niente da cui copiare — e infatti si ferma dicendolo (ADR-0008: degrado
   * dichiarato, mai in silenzio).
   */
  it('senza un checkout leggibile non inventa una sorgente', () => {
    const h = makeHome();
    const r = run(h, null, ['--tutto']);
    expect(readFileSync(join(h, 'persona.md'), 'utf8')).toBe('v1\n');
    expect(r.out).toContain('Niente da adottare');
  });
});
