import DatabaseCtor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { probeSandbox } from '../core/sandbox/probe.js';
import { wantsExplicitCache } from '../agent/providers/openai-compat.js';
import { verify } from '../core/rot/verify.js';
import { checkRotReaders } from '../core/rot/readers.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import { loadConfig, paths, readSecret, ConfigError } from '../core/config/config.js';

/**
 * Diagnosis that executes instead of assuming.
 *
 * Every check here answers "does it work", never "does it exist". The
 * difference is not pedantry: on the previous production host `bwrap` existed
 * in PATH and the sandbox contained nothing for two months, because Ubuntu
 * 24.04 blocks the user namespace it needs. A PATH check would have printed a
 * green line every day of it.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export type Check = {
  name: string;
  level: CheckLevel;
  detail: string;
  /** Present whenever the user has something to do about it. */
  remedy?: string;
};

export type DoctorReport = { checks: Check[]; exitCode: 0 | 1 | 2 };

export function runDoctor(home = paths().home, options: { online?: boolean } = {}): DoctorReport {
  const p = paths(home);
  const checks: Check[] = [];
  const ok = (name: string, detail: string) => checks.push({ name, level: 'ok', detail });
  const warn = (name: string, detail: string, remedy: string) =>
    checks.push({ name, level: 'warn', detail, remedy });
  const fail = (name: string, detail: string, remedy: string) =>
    checks.push({ name, level: 'fail', detail, remedy });

  if (!existsSync(p.home)) {
    fail('home', `${p.home} does not exist`, 'run `muffin init`');
    return report(checks);
  }
  ok('home', p.home);

  let config;
  try {
    config = loadConfig(home);
    // The cache dialect is inferred from the endpoint, and an inference the
    // owner cannot see is one they cannot correct: a miss pays full input
    // price on every turn, silently (ADR-0008 forbids exactly that shape).
    const cache =
      config.provider.kind === 'anthropic'
        ? 'breakpoints espliciti'
        : wantsExplicitCache(config.provider.baseUrl)
          ? 'breakpoints espliciti (endpoint riconosciuto)'
          : 'implicito (nessun breakpoint richiesto)';
    ok('config', `schemaVersion ${config.schemaVersion}, provider ${config.provider.kind}, cache ${cache}`);
  } catch (error) {
    const e = error as ConfigError;
    fail('config', e.message, e.remedy ?? 'run `muffin init`');
    return report(checks);
  }

  // Root of trust: integrity, and an honest statement of which guarantee the
  // current mode actually gives.
  const rot = verify(home, config.rot.mode);
  if (rot.ok) {
    ok('root of trust', `${rot.fileCount} files verified, mode ${rot.mode}`);
  } else if (rot.action === 'refuse') {
    fail('root of trust', `${rot.reason}: ${rot.diverged.join(', ')}`, rot.remedy);
  } else {
    warn('root of trust', `${rot.reason}: ${rot.diverged.join(', ')} — safe mode`, rot.remedy);
  }
  // Where the permission matrix came from. Same shape of invisible fact as the
  // cache dialect above: the sealed file and the compiled fallback behave
  // identically on a default install, so nothing in the agent's output tells
  // the owner which one answered — and the difference is whether their edits to
  // `rot/policy.json` mean anything.
  const matrix = loadPolicyMatrix(home);
  const taint = matrix.defaultMaxTaint;
  if (matrix.source === 'sealed') {
    ok(
      'policy matrix',
      `rot/policy.json — taint max low ${taint.low} / medium ${taint.medium} / high ${taint.high}, ${matrix.neverAtRuntime.size} mai a runtime, ${matrix.forbiddenForSystem.size} vietate agli autonomi`,
    );
  } else {
    warn(
      'policy matrix',
      `fallback ai valori compilati (${matrix.note}) — le modifiche a rot/policy.json non hanno effetto`,
      'ripristina il file dai default del repo e rifai `muffin rot reseal`',
    );
  }

  // The RoT-readers invariant, run where an owner will see it. An invariant
  // nothing executes is the defect examining itself — and this one exists
  // precisely because a sealed file went unread for months without a single
  // check going red.
  const readers = checkRotReaders(home);
  if (readers.skipped.length > 0) {
    warn('rot readers', readers.skipped.map((s) => `NON verificato — ${s.why}`).join('; '), 'run `muffin rot reseal`');
  } else if (readers.violations.length === 0) {
    ok('rot readers', `${readers.fileCount} file sigillati, ognuno con un lettore dichiarato`);
  } else {
    const worst = readers.violations.some((v) => v.severity === 'error') ? fail : warn;
    worst(
      'rot readers',
      readers.violations.map((v) => `${v.id}: ${v.sample.join(', ')}`).join(' · '),
      'un file dentro il sigillo che nessuno legge sembra vincolante e non lo è: dagli un lettore, oppure toglilo da rot/ e rifai `muffin rot reseal`',
    );
  }

  if (config.rot.mode === 'single-user') {
    warn(
      'root of trust mode',
      'single-user: tampering is detected, not prevented — a process running as this user can undo the read-only bits',
      'run `muffin init --hardened` on a machine where a dedicated service user is possible',
    );
  }

  // Key presence only. A network call costs money and needs an explicit opt-in.
  try {
    const key = readSecret(config.provider.apiKeyRef, home);
    if (key.length === 0) {
      fail('api key', 'secret file is empty', `write it with \`muffin secret set\``);
    } else {
      ok('api key', `${config.provider.apiKeyRef} present (${key.length} chars, never printed)`);
    }
  } catch (error) {
    const e = error as ConfigError;
    fail('api key', e.message, e.remedy ?? 'set the key');
  }
  if (options.online) {
    warn('api reachability', 'online check not implemented in M0', 'omit --online');
  }

  try {
    const db = new DatabaseCtor(p.db, { readonly: true });
    const tables = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table'`).get() as {
      n: number;
    };
    ok('database', `${p.db}, ${tables.n} tables`);

    // The semantic half of recall, checked rather than assumed. Three separate
    // defences against the vector index being silently empty were written into
    // this repository and none of them was ever *consulted* — which is the same
    // failure they were written to prevent, one layer out.
    const chunks = countOrNull(db, 'chunks');
    if (chunks === null) {
      warn(
        'vector index',
        'no chunks table yet: recall is full-text only until something is indexed',
        'run `muffin memory extract` or `muffin vault reindex`',
      );
    } else {
      let vectors: number | null = null;
      try {
        sqliteVec.load(db);
        vectors = countOrNull(db, 'chunks_vec');
      } catch {
        vectors = null;
      }
      if (vectors === null) {
        fail(
          'vector index',
          `${chunks} chunks stored and the vector table could not be read: recall has silently lost half of itself`,
          'reinstall sqlite-vec (a native binary mismatch after `npm ci` does this)',
        );
      } else if (vectors !== chunks) {
        fail(
          'vector index',
          `${chunks} chunks but ${vectors} vectors: the index is out of sync`,
          'run `muffin memory extract` to drain the backlog',
        );
      } else if (chunks === 0) {
        warn('vector index', 'empty: recall is full-text only', 'run `muffin memory extract`');
      } else {
        ok('vector index', `${chunks} chunks, ${vectors} vectors, in sync`);
      }
    }
    db.close();
  } catch (error) {
    fail('database', String(error), 'run `muffin init` to create it');
  }

  const sandbox = probeSandbox();
  if (sandbox.available) {
    ok('sandbox', `${sandbox.mechanism}: a real containment ran and held`);
  } else {
    // Not a hard failure: the runtime still starts, execution capabilities just
    // degrade to ask. Silently unsandboxed is the one outcome we refuse.
    warn(
      'sandbox',
      `${sandbox.mechanism} unavailable (${sandbox.reason}): ${sandbox.detail} — execution capabilities degrade to ask`,
      sandbox.remedy,
    );
  }

  // Was `statSync(p.home)` with the result assigned and voided — the remains of
  // a disk-space check that was never written, which made the failure branch
  // unreachable and the check a decoration.
  if (existsSync(p.traces)) {
    ok('traces', `${p.traces}, retention ${config.traces.retentionDays} days`);
  } else {
    warn('traces', `${p.traces} does not exist yet`, 'it is created on the first turn');
  }

  return report(checks);
}

function report(checks: Check[]): DoctorReport {
  const worst: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, exitCode: worst === 'fail' ? 2 : worst === 'warn' ? 1 : 0 };
}

export function formatReport(report: DoctorReport): string {
  const glyph: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };
  const lines = report.checks.map((c) => {
    const head = `${glyph[c.level]} ${c.name.padEnd(18)} ${c.detail}`;
    return c.remedy ? `${head}\n  → ${c.remedy}` : head;
  });
  return lines.join('\n');
}

/** `null` means the table is not there, which is a different fact from "zero rows". */
function countOrNull(db: DatabaseCtor.Database, table: string): number | null {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}
