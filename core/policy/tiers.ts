/**
 * Approval tiers (ADR-0103 ratified): what consumes an `ask` without the owner.
 *
 * Order is the guarantee, and deny-first is what makes an allow-list safe to
 * keep: deny rules (explicit or critical-path) can never be outranked by a
 * broader allow, and a sandbox boundary substitutes for a prompt but never
 * for a deny. Anything unlisted asks exactly as before — tiers remove prompts,
 * never decisions.
 */
export type ApprovalTiers = {
  /** Exact commands or `prefix*` globs, matched against the trimmed command. */
  autoAllow: readonly string[];
  /** Same shape. Wins over allow, always. */
  deny: readonly string[];
};

export type TierVerdict = 'allow' | 'deny' | 'ask';

/** `pattern*` is a prefix; anything else is an exact trimmed match. */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const trimmed = command.trim();
  if (pattern.endsWith('*')) return trimmed.startsWith(pattern.slice(0, -1));
  return trimmed === pattern;
}

/**
 * Critical shell paths, v1: recursive-force remove aimed at root, home, or
 * a device, plus raw disk writes. Narrow on purpose — this list only ever
 * grows by explicit decision, and everything on it asks no matter what.
 */
export function isCriticalShellCommand(command: string): boolean {
  // One optional `sudo` prefix; anything stranger stays fully manual.
  const cmd = command.trim().replace(/^sudo\s+/, '');
  if (/(^|[\s;&|])dd\s+.*\bof=\/dev\//.test(` ${cmd}`)) return true;
  const rmMatch = /(^|[\s;&|])rm\s+((?:-[^\s;|&]*\s+)*)(\S(?:.*\S)?)\s*$/.exec(` ${cmd}`);
  if (rmMatch === null) return false;
  // Flags arrive in clusters (`-rf`, `-frx`): letters anywhere in the flag
  // run count, not word boundaries inside it.
  const letters = (rmMatch[2] ?? '').replace(/[^a-z]/gi, '');
  const target = rmMatch[3] ?? '';
  if (!/r/i.test(letters) || !/f/i.test(letters)) return false;
  return /^(~|\$HOME(\/.*)?|\/(\*.*)?)$/.test(target);
}

/**
 * Which tier answers this ask. `command` is the shell command text when the
 * capability carries one, else undefined (tiers only speak shell today).
 * `sandboxed` comes from the capability declaration, never inferred.
 */
export function decideApprovalTier(args: {
  command: string | undefined;
  sandboxed: boolean;
  tiers: ApprovalTiers;
}): TierVerdict {
  const { command, sandboxed, tiers } = args;
  if (command !== undefined) {
    if (isCriticalShellCommand(command)) return 'ask';
    if (tiers.deny.some((pattern) => matchCommandPattern(pattern, command))) return 'deny';
    if (tiers.autoAllow.some((pattern) => matchCommandPattern(pattern, command))) return 'allow';
  }
  if (sandboxed) return 'allow';
  return 'ask';
}
