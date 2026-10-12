import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal, TrustTier } from '../policy/types.js';

/**
 * Durable definitions for non-time-based automation rules.
 *
 * This store owns definitions only. It does not own event occurrence identity,
 * execution state, scheduling, receipts, or an event log. Those remain with
 * the producer and the #605 runtime seam.
 */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS automation_rules (',
  '  id               TEXT PRIMARY KEY,',
  '  tenant           TEXT NOT NULL,',
  '  event_kind       TEXT NOT NULL,',
  '  matcher_json     TEXT NOT NULL,',
  '  action_json      TEXT NOT NULL,',
  '  origin_principal TEXT NOT NULL,',
  '  origin_surface   TEXT NOT NULL,',
  '  origin_turn      TEXT,',
  '  tier             INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),',
  '  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),',
  '  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),',
  '  created_at       TEXT NOT NULL,',
  '  updated_at       TEXT NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_automation_rules_event',
  '  ON automation_rules(tenant, event_kind, enabled);',
].join('\n');

export type StoredAutomationMatcher = {
  /** P1 keeps matching deterministic and intentionally small. */
  readonly type: 'evidence_equals';
  readonly key: string;
  readonly value: string | number | boolean | null;
};

export type StoredAutomationAction = {
  /**
   * The executor class belongs to #605. ref is a host-owned stable action
   * identifier; the store never executes it or interprets arbitrary code.
   */
  readonly mode: 'deterministic' | 'agent' | 'deterministic_then_agent_on_signal';
  readonly ref: string;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
};

export type AutomationRuleOrigin = {
  readonly principal: Principal;
  readonly surface: string;
  readonly turnId: string | null;
  readonly tier: TrustTier;
};

export type StoredAutomationRule = {
  readonly id: string;
  readonly tenant: string;
  readonly eventKind: string;
  readonly matcher: StoredAutomationMatcher;
  readonly action: StoredAutomationAction;
  readonly origin: AutomationRuleOrigin;
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type NewStoredAutomationRule = {
  readonly id?: string | undefined;
  readonly tenant: string;
  /** Time-based rules remain JobStore-owned and are rejected here. */
  readonly eventKind: string;
  readonly matcher: StoredAutomationMatcher;
  readonly action: StoredAutomationAction;
  readonly origin: AutomationRuleOrigin;
};

export type AutomationRuleUpdate = {
  readonly matcher: StoredAutomationMatcher;
  readonly action: StoredAutomationAction;
  readonly origin: AutomationRuleOrigin;
};

type Row = {
  id: string;
  tenant: string;
  event_kind: string;
  matcher_json: string;
  action_json: string;
  origin_principal: string;
  origin_surface: string;
  origin_turn: string | null;
  tier: number;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
};

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(label + ' must be non-empty');
  return trimmed;
}

function asTier(value: number): TrustTier {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new Error('automation rule has invalid tier ' + String(value));
}

function validateMatcher(matcher: StoredAutomationMatcher): StoredAutomationMatcher {
  if (matcher.type !== 'evidence_equals') throw new Error('unsupported automation matcher');
  return { ...matcher, key: nonEmpty(matcher.key, 'matcher key') };
}

function validateAction(action: StoredAutomationAction): StoredAutomationAction {
  if (
    action.mode !== 'deterministic' &&
    action.mode !== 'agent' &&
    action.mode !== 'deterministic_then_agent_on_signal'
  ) {
    throw new Error('unsupported automation action mode');
  }
  return { ...action, ref: nonEmpty(action.ref, 'action ref') };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('automation rule has corrupt ' + label);
  }
}

