import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathDenied, fsSearch, makeFsTools, type FsScope } from './fs.js';

/**
 * Cercare senza la shell.
 *
 * Nasce da una misura sul database dell'owner, il 28/08/2026: **19 chiamate su
 * 94 erano `sys.shell`**, e guardando cosa restituivano erano quasi tutte
 * `grep` e `ls -R` — `agent/runtime.ts:32:import …`, `cli/main.ts:106: …`,
 * `README.md:restarts …`. Non era il modello che sceglieva la strada larga:
 * `fs_read` pretende il percorso esatto e `fs_list` fa una directory sola,
 * quindi «dove è nominato X?» aveva una strada sola, ed era l'unica capability
 * che chiede conferma **a ogni chiamata**. L'owner approvava un `grep` dopo
 * l'altro.
 *
 * La proprietà che questi test tengono chiusa non è «trova le cose»: è che
 * questa porta non apra **niente** che `fs_read` non aprisse già. Stesso
 * contenimento, stesso `denyRead`, stesso rifiuto degli symlink che escono.
 * Un tool di ricerca che aggira lo scope sarebbe un modo per leggere tutto il
 * disco senza mai chiedere.
 */

let base: string;
let root: string;
let outside: string;
let scope: FsScope;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'muffin-fs-search-'));
  root = join(base, 'work');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'core', 'memory'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'nota.md'), 'la spesa\nricordami il pane\n');
  writeFileSync(join(root, 'core', 'memory', 'recall.ts'), "import { fence } from './spotlight.js';\nconst pane = 1;\n");
  writeFileSync(join(root, 'core', 'memory', 'store.ts'), 'export const nulla = 0;\n');
  writeFileSync(join(root, 'secrets', 'provider_api_key'), 'sk-VERA-CHIAVE-pane\n');
  writeFileSync(join(outside, 'segreto.txt'), 'pane di fuori\n');
  scope = { root, denyWrite: [join(root, 'secrets')], denyRead: [join(root, 'secrets')] };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('cerca dentro i file', () => {
  it('restituisce percorso, riga e testo — la forma che un grep avrebbe dato', () => {
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).toContain('nota.md:2: ricordami il pane');
    expect(out).toContain('core/memory/recall.ts:2: const pane = 1;');
  });

  it('e non trova niente senza mentire su cosa vuol dire', () => {
    expect(fsSearch(scope, { query: 'qualcosa che non c è' })).toBe('nessun riscontro');
  });

  it('cerca senza badare a maiuscole e minuscole', () => {
    expect(fsSearch(scope, { query: 'PANE' })).toContain('nota.md:2');
  });

  /** `name` restringe i file da aprire; da solo, il percorso *è* la risposta. */
  it('e `name` da solo trova i file di cui non sai dove stiano', () => {
    const out = fsSearch(scope, { name: 'memory' });
    expect(out).toContain('core/memory/recall.ts');
    expect(out).toContain('core/memory/store.ts');
    expect(out).not.toContain('nota.md');
  });

  it('i due insieme cercano dentro i soli file che il nome ammette', () => {
    const out = fsSearch(scope, { query: 'pane', name: 'recall' });
    expect(out).toContain('core/memory/recall.ts:2');
    expect(out).not.toContain('nota.md');
  });

  it('e `path` restringe da dove si parte', () => {
    const out = fsSearch(scope, { query: 'pane', path: 'core' });
    expect(out).toContain('core/memory/recall.ts:2');
    expect(out).not.toContain('nota.md');
  });
});

