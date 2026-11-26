import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalBindingDigest } from './actions-digest.js';
import type { ActionSource, ChangePlan } from './actions-types.js';
import { ensurePrivateDir, tightenPrivateFile } from './private-fs.js';

/**
 * Single-use settings approvals (ADR-0114 / ADR-0109).
 *
 * Stored as a 0600 JSON file under the home (`settings-approvals.json`), not
 * in the turn-scoped SQLite table: a CLI or `/settings` write must not require
 * a live gateway database. The binding is the same: actionId + params digest
 * + principal + surface, consumed once, fail-closed on mismatch or reuse.
 *
 * Lifetime is short (10 minutes). A later conversational slice can also write
 * through `core/approvals/store.ts`; this file stays the host-side gate for
 * settings commits that happen outside a turn.
 */

const FILENAME = 'settings-approvals.json';
const TTL_MS = 10 * 60 * 1000;

export type SettingsApprovalRecord = {
  token: string;
  binding: string;
  actionId: string;
  paramsDigest: string;
  principal: 'owner';
  surface: ActionSource;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

type StoreFile = { approvals: SettingsApprovalRecord[] };

function storePath(home: string): string {
  return join(home, FILENAME);
}

function loadStore(home: string): StoreFile {
  const file = storePath(home);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
    if (!Array.isArray(raw.approvals)) return { approvals: [] };
    return raw;
  } catch {
    return { approvals: [] };
  }
}

function saveStore(home: string, store: StoreFile): void {
  const file = storePath(home);
  if (!ensurePrivateDir(dirname(file))) {
    throw new Error(
      `non posso scrivere ${file}: la directory privata non è stata stabilita (symlink sulla catena)`,
    );
  }
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenPrivateFile(file);
}

export function issueSettingsApproval(
  home: string,
  plan: ChangePlan,
  input: { principal: 'owner'; surface: ActionSource; now?: Date },
): SettingsApprovalRecord {
  const now = input.now ?? new Date();
  const token = randomBytes(24).toString('hex');
  const record: SettingsApprovalRecord = {
    token,
    binding: approvalBindingDigest({
      actionId: plan.actionId,
      paramsDigest: plan.paramsDigest,
      principal: input.principal,
      surface: input.surface,
    }),
    actionId: plan.actionId,
    paramsDigest: plan.paramsDigest,
    principal: input.principal,
    surface: input.surface,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    consumedAt: null,
  };
  const store = loadStore(home);
  store.approvals.push(record);
  saveStore(home, store);
  return record;
}

/**
 * Consume a single-use approval in the same breath as the write. Returns an
 * error string when the token is missing, expired, already used, or bound to
 * a different action/params/principal/surface.
 */
export function consumeSettingsApproval(
  home: string,
  expected: {
    token: string;
    actionId: string;
    paramsDigest: string;
    principal: 'owner';
    surface: ActionSource;
  },
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const store = loadStore(home);
  const rec = store.approvals.find((r) => r.token === expected.token);
  if (rec === undefined) return { ok: false, reason: 'approvazione assente o già dimenticata' };
  if (rec.consumedAt !== null) return { ok: false, reason: 'approvazione già usata' };
  if (Date.parse(rec.expiresAt) <= now.getTime()) {
    return { ok: false, reason: 'approvazione scaduta' };
  }
  const binding = approvalBindingDigest({
    actionId: expected.actionId,
    paramsDigest: expected.paramsDigest,
    principal: expected.principal,
    surface: expected.surface,
  });
  if (
    rec.binding !== binding ||
    rec.actionId !== expected.actionId ||
    rec.paramsDigest !== expected.paramsDigest ||
    rec.principal !== expected.principal ||
    rec.surface !== expected.surface
  ) {
    return {
      ok: false,
      reason: 'approvazione non corrisponde a questa azione e a questi parametri',
    };
  }
  rec.consumedAt = now.toISOString();
  saveStore(home, store);
  return { ok: true };
}
