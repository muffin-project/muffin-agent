import { copyFileSync, existsSync } from 'node:fs';
import { backupOwnerConfigFile } from '../rot/backup.js';
import { getAction } from './actions.js';
import { consumeSettingsApproval } from './actions-approval.js';
import type {
  ActionContext,
  ChangePlan,
  CommitOutcome,
  HostAuthorization,
} from './actions-types.js';

/**
 * The write path of the settings registry (ADR-0114).
 *
 * Isolated from `actions.ts` so a layering test can forbid `agent/tools/`
 * from importing `commit` (and the privileged sinks) without also forbidding
 * `plan` / `read`. `commit` writes only after a host authorization has been
 * verified — and, for single-use tokens, consumed — and then re-reads the
 * file to confirm the new value. A backup is taken first.
 *
 * There is no `--yes` or `--force` skip. A widen without a valid authorization
 * does not write. ADR-0058: egress/widen is the owner's word, never a flag.
 */

const OWNER_SURFACES = new Set(['cli', 'repl', 'telegram']);

function authorize(
  plan: ChangePlan,
  ctx: ActionContext,
  authorization: HostAuthorization,
  ownerTypedCommand: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (
    authorization.actionId !== plan.actionId ||
    authorization.paramsDigest !== plan.paramsDigest
  ) {
    return {
      ok: false,
      reason: 'approvazione non corrisponde a questa azione e a questi parametri',
    };
  }
  if (authorization.kind === 'owner-command') {
    if (!ownerTypedCommand) {
      return {
        ok: false,
        reason:
          'questa azione richiede una conferma esplicita monouso; un comando o un flag non bastano',
      };
    }
    if (authorization.source === 'conversation' || !OWNER_SURFACES.has(authorization.source)) {
      return {
        ok: false,
        reason: 'un comando digitato in conversazione non autorizza una scrittura di impostazioni',
      };
    }
    if (authorization.source !== ctx.source) {
      return { ok: false, reason: 'approvazione non corrisponde alla superficie di questa azione' };
    }
    return { ok: true };
  }
  if (authorization.kind === 'single-use') {
    if (authorization.principal !== 'owner') {
      return { ok: false, reason: "solo l'owner può approvare una scrittura di impostazioni" };
    }
    if (authorization.surface !== ctx.source) {
      return { ok: false, reason: 'approvazione non corrisponde alla superficie di questa azione' };
    }
    return consumeSettingsApproval(
      ctx.home,
      {
        token: authorization.token,
        actionId: plan.actionId,
        paramsDigest: plan.paramsDigest,
        principal: authorization.principal,
        surface: authorization.surface,
      },
      ctx.now,
    );
  }
  return { ok: false, reason: 'autorizzazione non riconosciuta' };
}

function restoreFromBackup(backup: string | null, files: readonly string[]): void {
  if (backup === null || files[0] === undefined || !existsSync(backup)) return;
  copyFileSync(backup, files[0]);
}

export function commit(
  plan: ChangePlan,
  ctx: ActionContext,
  authorization: HostAuthorization,
): CommitOutcome {
  const spec = getAction(plan.actionId);
  if (spec === undefined) {
    return { ok: false, reason: `azione sconosciuta: ${plan.actionId}` };
  }

  if (plan.unchanged) {
    return { ok: true, plan, backup: null };
  }

  const auth = authorize(plan, ctx, authorization, spec.ownerTypedCommand === true);
  if (!auth.ok) return auth;

  const parsed = spec.params.safeParse(plan.paramsCanonical);
  if (!parsed.success) {
    return { ok: false, reason: `parametri del piano non validi per ${plan.actionId}` };
  }

  // Re-plan against live state: a yes on a stale "before" must not write.
  const fresh = spec.plan(parsed.data, ctx);
  if (!fresh.ok) return fresh;
  if (fresh.plan.paramsDigest !== plan.paramsDigest || fresh.plan.after !== plan.after) {
    return {
      ok: false,
      reason: "lo stato è cambiato dopo il piano: la conferma non vale più, ripeti l'azione",
    };
  }
  if (fresh.plan.unchanged) {
    return { ok: true, plan: fresh.plan, backup: null };
  }

  let backup: string | null = null;
  const primary = plan.files[0];
  if (primary !== undefined) {
    try {
      backup = backupOwnerConfigFile(ctx.home, primary, ctx.now ?? new Date());
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    spec.write(fresh.plan, ctx, parsed.data);
    const after = spec.readAfter(ctx, parsed.data);
    if (after !== fresh.plan.after) {
      restoreFromBackup(backup, plan.files);
      return {
        ok: false,
        reason:
          `scrittura rifiutata in rilettura: atteso «${fresh.plan.after}», letto «${after}»` +
          (backup ? ` (ripristinato dal backup ${backup})` : ''),
      };
    }
  } catch (error) {
    restoreFromBackup(backup, plan.files);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, plan: fresh.plan, backup };
}
