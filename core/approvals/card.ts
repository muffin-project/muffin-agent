import type { TrustTier } from '../policy/types.js';

/**
 * Shared human wording for an approval card, used by Telegram and the CLI.
 *
 * The kernel still records the technical prompt (`taint`, capability id,
 * "parametri scelti dal contenuto") in logs and in `ApprovalRequest.prompt`.
 * Surfaces must not show that jargon: the owner sees what the action is, why
 * a confirmation is needed when that reason is real, and the exact object of
 * the action, untruncated.
 */

export type ApprovalCardInput = {
  capability: string;
  prompt: string;
  resource?: string | undefined;
  description?: string | undefined;
  taint: TrustTier;
};

export type ApprovalActionKind = 'read' | 'command' | 'send' | 'other';

export type ApprovalCard = {
  kind: ApprovalActionKind;
  /** The question, in Italian: what Muffin wants to do. */
  what: string;
  /** Why a confirmation is needed, or null when there is no real reason to add. */
  why: string | null;
  /** Model-written account of the action, when the tool supplied one. */
  description: string | null;
  /** The exact object (URL, command, recipient), never truncated. */
  object: string | null;
  allowLabel: string;
  denyLabel: 'Rifiuta';
};

const DENY_LABEL = 'Rifiuta' as const;

export function actionKindOf(capability: string): ApprovalActionKind {
  if (capability === 'sys.http') return 'read';
  if (
    capability === 'sys.shell' ||
    capability === 'sys.shell.write' ||
    capability === 'sys.process.kill'
  ) {
    return 'command';
  }
  if (capability === 'outward.send' || capability.startsWith('outward.')) return 'send';
  return 'other';
}

export function allowLabelFor(capability: string): string {
  const kind = actionKindOf(capability);
  if (kind === 'read') return 'Consenti la lettura';
  if (kind === 'command') return 'Consenti il comando';
  if (kind === 'send') return "Consenti l'invio";
  return 'Consenti';
}

export function resolutionLine(capability: string, allowed: boolean): string {
  const kind = actionKindOf(capability);
  const verb =
    kind === 'read'
      ? 'lettura'
      : kind === 'command'
        ? 'comando'
        : kind === 'send'
          ? 'invio'
          : 'azione';
  return `${verb}: ${allowed ? 'consentito' : 'rifiutato'}`;
}

function urlFrom(resource: string | undefined): string | undefined {
  if (resource === undefined) return undefined;
  const trimmed = resource.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  const match = trimmed.match(/https?:\/\/\S+/i);
  return match?.[0];
}

function recipientFrom(resource: string | undefined): string | undefined {
  if (resource === undefined || resource.trim() === '') return undefined;
  const trimmed = resource.trim();
  const line = trimmed.split('\n')[0]?.trim();
  return line === undefined || line === '' ? undefined : line;
}

function isIrreversible(prompt: string, kind: ApprovalActionKind): boolean {
  if (kind === 'command' || kind === 'send') {
    // Kernel wording (ADR-0074) or an explicit irreversibility claim.
    return /non si torna indietro|non si può annullare|non si puo annullare|irreversibil/i.test(
      prompt,
    );
  }
  return false;
}

/**
 * Build the card the owner actually reads. Never includes `taint`, `livello`,
 * capability ids such as `sys.http`, or "parametri scelti dal contenuto".
 */
export function formatApprovalCard(input: ApprovalCardInput): ApprovalCard {
  const kind = actionKindOf(input.capability);
  const object =
    input.resource !== undefined && input.resource.trim() !== '' ? input.resource : null;
  const description =
    input.description !== undefined && input.description.trim() !== ''
      ? input.description.trim()
      : null;

  let what: string;
  if (kind === 'read') {
    const url = urlFrom(input.resource);
    what = url === undefined ? 'Vuoi che legga questo indirizzo?' : `Vuoi che legga ${url}?`;
  } else if (kind === 'command') {
    what = 'Vuoi che esegua questo comando?';
  } else if (kind === 'send') {
    const to = recipientFrom(input.resource);
    what =
      to === undefined
        ? 'Vuoi che invii questo messaggio?'
        : `Vuoi che invii questo messaggio a ${to}?`;
  } else {
    what = 'Vuoi che proceda con questa azione?';
  }

  const irreversible = isIrreversible(input.prompt, kind);
  let why: string | null = null;
  if (kind === 'read' && input.taint >= 2) {
    why =
      "Te lo chiedo perché in questo turno c'è contenuto preso dal web o da un gruppo, e l'indirizzo l'ho composto io.";
  } else if (irreversible) {
    why = 'Questo comando non si può annullare.';
    if (input.taint >= 2) {
      why +=
        " Te lo chiedo anche perché in questo turno c'è contenuto preso dal web o da un gruppo.";
    }
  } else if (input.taint >= 2) {
    why = "Te lo chiedo perché in questo turno c'è contenuto preso dal web o da un gruppo.";
  }

  return {
    kind,
    what,
    why,
    description,
    object,
    allowLabel: allowLabelFor(input.capability),
    denyLabel: DENY_LABEL,
  };
}

/** Plain-text rendering for the CLI and for Telegram's unmarkup twin. */
export function renderApprovalCardPlain(input: ApprovalCardInput): string {
  const card = formatApprovalCard(input);
  const lines = [`⚠ ${card.what}`];
  if (card.why !== null) lines.push(card.why);
  if (card.description !== null) lines.push(card.description);
  if (card.object !== null) lines.push(card.object);
  return lines.join('\n\n');
}

/**
 * Strings that must never appear in owner-facing approval text. The object of
 * the action (a URL, a command) is not checked: it is the owner's to read.
 */
export const FORBIDDEN_APPROVAL_JARGON = [
  'taint',
  'livello 3',
  'sys.http',
  'sys.shell',
  'parametri scelti dal contenuto',
] as const;

export function approvalCardShowsJargon(text: string, object: string | null): boolean {
  const inspected =
    object !== null && object !== '' && text.includes(object) ? text.replace(object, '') : text;
  const lower = inspected.toLowerCase();
  return FORBIDDEN_APPROVAL_JARGON.some((needle) => lower.includes(needle.toLowerCase()));
}
