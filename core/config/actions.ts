import { builtinActions } from './actions-builtins.js';
import type {
  ActionContext,
  ActionMeta,
  ActionSource,
  ActionSpec,
  ChangePlan,
  HostAuthorization,
  PlanOutcome,
  ReadOutcome,
} from './actions-types.js';

/**
 * Unified Settings Action Registry — `plan` / `read` / catalog (ADR-0114).
 *
 * `commit` lives in `actions-commit.ts` on purpose: a static test forbids
 * `agent/tools/` from importing that module (or `saveConfig`,
 * `writeAuthoritativeSecret`, `widenEgressForCapability`). The conversational
 * tool, when it arrives, will speak only to a propose facade that calls `plan`.
 */

export { describeSettableKnobs, SETTABLE_CONFIG_KEYS } from './actions-builtins.js';
export { approvalBindingDigest, canonicalJson, paramsDigest } from './actions-digest.js';
export type {
  ActionCategory,
  ActionContext,
  ActionMeta,
  ActionSection,
  ActionSource,
  ActionSpec,
  ActionStore,
  ChangePlan,
  CommitOutcome,
  Displayed,
  HostAuthorization,
  PlanOutcome,
  ReadOutcome,
  RestartNeed,
} from './actions-types.js';

// The catalog is heterogeneous: each action has its own params type.
// Registration is generic; lookups go through a wide view.
type AnyAction = Omit<ActionSpec, 'params' | 'plan' | 'write' | 'readAfter'> & {
  params: ActionSpec['params'];
  plan: (params: unknown, ctx: ActionContext) => PlanOutcome;
  write: (plan: ChangePlan, ctx: ActionContext, params: unknown) => void;
  readAfter: (ctx: ActionContext, params: unknown) => string;
};

const catalog = new Map<string, AnyAction>();

export function registerAction(spec: Pick<ActionSpec, 'id'> & object): void {
  if (catalog.has(spec.id)) {
    throw new Error(`azione già registrata: ${spec.id}`);
  }
  catalog.set(spec.id, spec as unknown as AnyAction);
}

/** Test-only: drop a temporary action registered in a unit test. */
export function unregisterAction(id: string): void {
  catalog.delete(id);
}

export function getAction(id: string): AnyAction | undefined {
  return catalog.get(id);
}

export function listActions(): ActionMeta[] {
  return [...catalog.values()].map((spec) => ({
    id: spec.id,
    section: spec.section,
    label: spec.label,
    help: spec.help,
    category: spec.category,
    store: spec.store,
    restart: spec.restart ?? 'none',
    ownerTypedCommand: spec.ownerTypedCommand === true,
  }));
}

for (const spec of builtinActions) registerAction(spec);

export function plan(actionId: string, params: unknown, ctx: ActionContext): PlanOutcome {
  const spec = catalog.get(actionId);
  if (spec === undefined) {
    return { ok: false, reason: `azione sconosciuta: ${actionId}` };
  }
  const parsed = spec.params.safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    return { ok: false, reason: `parametri non validi per ${actionId}: ${detail}` };
  }
  return spec.plan(parsed.data, ctx);
}

export function read(actionId: string, ctx: ActionContext): ReadOutcome {
  const spec = catalog.get(actionId);
  if (spec === undefined) {
    return { ok: false, reason: `azione sconosciuta: ${actionId}` };
  }
  if (spec.read === undefined) {
    return { ok: false, reason: `${actionId} non ha una lettura` };
  }
  return { ok: true, displayed: spec.read(ctx) };
}

/**
 * Attestation that the owner typed this exact command on an owner surface.
 * Not valid for `conversation`, and `commit` will still reject it on actions
 * that did not opt in to `ownerTypedCommand`.
 */
export function ownerCommandAuthorization(
  planOr: Pick<ChangePlan, 'actionId' | 'paramsDigest'>,
  source: ActionSource,
): HostAuthorization {
  return {
    kind: 'owner-command',
    source,
    actionId: planOr.actionId,
    paramsDigest: planOr.paramsDigest,
  };
}
