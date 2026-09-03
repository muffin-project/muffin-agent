#!/usr/bin/env node
/**
 * Rigenera `ancore.json`/`mappa.html` dopo un `git merge` o `git rebase`
 * COMPLETATO, e stage+committa il risultato se è cambiato. Chiamato dagli
 * hook `.githooks/post-merge` e `.githooks/post-rewrite`, mai a mano.
 *
 * Perché non succede DURANTE il merge (niente merge driver qui): Git decide
 * un merge risolvendo l'indice senza garantire che ogni altro percorso sia
 * già scritto su disco (o perfino nell'indice) nel momento in cui gira un
 * merge driver personalizzato per UN percorso in conflitto. Misurato in
 * laboratorio prima di scegliere questo design: un driver che rigenerava
 * `ancore.json` durante il merge una volta ha letto un file sorgente citato
 * ancora alla sua versione pre-merge — non in conflitto, solo non ancora
 * scritto — e ha prodotto un numero di riga sbagliato in un merge dichiarato
 * riuscito. Qui, invece, l'operazione è già finita: l'albero di lavoro è
 * garantito completo, quindi è l'unico momento in cui rigenerare è corretto.
 *
 * `.gitattributes` marca i due file con `merge=mappa-regen`, configurato
 * (in `setup-merge-driver.mjs`) come il driver `true`: durante il merge
 * vero e proprio si tiene semplicemente "ours", senza mai mostrare a un
 * umano un conflitto testuale su un blob generato di 289 KB — questo script
 * lo sostituisce con il contenuto corretto un istante dopo.
 *
 * La garanzia sul drift genuino non cambia: rilancia `ancore.mjs`, la stessa
 * identica logica di `mappa.test.ts` e CI. Se segnala riferimenti rotti o
 * una voce "cambiata, non spostata", questo script si ferma senza committare
 * nulla — mai un auto-fix silenzioso su un drift vero.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPPA = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(MAPPA, '..', '..', '..');
const GESTITI = ['docs/derived/architecture-map/ancore.json', 'docs/derived/architecture-map/mappa.html'];

function git(args) {
  return spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

// A metà di un rebase interattivo multi-step questo hook può girare più
// volte prima che l'operazione sia davvero finita: aspetta l'ultima.
if (
  spawnSync('test', ['-d', `${REPO}/.git/rebase-merge`]).status === 0 ||
  spawnSync('test', ['-d', `${REPO}/.git/rebase-apply`]).status === 0
) {
  process.exit(0);
}

const anc = spawnSync(process.execPath, [`${MAPPA}/ancore.mjs`], { cwd: REPO, stdio: 'inherit' });
if (anc.status !== 0) {
  console.error('\npost-merge-regen: la mappa segnala riferimenti rotti o drift genuino (vedi sopra).');
  console.error('Non ho committato nulla. Rivedi le voci, poi `npm run mappa:regen`.');
  process.exit(1);
}

const build = spawnSync(process.execPath, [`${MAPPA}/build.mjs`], { cwd: REPO, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('post-merge-regen: build.mjs è fallito, mappa.html non aggiornato.');
  process.exit(1);
}

const diff = git(['status', '--porcelain', '--', ...GESTITI]);
if (!diff.stdout?.trim()) {
  console.log('post-merge-regen: la mappa era già allineata, nessun commit necessario.');
  process.exit(0);
}

git(['add', ...GESTITI]);
const commit = git(['commit', '-m', 'chore(docs): regenerate architecture map after merge [auto]']);
if (commit.status === 0) {
  console.log('post-merge-regen: mappa rigenerata e committata.');
} else {
  console.error('post-merge-regen: rigenerata e messa in stage, ma il commit è fallito:');
  console.error(commit.stderr || commit.stdout);
  console.error('Completa a mano: `git commit`.');
}
