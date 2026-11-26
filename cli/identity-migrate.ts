import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authoredText,
  resolveIdentityLayers,
  SHIPPED_IDENTITY,
  USER_OVERLAY_TOKEN_BUDGET,
} from '../agent/context/identity.js';
import { estimateTokens } from '../agent/context/tokens.js';
import { paths } from '../core/config/config.js';
import { tightenPrivateFile } from '../core/config/private-fs.js';
import { backupOwnerConfigFile } from '../core/rot/backup.js';

/**
 * The assisted cut-over of ADR-0112 (amendment of 26/11/2026): from a
 * hand-edited `~/.muffin/rot/identity.md` to the shipped foundation plus
 * `~/.muffin/user.md`, without asking the owner to diff two files by hand.
 *
 * Lives in `cli/`, not next to `resolveIdentityLayers`: it is the one product
 * path that writes `user.md`, and only an owner-invoked command may do that
 * (the agent never does — ADR-0112 point 3). It writes nothing unless the
 * owner applies it, never overwrites an existing `user.md`, never touches
 * `rot/identity.md` (it stays where it is, backed up, and is simply no longer
 * read), and refuses a result over the overlay's token ceiling instead of
 * writing a file the prompt would then leave out whole.
 */

export type IdentityMigrationPlan =
  /** Nothing to do: the home already reads the product foundation. */
  | { kind: 'not-needed'; reason: string }
  /** The home copy still replaces the foundation; these are the owner's lines. */
  | {
      kind: 'ready';
      homeCopy: string;
      userFile: string;
      /** Lines that no shipped foundation version contains, with their nearest heading for context. */
      lines: string[];
      /** What would be written to `user.md` (header comment + lines). */
      text: string;
      tokens: number;
      overBudget: boolean;
    };

/** Whitespace-insensitive identity of a line, for comparing owner text to shipped text. */
function key(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function headingOf(line: string): boolean {
  return /^#{1,6}\s/.test(line.trim());
}

/**
 * The owner's own lines: those of the home copy that appear in no known
 * shipped foundation. `foundations` are authored texts — the current shipped
 * file plus, when a checkout is available, every version it has ever had,
 * so lines of an *older* foundation copied by an old `init` are not mistaken
 * for the owner's. A foundation heading is kept only right above an owner
 * line that sits under it, so the line keeps its context.
 */
export function ownerLines(homeText: string, foundations: readonly string[]): string[] {
  const shipped = new Set<string>();
  for (const text of foundations) {
    for (const line of text.split('\n')) {
      const k = key(line);
      if (k !== '') shipped.add(k);
    }
  }
  const out: string[] = [];
  let pendingHeading: string | null = null;
  for (const line of homeText.split('\n')) {
    const k = key(line);
    if (k === '') continue;
    const fromProduct = shipped.has(k);
    if (headingOf(line)) {
      if (fromProduct) {
        // A document title (`# …`) is not context for a line; a section is.
        pendingHeading = /^#\s/.test(line.trim()) ? null : line.trim();
        continue;
      }
      pendingHeading = null;
      if (out.length > 0) out.push('');
      out.push(line.trim());
      continue;
    }
    if (fromProduct) continue;
    if (pendingHeading !== null) {
      if (out.length > 0) out.push('');
      out.push(pendingHeading);
      pendingHeading = null;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function userFileText(lines: readonly string[], now: Date, backup: string | null): string {
  const header = [
    '<!--',
    `  Le tue preferenze personali (ADR-0112). Le ha spostate qui \`muffin rot migrate\``,
    `  il ${now.toISOString().slice(0, 10)} dalla tua copia di rot/identity.md${backup ? ` (backup: ${backup})` : ''}.`,
    '  Rileggile e tieni solo come vuoi essere aiutato: il resto del carattere',
    '  arriva dalla fondazione del prodotto e si aggiorna con `muffin update`.',
    '  Questo commento non entra nel prompt.',
    '-->',
  ].join('\n');
  return lines.length === 0 ? `${header}\n` : `${header}\n\n${lines.join('\n')}\n`;
}

export type PlanOptions = {
  /** The shipped foundation file. Default: the one this build ships. */
  shipped?: string;
  /** Older shipped foundation texts (raw), e.g. from Git history. */
  history?: readonly string[];
  now?: Date;
};

export function planIdentityMigration(home: string, opts: PlanOptions = {}): IdentityMigrationPlan {
  const shipped = opts.shipped ?? SHIPPED_IDENTITY;
  const layers = resolveIdentityLayers(home, shipped);
  if (layers.mode === 'foundation') {
    return { kind: 'not-needed', reason: 'la fondazione arriva già dal prodotto' };
  }
  if (layers.mode === 'foundation+user') {
    return { kind: 'not-needed', reason: '~/.muffin/user.md esiste già: non lo sovrascrivo' };
  }
  if (layers.foundationMissing) {
    return {
      kind: 'not-needed',
      reason:
        'questa build non contiene defaults/rot/identity.md: non c’è una fondazione con cui confrontare',
    };
  }
  const p = paths(home);
  const homeCopy = join(p.rot, 'identity.md');
  const foundations = [readFileSync(shipped, 'utf8'), ...(opts.history ?? [])].map(authoredText);
  const lines = ownerLines(layers.pact.text, foundations);
  const text = userFileText(lines, opts.now ?? new Date(), null);
  const tokens = estimateTokens(authoredText(text));
  return {
    kind: 'ready',
    homeCopy,
    userFile: p.user,
    lines,
    text,
    tokens,
    overBudget: tokens > USER_OVERLAY_TOKEN_BUDGET,
  };
}

export type AppliedMigration = { userFile: string; backup: string | null };

/**
 * Backs up the home copy, then creates `user.md` (0600, exclusive create: a
 * `user.md` that appeared meanwhile is never overwritten). The home copy is
 * left in place; with `user.md` present `resolveIdentityLayers` stops reading
 * it, which is the whole activation.
 */
export function applyIdentityMigration(
  home: string,
  plan: Extract<IdentityMigrationPlan, { kind: 'ready' }>,
  now: Date = new Date(),
): AppliedMigration {
  if (plan.overBudget) {
    throw new Error(
      `le righe tue stimano ${String(plan.tokens)} token, oltre il tetto di ${String(USER_OVERLAY_TOKEN_BUDGET)} di user.md`,
    );
  }
  if (existsSync(plan.userFile)) {
    throw new Error(`${plan.userFile} esiste già: non lo sovrascrivo`);
  }
  const backup = backupOwnerConfigFile(home, plan.homeCopy, now);
  writeFileSync(plan.userFile, userFileText(plan.lines, now, backup), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  tightenPrivateFile(plan.userFile);
  return { userFile: plan.userFile, backup };
}
