import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  decide,
  describeReport,
  forcedCapabilities,
  requiredCapabilities,
} from './capabilities.js';
import { withReason } from './requires.js';

const probes = (over: Partial<Record<CapabilityName, { ok: boolean; reason: string }>> = {}) => ({
  sandbox: { ok: false, reason: 'linux: git_hooks_unprotected — fixture' },
  'shell-boundary': { ok: false, reason: 'richiede sandbox — fixture' },
  'systemd-analyze': { ok: true, reason: 'systemd-analyze verify funziona su questo host' },
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

describe('il nome del test porta il motivo solo quando salta', () => {
  it('capacità presente: nome invariato (in CI i nomi non cambiano)', () => {
    expect(withReason('t', { ok: true, reason: 'x', required: true, forced: false })).toBe('t');
  });

  it('capacità assente: il motivo è nel nome', () => {
    expect(
      withReason('t', { ok: false, reason: 'manca AppArmor', required: false, forced: false }),
    ).toBe('t [saltato: manca AppArmor]');
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
