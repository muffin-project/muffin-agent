import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { DeliveryOutcome, FileSpec } from '../../core/surface/types.js';
import type { RegisteredTool, ToolOutcome } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';
import { PathDenied, resolveInScope, type FsScope } from './fs.js';

/**
 * DAY-1 requirement B14 — a file the agent produced arrives as an attachment, not as a
 * path the owner has to go copy by hand.
 *
 * `connectors/telegram/media.ts`'s `sendDocument` said it plainly: *"Its
 * production caller does not exist yet, on purpose. Sending a file is an
 * outward action, and outward actions arrive with the outward module and its
 * approval path — not as a CLI verb bolted on to give this function something
 * to call it."* This is that module, now that `Surface.deliverFile`
 * (`core/surface/types.ts`) gives every surface — Telegram, Discord, the
 * terminal — the same contract to answer to.
 *
 * ## Due radici, entrambe in lettura
 *
 * Il file che l'agente produce con `fs_write` vive nella **radice di progetto**
 * (`Runtime.workspace`), mentre un allegato che l'owner ha mandato vive nel
 * **vault** (`~/.muffin/vault`, stato d'installazione). Fino al 19/10/2026
 * `send_file` aveva una sola radice — il vault — quindi un report appena
 * scritto non si poteva mandare: il tool rispondeva "outside the working
 * directory" su un file che l'agente aveva appena creato. Il caso d'uso
 * principale era rotto, e il test di accettazione B14 lo aveva cristallizzato
 * scrivendo il file nel vault invece di usare `fs_write`.
 *
 * Le due radici sono **in lettura**, in quest'ordine: progetto, poi vault. La
 * radice di progetto vince a parità di nome, perché è l'output di questo turno.
 * Le liste `denyRead`/`denyWrite` restano quelle di `mandatoryGuards`, e la
 * scrittura non passa da qui: questo tool non scrive niente.
 *
 * ## Where this stops, and why it stops there
 *
 * `hostOnly: true` is a real limitation, stated rather than discovered later:
 * the vault is **one shared directory** across every tenant (ADR captured in
 * `core/vault/vault.ts` — "la directory fisica del vault è condivisa"), and
 * `document_read`/ingestion get away with that by scoping *entry* to the one
 * path that just arrived (`connectors/telegram/connector.ts`'s `ingest`,
 * mirrored in `connectors/discord/connector.ts`). Egress has no matching
 * scope yet: nothing here stops a `member` principal from naming an absolute
 * path to a file that landed in the vault from a different group's turn.
 * Closing that is the same shape of work C7 already did for arrival, applied
 * to the opposite direction — real, not done here, and owner-only is the
 * honest boundary until it is.
 */

const sendFileArgs = z.object({
  /** A path this turn already knows about — typically returned by fs_write or an ingest note. */
  path: z.string().min(1),
  /** Shown alongside the file where the surface supports one. Each Surface truncates to its own caption limit. */
  caption: z.string().max(1024).optional(),
});

export const sendFileCapability: CapabilityDecl = {
  id: 'surface.send_file',
  effect: 'reply',
  // Same trust class as replying with more text on the same channel ("Reply
  // sul canale di origine: ALLOW", 03-threat-model.md §2) — this attaches to
  // the conversation already under way, it does not open one. The "Outward"
  // row of that matrix (DRAFT-by-default, confirm to send) is about *new*
  // recipients; nothing here picks one.
  risk: 'medium',
  // Cannot be undone once the bytes are on the wire, and resending is a
  // second, different delivery rather than a no-op repeat of the first — the
  // two axes PRACTICES' Deliver research keeps separate.
  reversible: 'no',
  rerunnable: false,
  resourceKind: 'path',
  policyArgs: ['path'],
  hostOnly: true,
};

const sendFileToolSpec: ToolSpec = {
  name: 'send_file',
  description:
    "Send a file from the project working directory or the vault as a real attachment on the current conversation's surface (Telegram, Discord, or the terminal), instead of citing its path in text. " +
    'Use it when the owner should be able to open something directly — a report you just wrote, an exported chart, a generated document, or an attachment the owner sent earlier. ' +
    'Not for text you can just say in the reply: only for actual files. Returns confirmation that the attachment was delivered, or the reason it was not.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path to the file, relative to the project working directory or the vault (or absolute, if already known). A leading "vault/" is accepted for files the owner sent.',
      },
      caption: { type: 'string', description: 'Optional short text shown alongside the file' },
    },
    required: ['path'],
  },
};

export type SendFileDeps = {
  /**
   * Read scopes, in priority order: the project working directory first, then
   * the vault. See the module docstring for why both and why in this order.
   */
  scopes: readonly FsScope[];
  deliverFile: (channel: string, file: FileSpec) => Promise<DeliveryOutcome>;
};

