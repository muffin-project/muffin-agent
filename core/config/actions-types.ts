import type { z } from 'zod';

/**
 * Unified Settings Action Registry (ADR-0114, slice 1).
 *
 * A declarative catalog in `core/`: every port (CLI subcommands, a later
 * `muffin settings` wizard, Telegram `/settings`, and `propose_setting_change`)
 * calls the same `plan` / `commit` / `read`. This module is only the types.
 */

export type ActionCategory = 'read' | 'restrict' | 'widen' | 'secret-oauth' | 'secret-intake';

export type ActionSection =
  | 'modelli'
  | 'chiavi'
  | 'telegram'
  | 'ricerca'
  | 'profilo'
  | 'budget'
  | 'embedding';

export type ActionSource = 'cli' | 'repl' | 'telegram' | 'conversation';

export type ActionStore = 'config' | 'rot/budgets' | 'rot/egress' | 'secret' | 'user.md' | 'none';

export type RestartNeed = 'none' | 'next-turn' | 'gateway';

export type ActionContext = {
  home: string;
  source: ActionSource;
  principal?: 'owner' | 'non-owner';
  now?: Date;
};

export type Displayed = {
  value: string;
  /** Where the value was read from, when that is useful to show. */
  source?: string;
};

export type ChangePlan = {
  actionId: string;
  category: ActionCategory;
  paramsCanonical: unknown;
  paramsDigest: string;
  before: string;
  after: string;
  files: string[];
  impact: string;
  restart: RestartNeed;
  unchanged?: true;
};

/**
 * Host proof that this exact action+params may be written.
 *
 * `owner-command` is the attestation that an already-authenticated owner
 * surface (CLI argv, REPL, Telegram command intercepted before the model)
 * typed the command. It is never valid from `conversation`, and it is only
 * accepted on actions that opt in (`ownerTypedCommand`), so a new `widen`
 * cannot sneak through a typable flag. There is no `--yes` / `--force`.
 *
 * `single-use` is the ADR-0109 binding: actionId + params digest + principal
 * + surface, consumed once in the same write.
 */
export type HostAuthorization =
  | {
      kind: 'owner-command';
      source: ActionSource;
      actionId: string;
      paramsDigest: string;
    }
  | {
      kind: 'single-use';
      token: string;
      actionId: string;
      paramsDigest: string;
      principal: 'owner';
      surface: ActionSource;
    };

export type PlanOutcome = { ok: true; plan: ChangePlan } | { ok: false; reason: string };

export type ReadOutcome = { ok: true; displayed: Displayed } | { ok: false; reason: string };

export type CommitOutcome =
  | { ok: true; plan: ChangePlan; backup: string | null }
  | { ok: false; reason: string };

export type ActionSpec<P = unknown> = {
  id: string;
  section: ActionSection;
  label: string;
  help: string;
  category: ActionCategory;
  params: z.ZodType<P>;
  store: ActionStore;
  restart?: RestartNeed;
  /**
   * When true, an owner-typed command on `cli` / `repl` / `telegram` is
   * sufficient authorization. Conversation is never sufficient. Used only
   * to keep already-scriptable verbs (`muffin config set`, `muffin model
   * embed off`) identical; new widen/egress actions must not set this.
   */
  ownerTypedCommand?: boolean;
  read?: (ctx: ActionContext) => Displayed;
  plan: (params: P, ctx: ActionContext) => PlanOutcome;
  /** Invoked only by `commit` after authorization has been verified and consumed. */
  write: (plan: ChangePlan, ctx: ActionContext, params: P) => void;
  /** Re-read after write; must equal `plan.after` or the commit fails closed. */
  readAfter: (ctx: ActionContext, params: P) => string;
};

export type ActionMeta = {
  id: string;
  section: ActionSection;
  label: string;
  help: string;
  category: ActionCategory;
  store: ActionStore;
  restart: RestartNeed;
  ownerTypedCommand: boolean;
};
