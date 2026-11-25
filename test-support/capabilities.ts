/**
 * Registro unico delle capacità d'ambiente da cui dipendono alcuni test.
 *
 * Un test che ha bisogno di qualcosa che non tutte le macchine hanno (il
 * sandbox di produzione, il parser di systemd) non decide da solo se girare:
 * chiede qui. La risposta è sempre `{ ok, reason }`, e `reason` è una frase che
 * finisce nel nome del test saltato, così un salto non si legge mai come un
 * passaggio (pytest `skipif(reason=)`, Node `common.skip(msg)`, Flatpak
 * `skip_without_bwrap`: stessa regola).
 *
 * Perché un registro e non un cancello per file: fino a qui 12 file avevano
 * ciascuno la propria copia del cancello, e chiedevano tutti a `probeSandbox()`.
 * Il probe dice se bwrap contiene; non dice se il contenimento di **produzione**
 * regge, cioè se il self-test completo dell'executor (`verify()`, hook Git
 * compresi) passa. Su un host senza AppArmor il probe è verde e `verify()`
 * risponde `git_hooks_unprotected`: 70 test fallivano per l'ambiente invece di
 * saltare dicendolo. La domanda giusta ora è una, ed è fatta una volta sola per
 * run, in `vitest.capabilities.ts` (globalSetup).
 *
 * Il rovescio del salto è la richiesta. `MUFFIN_REQUIRE_CAPABILITIES` (lista
 * separata da virgole) nomina le capacità che su questa macchina **devono**
 * esserci: se una manca, la run fallisce subito, prima di qualunque test. La CI
 * la imposta sul runner che sta al posto della VPS di produzione.
 *
 * Questo file non importa `vitest`: gira dentro il globalSetup, nel processo
 * principale. Il lato test (`capability()`) sta in `./requires.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { planUnit, systemdDiagnosticsForUnit } from '../core/gateway/unit.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import { assessShellBoundary } from '../core/sandbox/shell-boundary.js';

export * from './capability-policy.js';

import type { CapabilityName } from './capability-policy.js';

export type Probe = { ok: boolean; reason: string };

/**
 * Il sandbox di produzione, con la stessa porta che usano `doctor` e `muffin
 * init`: `SandboxExecutor.verify()` paga il self-test vero (deny/allow, filtro
 * AF_UNIX, hook Git in un repository annidato) invece del probe economico.
 */
async function probeSandbox(): Promise<Probe> {
  const host = platform();
  if (host !== 'darwin' && host !== 'linux') {
    return { ok: false, reason: `nessun sandbox a livello di sistema operativo su ${host}` };
  }
  const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] });
  try {
    const p = await executor.verify();
    if (!p.available) return { ok: false, reason: `${host}: ${p.reason} — ${p.detail}` };
    return {
      ok: true,
      reason: `${host}: ${p.mechanism}, self-test di produzione superato (hook Git compresi)`,
    };
  } finally {
    await executor.close().catch(() => {});
  }
}

/**
 * Ciò che `buildRuntime` registra davvero: il sandbox che regge **e** il
 * pavimento di versione di bubblewrap del confine condiviso (#642). Un runtime
 * con il probe verde ma il confine non usabile non espone le shell.
 */
async function probeShellBoundary(sandbox: Probe): Promise<Probe> {
  if (!sandbox.ok) return { ok: false, reason: `richiede sandbox — ${sandbox.reason}` };
  const { probeSandbox: cheapProbe } = await import('../core/sandbox/probe.js');
  const boundary = assessShellBoundary(cheapProbe());
  if (!boundary.usable) return { ok: false, reason: `${boundary.reason}; ${boundary.remedy}` };
  return { ok: true, reason: `${sandbox.reason}; confine shell usabile` };
}

/**
 * `systemd-analyze verify` su una unit generata in una directory temporanea.
 * Non basta `--version`: dentro un container il binario c'è e il verify muore
 * con «Failed to create directory /run/systemd…», e quello non dice niente
 * sulla unit di Muffin.
 */
function probeSystemdAnalyze(): Probe {
  const version = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (version.error !== undefined || version.status !== 0) {
    return {
      ok: false,
      reason: `systemd-analyze non eseguibile qui (${version.error?.message ?? `exit ${String(version.status)}`})`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'muffin-cap-systemd-'));
  try {
    const launcher = join(dir, 'muffin');
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const file = join(dir, 'muffin-gateway.service');
    writeFileSync(
      file,
      planUnit({
        platform: 'linux',
        home: dir,
        exec: [launcher, 'gateway', 'run'],
        configHome: dir,
      }).text,
    );
    const verify = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    const relevant = systemdDiagnosticsForUnit(
      file,
      `${verify.stdout ?? ''}${verify.stderr ?? ''}`,
    );
    // Solo il rumore che viene dall'host (un container senza /run/systemd
    // scrivibile) rende il parser inutilizzabile. Una lamentela sulla unit
    // stessa la giudica il test, non il probe: qui la capacità resta presente.
    const hostFailure = relevant
      .split('\n')
      .find((line) =>
        /Failed to (create|set ?up)|Permission denied|Operation not permitted|Read-only file system/.test(
          line,
        ),
      );
    if (hostFailure !== undefined) {
      return {
        ok: false,
        reason: `systemd-analyze non utilizzabile su questo host: ${hostFailure.trim()}`,
      };
    }
    return { ok: true, reason: 'systemd-analyze verify funziona su questo host' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function probeAll(): Promise<Record<CapabilityName, Probe>> {
  const sandbox = await probeSandbox();
  return {
    sandbox,
    'shell-boundary': await probeShellBoundary(sandbox),
    'systemd-analyze': probeSystemdAnalyze(),
  };
}