/**
 * Resolve `requested` against the first scope that contains it.
 *
 * A relative path is tried twice per scope: as written, and with a leading
 * `<basename(scope.root)>/` removed. The second form exists for one measured
 * bug — the ingest line names a file relative to the vault root (`inbox/x`),
 * while a model that has seen the path in another context writes
 * `vault/inbox/x`, and the old single-root resolver joined it to
 * `vault/vault/inbox/x`. The strip only fires when the first segment really is
 * the root's own name, so it cannot turn an unrelated relative path into a
 * different one.
 */
function resolveForSend(scopes: readonly FsScope[], requested: string): string {
  const attempts: string[] = [];
  for (const scope of scopes) {
    const candidates = [requested];
    if (!isAbsolute(requested)) {
      const rootName = basename(resolve(scope.root));
      if (requested.startsWith(`${rootName}/`) || requested.startsWith(`${rootName}\\`)) {
        candidates.push(requested.slice(rootName.length + 1));
      }
    }
    for (const candidate of candidates) {
      try {
        const resolved = resolveInScope(scope, candidate, false);
        // The path must be a file that exists. Without this check the first
        // scope "succeeds" on a path that merely sits inside it, and a file
        // that only exists in the second scope is never reached — the same
        // shadowing that made the vault case fail with two non-existent paths.
        if (statSync(resolved, { throwIfNoEntry: false })?.isFile() !== true) {
          attempts.push(`no such file: ${requested}`);
          continue;
        }
        return resolved;
      } catch (error) {
        attempts.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  throw new PathDenied(
    `outside the working directory and the vault: ${requested}` +
      (attempts.length === 0 ? '' : ` (${attempts.join('; ')})`),
    'outside_scope',
  );
}

/**
 * Built once the registry exists (`connectSurfaces`), late-registered via
 * `Runtime.register` — the same seam `attachMcp` uses for tools that cannot
 * exist at `buildRuntime` time. `deliverFile` is bound here, at wiring time;
 * `ctx.replyChannel` (per-turn) is read at call time — the split
 * `agent/loop.ts`'s `ToolContext` docstring describes.
 */
export function makeSendFileTool(deps: SendFileDeps): RegisteredTool {
  return {
    capability: sendFileCapability.id,
    spec: sendFileToolSpec,
    // `throwTier` (ADR-0044, required since dev's PR #28) is the tier a
    // *thrown* failure from this handler would drag in. It never does: every
    // exit below is a returned `ToolOutcome`, including the `try/catch` around
    // `resolveInScope`, and `deps.deliverFile` is `SurfaceRegistry.deliverFile`
    // in production, which itself catches an implementation that throws and
    // converts it to `{delivered:false}` (`core/surface/registry.ts`). What
    // this handler can throw is therefore only its own words — a path echoed
    // back, a validation message — never a byte read from outside it, so 0 is
    // the correct answer, not a placeholder pending a redesign.
    throwTier: 0,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      const parsed = sendFileArgs.safeParse(args);
      if (!parsed.success) {
        return { content: `argomenti non validi: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true, tier: 0 };
      }

      if (ctx.replyChannel === null || ctx.replyChannel === undefined) {
        // Not a foreseeable-failure `DeliveryOutcome` — there is no channel to
        // even try. A job with no `replyTo`, or a turn on a surface that never
        // set one, has nowhere for this tool to address a follow-up delivery.
        return {
          content: 'questo turno non ha un canale di risposta indirizzabile: non posso inviare un allegato qui',
          isError: true,
          tier: 0,
        };
      }

      let resolved: string;
      try {
        resolved = resolveForSend(deps.scopes, parsed.data.path);
      } catch (error) {
        // `PathDenied`'s message quotes back the path the model itself wrote —
        // an echo of the caller's own output, not foreign content, which is
        // why this stays tier 0 rather than inheriting DISK_TIER (ADR-0044):
        // nothing has been read off disk yet, only a path has been checked.
        return {
          content: error instanceof PathDenied ? error.message : `percorso non valido: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          tier: 0,
        };
      }

      const filename = basename(resolved);
      const outcome = await deps.deliverFile(ctx.replyChannel, {
        absolutePath: resolved,
        filename,
        ...(parsed.data.caption ? { caption: parsed.data.caption } : {}),
      });

      // The whole point of this slice: a failed delivery must never read as
      // "inviato". `outcome.delivered` is a value the surface constructed on
      // purpose (core/surface/types.ts), never inferred from the absence of a
      // thrown exception.
      return outcome.delivered
        ? { content: `inviato: ${filename}`, tier: 0 }
        : { content: `NON inviato: ${outcome.why}`, isError: true, tier: 0 };
    },
  };
}
