import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  decide,
  describeReport,
  forcedCapabilities,
  formatMarked,
  judgeMarked,
  requiredCapabilities,
  tallyMarked,
} from './capabilities.js';
import { withReason } from './requires.js';

type Probes = Record<CapabilityName, { ok: boolean; reason: string }>;
const probes = (over: Partial<Probes> = {}): Probes => ({
  sandbox: { ok: false, reason: 'linux: git_hooks_unprotected — fixture' },
  'shell-boundary': { ok: false, reason: 'richiede sandbox — fixture' },
  'systemd-analyze': { ok: true, reason: 'systemd-analyze verify funziona su questo host' },
  plutil: { ok: false, reason: 'plutil esiste solo su macOS (qui: linux)' },
  ...over,
});

describe('registro delle capacità: richieste', () => {
  it('nessuna variabile: niente è richiesto', () => {
    expect([...requiredCapabilities({})]).toEqual([]);
  });

  it('MUFFIN_REQUIRE_CAPABILITIES è una lista separata da virgole', () => {
    const r = requiredCapabilities({ MUFFIN_REQUIRE_CAPABILITIES: ' sandbox , systemd-analyze ' });
    expect([...r].sort()).toEqual(['sandbox', 'systemd-analyze']);
  });

  it('gli alias storici restano validi', () => {
    expect([...requiredCapabilities({ MUFFIN_REQUIRE_SANDBOX: '1' })].sort()).toEqual([
      'sandbox',
      'shell-boundary',
    ]);
    expect([...requiredCapabilities({ MUFFIN_REQUIRE_SYSTEMD: '1' })]).toEqual(['systemd-analyze']);
  });

  it('un nome sconosciuto è un errore, non una richiesta ignorata', () => {
    expect(() => requiredCapabilities({ MUFFIN_REQUIRE_CAPABILITIES: 'sandbx' })).toThrow(
      /capacità sconosciuta «sandbx»/,
    );
    expect(() => forcedCapabilities({ MUFFIN_FORCE_CAPABILITIES: 'nope' })).toThrow(/nope/);
  });
});

describe('registro delle capacità: decisione', () => {
  it('una capacità assente e non richiesta salta, con il motivo del probe', () => {
    const { report, missingRequired } = decide(probes(), new Set(), new Set());
    expect(report.sandbox).toEqual({
      name: 'sandbox',
      ok: false,
      reason: 'linux: git_hooks_unprotected — fixture',
      required: false,
      forced: false,
    });
    expect(missingRequired).toEqual([]);
  });

  it('una capacità richiesta e assente è elencata: il globalSetup ferma la run', () => {
    const { missingRequired } = decide(
      probes(),
      new Set(['sandbox', 'systemd-analyze']),
      new Set(),
    );
    expect(missingRequired).toEqual(['sandbox']);
  });

  it('forzata: i test girano, il motivo vero resta scritto e la richiesta non scatta', () => {
    const { report, missingRequired } = decide(
      probes(),
      new Set(['sandbox']),
      new Set(['sandbox']),
    );
    expect(report.sandbox.ok).toBe(true);
    expect(report.sandbox.forced).toBe(true);
    expect(report.sandbox.reason).toContain('git_hooks_unprotected');
    expect(missingRequired).toEqual([]);
  });

  it('forzare una capacità presente non cambia niente', () => {
    const { report } = decide(probes(), new Set(), new Set(['systemd-analyze']));
    expect(report['systemd-analyze'].forced).toBe(false);
    expect(report['systemd-analyze'].ok).toBe(true);
  });

  it('ogni capacità nota ha una riga nel log, con il motivo', () => {
    const { report } = decide(probes(), new Set(['sandbox']), new Set());
    const log = describeReport(report);
    for (const name of CAPABILITY_NAMES) expect(log).toContain(`[capacità] ${name}:`);
    expect(log).toContain('sandbox: no (richiesta) — linux: git_hooks_unprotected');
  });
});

