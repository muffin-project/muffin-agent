#!/usr/bin/env node
/**
 * Registra localmente il driver `mappa-regen` e gli hook della mappa
 * (`.githooks/`, vedi lì per cosa fanno). Girato da `npm run prepare`, quindi
 * da ogni `npm ci`/`npm install`, così ogni worktree lo ottiene senza un
 * passo separato da ricordare.
 *
 * Perché non basta `.gitattributes`/`.githooks/` da soli: la definizione di
 * un merge driver vive per forza in `.git/config`, mai in un file versionato
 * (vedi `git help gitattributes`, sezione "Defining a custom merge driver") —
 * Git non fa girare comandi arbitrari solo perché un file tracciato lo
 * chiede. E `core.hooksPath` è anch'esso solo locale. Un clone su cui questo
 * script non è mai girato resta sul comportamento di Git di default: merge
 * testuale su questi due file, nessun hook — degrada a quello che c'era
 * prima di questo meccanismo, non fonde mai alla cieca (verificato in
 * laboratorio prima di scrivere questo file, vedi il PR).
 *
 * Idempotente e silenzioso fuori da un repo Git (es. pacchetto installato
 * come dipendenza): non deve mai far fallire `npm install`.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAPPA = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(MAPPA, '..', '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

if (!existsSync(join(REPO, '.git'))) {
  process.exit(0); // non è un checkout Git (es. tarball npm) — niente da fare
}

try {
  // `true` = tieni "ours", nessun conflitto testuale mai mostrato su questi
  // due file. Il contenuto corretto arriva un istante dopo da post-merge-regen.mjs.
  git(['config', '--local', 'merge.mappa-regen.name', 'tieni "ours" sui derivati della mappa — il contenuto vero arriva da post-merge-regen.mjs']);
  git(['config', '--local', 'merge.mappa-regen.driver', 'true']);

  const hooks = join(REPO, '.githooks');
  if (existsSync(hooks)) {
    git(['config', '--local', 'core.hooksPath', '.githooks']);
    for (const f of readdirSync(hooks)) chmodSync(join(hooks, f), 0o755);
  }

  console.log('mappa: merge driver e hook registrati in .git/config (locale a questo checkout).');
} catch (e) {
  // Non bloccare mai l'installazione per questo: è un'ottimizzazione, non una
  // garanzia — la garanzia resta ancore.mjs/mappa.test.ts in CI.
  console.warn(`mappa: registrazione locale saltata (${e.message.split('\n')[0]}).`);
}