describe('non apre niente che `fs_read` non aprirebbe', () => {
  /**
   * La riga che rende questo tool sicuro quanto una lettura. `denyRead` copre i
   * segreti, e una ricerca che li attraversasse sarebbe un modo di leggere la
   * chiave del provider senza mai chiamare `fs_read` — cioè senza incontrare
   * nessuno dei controlli che stanno lì.
   */
  it('un segreto sotto `denyRead` non compare, né per contenuto né per nome', () => {
    const perContenuto = fsSearch(scope, { query: 'sk-VERA-CHIAVE' });
    expect(perContenuto).toBe('nessun riscontro');
    expect(fsSearch(scope, { query: 'pane' })).not.toContain('sk-VERA');
    // Nemmeno il *nome* del file: sapere che esiste `provider_api_key` è già
    // metà del lavoro di chi lo cerca.
    expect(fsSearch(scope, { name: 'provider_api_key' })).not.toContain('sk-VERA');
  });

  it("e non esce dallo scope seguendo un symlink", () => {
    symlinkSync(outside, join(root, 'scorciatoia'));
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).not.toContain('di fuori');
    expect(out).not.toContain('scorciatoia');
  });

  it('né accetta un `path` fuori dalla working directory', () => {
    expect(() => fsSearch(scope, { query: 'pane', path: '../outside' })).toThrow(PathDenied);
  });

  /**
   * Un ciclo di symlink faceva girare in tondo qualunque camminata ingenua. Non
   * seguendoli, il ciclo non esiste: questo test è la prova che la scelta di non
   * seguirli vale anche quando è scomoda.
   */
  it('e un anello di symlink non la manda in tondo', () => {
    symlinkSync(root, join(root, 'core', 'su'));
    expect(fsSearch(scope, { query: 'pane' })).toContain('nota.md:2');
  });
});

describe('quello che non guarda, lo dice', () => {
  /**
   * Il difetto peggiore per un tool di ricerca è fermarsi in silenzio: chi
   * legge «nessun riscontro» conclude che la cosa non esiste e va avanti su una
   * falsità. Ogni tetto qui compare nel risultato.
   */
  it('nomina le cartelle che non attraversa', () => {
    mkdirSync(join(root, 'node_modules', 'roba'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'roba', 'x.js'), 'pane\n');
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).not.toContain('node_modules/roba/x.js');
    expect(out).toContain('non attraversate');
    expect(out).toContain('node_modules');
  });

  it('e dice quando si è fermata al tetto invece di far credere che sia tutto', () => {
    mkdirSync(join(root, 'tanti'), { recursive: true });
    for (let i = 0; i < 250; i++) writeFileSync(join(root, 'tanti', `f${String(i)}.txt`), 'pane\n');
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).toContain('fermata al tetto');
    expect(out.split('\n').filter((r) => r.includes(':1: pane')).length).toBeLessThanOrEqual(200);
  });

  it('e conta i file troppo grossi invece di leggerli', () => {
    writeFileSync(join(root, 'enorme.log'), `${'x'.repeat(1024 * 1024 + 10)}\npane\n`);
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).toContain('oltre');
    expect(out).not.toContain('enorme.log');
  });

  it('e salta i binari senza vomitarli nel contesto', () => {
    writeFileSync(join(root, 'immagine.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x70, 0x61, 0x6e, 0x65]));
    expect(fsSearch(scope, { query: 'pane' })).not.toContain('immagine.bin');
  });
});

describe('come si presenta a chi la chiama', () => {
  it('senza né `query` né `name` spiega cosa scegliere, invece di cercare tutto', () => {
    expect(() => fsSearch(scope, {})).toThrow(/query|name/);
  });

  /**
   * È la ragione per cui questo tool esiste: `fs.search` è `low` come le altre
   * due letture, quindi il tetto di taint non la tocca e l'owner non conferma
   * niente. `sys.shell` è `high`, e ogni `grep` gli costava una conferma.
   */
  it('è registrata come lettura, non come esecuzione', () => {
    const tool = makeFsTools(scope).find((t) => t.spec.name === 'fs_search');
    expect(tool?.capability).toBe('fs.search');
    // Stesso tier in uscita di `fs_read`: sono byte del disco, senza provenienza.
    expect(tool?.throwTier).toBe(0);
  });

  /**
   * `throwTier: 0` è una promessa sul *contenuto* dei lanci: nessun byte letto
   * dal disco esce dentro un'eccezione. Un file illeggibile deve quindi essere
   * saltato e contato, mai lanciato con il suo nome dentro.
   */
  it('un percorso illeggibile viene contato, non lanciato', () => {
    const rotto = join(root, 'penzolante.md');
    symlinkSync(join(base, 'mai-esistito'), rotto);
    const out = fsSearch(scope, { query: 'pane' });
    expect(out).toContain('nota.md:2');
    expect(out).not.toContain('penzolante');
  });
});