describe('il nome del test porta sempre l etichetta, e il motivo quando salta', () => {
  const cap = (ok: boolean, reason: string) =>
    ({ name: 'sandbox', ok, reason, required: false, forced: false }) as const;

  it('capacità presente: solo l etichetta (è quella che la CI conta)', () => {
    expect(withReason('t', cap(true, 'x'))).toBe('t [richiede sandbox]');
  });

  it('capacità assente: etichetta e motivo', () => {
    expect(withReason('t', cap(false, 'manca AppArmor'))).toBe(
      't [richiede sandbox — saltato: manca AppArmor]',
    );
  });
});

describe('conteggio dei test marcati dal report JSON', () => {
  const t = (fullName: string, status: string) => ({ file: 'f.test.ts', fullName, status });

  it('conta per capacità chi ha girato e chi è saltato, con il motivo', () => {
    const s = tallyMarked([
      t('a [richiede sandbox] uno', 'passed'),
      t('a [richiede sandbox] due', 'failed'),
      t('b [richiede sandbox — saltato: manca AppArmor] tre', 'skipped'),
      t('c [richiede systemd-analyze — saltato: niente /run] quattro', 'skipped'),
      t('d senza etichetta', 'skipped'),
      t('e senza etichetta', 'passed'),
    ]);
    expect(s.byCapability.sandbox.ran).toBe(2);
    expect([...s.byCapability.sandbox.skipped]).toEqual([['manca AppArmor', 1]]);
    expect(s.byCapability['systemd-analyze'].ran).toBe(0);
    expect(s.unmarkedSkips.map((x) => x.fullName)).toEqual(['d senza etichetta']);
    expect(formatMarked(s)).toContain('[capacità] sandbox: 2 test eseguiti, 1 saltati');
  });

  it('un describe e un test con la stessa etichetta contano una volta', () => {
    const s = tallyMarked([t('g [richiede sandbox] x [richiede sandbox]', 'passed')]);
    expect(s.byCapability.sandbox.ran).toBe(1);
  });

  it('richiesta: un salto è un problema, e anche stare sotto il minimo', () => {
    const s = tallyMarked([
      t('a [richiede sandbox] uno', 'passed'),
      t('b [richiede sandbox — saltato: manca AppArmor] due', 'skipped'),
    ]);
    const problems = judgeMarked(s, new Set(['sandbox']), { sandbox: 5 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('1 test marcati sono saltati (manca AppArmor)');
    expect(problems[1]).toContain('hanno girato 1 test marcati, il minimo registrato è 5');
  });

  it('richiesta senza minimo registrato: è un problema, non un via libera', () => {
    const s = tallyMarked([t('a [richiede sandbox] uno', 'passed')]);
    expect(judgeMarked(s, new Set(['sandbox']), {})[0]).toContain('non ha un minimo');
  });

  it('non richiesta: salti e minimi non si giudicano (il portatile)', () => {
    const s = tallyMarked([t('b [richiede sandbox — saltato: no] due', 'skipped')]);
    expect(judgeMarked(s, new Set(), { sandbox: 5 })).toEqual([]);
  });

  it('un etichetta con un nome sconosciuto è un refuso da segnalare', () => {
    const s = tallyMarked([t('a [richiede sandbx] uno', 'passed')]);
    expect(judgeMarked(s, new Set(), {})).toEqual([
      'etichetta sconosciuta [richiede sandbx]: note sandbox, shell-boundary, systemd-analyze, plutil',
    ]);
  });
});

describe('il registro è armato', () => {
  it('vitest.config.ts carica vitest.capabilities.ts come globalSetup', () => {
    // Senza, capability() lancerebbe a raccolta in ogni file che la usa: rosso
    // rumoroso, ma meglio che saperlo da qui con il motivo giusto.
    const testo = readFileSync(join(import.meta.dirname, '..', 'vitest.config.ts'), 'utf8');
    expect(testo).toMatch(/globalSetup: \[[^\]]*'\.\/vitest\.capabilities\.ts'/);
  });

  it('il globalSetup lancia quando una capacità richiesta manca, non si limita a stampare', () => {
    const testo = readFileSync(join(import.meta.dirname, '..', 'vitest.capabilities.ts'), 'utf8');
    expect(testo).toContain('throw new Error');
  });
});
