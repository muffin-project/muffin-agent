import { existsSync, writeFileSync } from 'node:fs';
import { resolveIdentityLayers } from '../agent/context/identity.js';
import { paths } from '../core/config/config.js';
import { tightenPrivateFile } from '../core/config/private-fs.js';
import { backupOwnerConfigFile } from '../core/rot/backup.js';
import { displayInHome } from './home-display.js';

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
 * read). The only eligible text is the same proven appendix the runtime
 * already uses, within its existing overlay ceiling.
 */

export type IdentityMigrationPlan =
  | { kind: 'not-needed'; reason: string }
  | { kind: 'needs-review'; reason: string }
  | {
      kind: 'ready';
      homeCopy: string;
      userFile: string;
      text: string;
      tokens: number;
    };

function userFileText(text: string, now: Date, backup: string | null): string {
  const header = [
    '<!--',
    `  Le tue preferenze personali (ADR-0112). Le ha spostate qui \`muffin rot migrate\``,
    `  il ${now.toISOString().slice(0, 10)} dalla tua copia di rot/identity.md${backup ? ` (backup: ${backup})` : ''}.`,
    '  Rileggile e tieni solo come vuoi essere aiutato: il resto del carattere',
    '  arriva dalla fondazione del prodotto e si aggiorna con `muffin update`.',
    '  Questo commento non entra nel prompt.',
    '-->',
  ].join('\n');
  return `${header}\n\n${text}\n`;
}

export function planIdentityMigration(home: string): IdentityMigrationPlan {
  const layers = resolveIdentityLayers(home);
  switch (layers.mode) {
    case 'foundation':
      return { kind: 'not-needed', reason: 'la fondazione arriva già dal prodotto' };
    case 'foundation+user':
      return {
        kind: 'not-needed',
        reason: `${displayInHome(home, 'user.md')} esiste già: non lo sovrascrivo`,
      };
    case 'legacy-home':
      return layers.foundationMissing
        ? {
            kind: 'not-needed',
            reason: 'questa build non contiene defaults/rot/identity.md',
          }
        : {
            kind: 'needs-review',
            reason:
              'il patto personalizzato resta attivo. Passare alla fondazione può ripristinare indicazioni che avevi tolto ' +
              'o sostituire quelle che avevi riscritto. Puoi tenere il patto oppure scegliere quali preferenze portare nella nuova identità.',
          };
    case 'foundation+legacy-preferences': {
      const overlay = layers.user;
      if (overlay === null) throw new Error('Missing legacy preferences');
      return {
        kind: 'ready',
        homeCopy: overlay.file,
        userFile: paths(home).user,
        text: overlay.text,
        tokens: overlay.tokens,
      };
    }
  }
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
  if (existsSync(plan.userFile)) {
    throw new Error(`${plan.userFile} esiste già: non lo sovrascrivo`);
  }
  const current = planIdentityMigration(home);
  if (current.kind !== 'ready' || current.text !== plan.text) {
    throw new Error('le preferenze sono cambiate dopo l’anteprima: rivedi il patto e riprova');
  }
  const backup = backupOwnerConfigFile(home, current.homeCopy, now);
  writeFileSync(current.userFile, userFileText(current.text, now, backup), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  tightenPrivateFile(current.userFile);
  return { userFile: current.userFile, backup };
}
