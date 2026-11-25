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

export const CAPABILITY_NAMES = ['sandbox', 'shell-boundary', 'systemd-analyze'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type Capability = {
  /** La capacità c'è (o è stata forzata, vedi `forced`). */
  ok: boolean;
  /** Perché sì o perché no, in parole. Mai vuota. */
  reason: string;
  /** Questa run la pretende: un salto qui sarebbe un difetto. */
  required: boolean;
  /** Forzata con `MUFFIN_FORCE_CAPABILITIES`: i test girano anche se il probe dice no. */
  forced: boolean;
};

export type CapabilityReport = Record<CapabilityName, Capability>;

type Probe = { ok: boolean; reason: string };

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

function parseList(name: string, value: string | undefined): CapabilityName[] {
  if (value === undefined || value.trim() === '') return [];
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const n of names) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(n)) {
      throw new Error(
        `${name}: capacità sconosciuta «${n}». Note: ${CAPABILITY_NAMES.join(', ')}.`,
      );
    }
  }
  return names as CapabilityName[];
}

/**
 * Le capacità pretese da questa run. Le due variabili storiche restano alias:
 * `MUFFIN_REQUIRE_SANDBOX=1` pretendeva sia il contenimento sia il confine shell
 * (vedi `evals/system/acceptance.test.ts`), `MUFFIN_REQUIRE_SYSTEMD=1` il parser.
 */
export function requiredCapabilities(env: NodeJS.ProcessEnv = process.env): Set<CapabilityName> {
  const required = new Set(
    parseList('MUFFIN_REQUIRE_CAPABILITIES', env['MUFFIN_REQUIRE_CAPABILITIES']),
  );
  if (env['MUFFIN_REQUIRE_SANDBOX'] === '1') {
    required.add('sandbox');
    required.add('shell-boundary');
  }
  if (env['MUFFIN_REQUIRE_SYSTEMD'] === '1') required.add('systemd-analyze');
  return required;
}

/**
 * Capacità forzate: i test girano anche se il probe dice no, e falliscono per
 * il motivo vero. Serve alla prova di mutazione della CI (togli i deny
 * AppArmor, il test di produzione deve diventare rosso nominando
 * `git_hooks_unprotected`): senza forzatura quel test salterebbe.
 */
export function forcedCapabilities(env: NodeJS.ProcessEnv = process.env): Set<CapabilityName> {
  return new Set(parseList('MUFFIN_FORCE_CAPABILITIES', env['MUFFIN_FORCE_CAPABILITIES']));
}

/** Combina probe, richieste e forzature. Puro: è la parte che i test unitari coprono. */
export function decide(
  probes: Record<CapabilityName, Probe>,
  required: Set<CapabilityName>,
  forced: Set<CapabilityName>,
): { report: CapabilityReport; missingRequired: CapabilityName[] } {
  const report = {} as CapabilityReport;
  const missingRequired: CapabilityName[] = [];
  for (const name of CAPABILITY_NAMES) {
    const probe = probes[name];
    const isForced = forced.has(name) && !probe.ok;
    report[name] = {
      ok: probe.ok || isForced,
      reason: isForced
        ? `forzata da MUFFIN_FORCE_CAPABILITIES; il probe dice: ${probe.reason}`
        : probe.reason,
      required: required.has(name),
      forced: isForced,
    };
    if (required.has(name) && !probe.ok && !isForced) missingRequired.push(name);
  }
  return { report, missingRequired };
}

export async function probeAll(): Promise<Record<CapabilityName, Probe>> {
  const sandbox = await probeSandbox();
  return {
    sandbox,
    'shell-boundary': await probeShellBoundary(sandbox),
    'systemd-analyze': probeSystemdAnalyze(),
  };
}

/** Una riga per capacità, per il log della run. */
export function describeReport(report: CapabilityReport): string {
  return CAPABILITY_NAMES.map((name) => {
    const c = report[name];
    const stato = c.forced ? 'FORZATA' : c.ok ? 'sì' : 'no';
    const req = c.required ? ' (richiesta)' : '';
    return `[capacità] ${name}: ${stato}${req} — ${c.reason}`;
  }).join('\n');
}