function toRule(row: Row): StoredAutomationRule {
  const principal = parseJson<Principal>(row.origin_principal, 'origin principal');
  return {
    id: row.id,
    tenant: row.tenant,
    eventKind: row.event_kind,
    matcher: validateMatcher(parseJson<StoredAutomationMatcher>(row.matcher_json, 'matcher')),
    action: validateAction(parseJson<StoredAutomationAction>(row.action_json, 'action')),
    origin: {
      principal,
      surface: row.origin_surface,
      turnId: row.origin_turn,
      tier: asTier(row.tier),
    },
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AutomationRuleStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly enabledStmt: Database.Statement;
  private readonly enableStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      [
        'INSERT INTO automation_rules',
        '(id, tenant, event_kind, matcher_json, action_json, origin_principal,',
        ' origin_surface, origin_turn, tier, enabled, version, created_at, updated_at)',
        'VALUES',
        '(@id, @tenant, @eventKind, @matcher, @action, @principal,',
        ' @surface, @turnId, @tier, 1, 1, @now, @now)',
      ].join(' '),
    );
    this.getStmt = db.prepare('SELECT * FROM automation_rules WHERE id = ?');
    this.enabledStmt = db.prepare(
      [
        'SELECT * FROM automation_rules',
        'WHERE tenant = @tenant AND event_kind = @eventKind AND enabled = 1',
        'ORDER BY created_at, id',
      ].join(' '),
    );
    this.enableStmt = db.prepare(
      [
        'UPDATE automation_rules',
        'SET enabled = @enabled, version = version + 1, updated_at = @now',
        'WHERE id = @id AND version = @expectedVersion',
      ].join(' '),
    );
    this.updateStmt = db.prepare(
      [
        'UPDATE automation_rules',
        'SET matcher_json = @matcher, action_json = @action,',
        'origin_principal = @principal, origin_surface = @surface,',
        'origin_turn = @turnId, tier = @tier,',
        'version = version + 1, updated_at = @now',
        'WHERE id = @id AND version = @expectedVersion',
      ].join(' '),
    );
  }

  create(input: NewStoredAutomationRule): StoredAutomationRule {
    const tenant = nonEmpty(input.tenant, 'tenant');
    const eventKind = nonEmpty(input.eventKind, 'event kind');
    if (eventKind === 'schedule.fire') {
      throw new Error('schedule.fire rules belong to JobStore');
    }
    const matcher = validateMatcher(input.matcher);
    const action = validateAction(input.action);
    const id = input.id === undefined ? randomUUID() : nonEmpty(input.id, 'rule id');
    const now = this.clock().toISOString();
    this.insertStmt.run({
      id,
      tenant,
      eventKind,
      matcher: JSON.stringify(matcher),
      action: JSON.stringify(action),
      principal: JSON.stringify(input.origin.principal),
      surface: nonEmpty(input.origin.surface, 'origin surface'),
      turnId: input.origin.turnId,
      tier: input.origin.tier,
      now,
    });
    const created = this.get(id);
    if (!created) throw new Error('automation rule ' + id + ' was not persisted');
    return created;
  }

  get(id: string): StoredAutomationRule | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toRule(row) : null;
  }

  listEnabled(tenant: string, eventKind: string): StoredAutomationRule[] {
    return (this.enabledStmt.all({ tenant, eventKind }) as Row[]).map(toRule);
  }

  setEnabled(id: string, expectedVersion: number, enabled: boolean): StoredAutomationRule | null {
    const changed = this.enableStmt.run({
      id,
      expectedVersion,
      enabled: enabled ? 1 : 0,
      now: this.clock().toISOString(),
    }).changes;
    if (changed === 0) return null;
    return this.get(id);
  }

  update(id: string, expectedVersion: number, next: AutomationRuleUpdate): StoredAutomationRule | null {
    const matcher = validateMatcher(next.matcher);
    const action = validateAction(next.action);
    const changed = this.updateStmt.run({
      id,
      expectedVersion,
      matcher: JSON.stringify(matcher),
      action: JSON.stringify(action),
      principal: JSON.stringify(next.origin.principal),
      surface: nonEmpty(next.origin.surface, 'origin surface'),
      turnId: next.origin.turnId,
      tier: next.origin.tier,
      now: this.clock().toISOString(),
    }).changes;
    if (changed === 0) return null;
    return this.get(id);
  }
}
