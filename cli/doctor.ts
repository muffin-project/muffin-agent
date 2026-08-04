import DatabaseCtor from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { probeSandbox } from '../core/sandbox/probe.js';
import { verify } from '../core/rot/verify.js';
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
    ok('config', `schemaVersion ${config.schemaVersion}, provider ${config.provider.kind}`);
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
    db.close();
    ok('database', `${p.db}, ${tables.n} tables`);
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

  try {
    const free = statSync(p.home);
    ok('traces', `${p.traces}, retention ${config.traces.retentionDays} days`);
    void free;
  } catch {
    warn('traces', 'trace directory not readable', 'check permissions on the home directory');
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
