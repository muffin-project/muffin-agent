#!/usr/bin/env node
/**
 * Il censimento dei rami, in tre gruppi — e il terzo è l'unico che conta.
 *
 * Il 04/09/2026 il repository aveva 30 worktree, 90 rami locali e 45 remoti.
 * Nella pulizia sono saltati fuori sei commit di **undo semantico** — il punto
 * 5 del percorso critico — su un ramo chiamato
 * `worktree-agent-ae7010a13828febbd`, cioè un nome che nessuno avrebbe mai
 * aperto per curiosità. Non erano sporcizia: erano lavoro finito e perso di
 * vista, e sono stati ritrovati per caso mentre si cancellava altro.
 *
 * Da qui i tre gruppi:
 *
 *  - **integrati** — ogni commit è già dentro `origin/dev`. Cancellarli non
 *    perde niente, e `--pulisci` lo fa.
 *  - **in lavorazione** — hanno una PR aperta. Si lasciano stare.
 *  - **abbandonati** — hanno commit che `dev` non ha *e* nessuna PR aperta.
 *    **Questo gruppo è il difetto**, non un residuo: è lavoro che nessun
 *    processo sta più guardando. Lo script lo stampa con i suoi commit, perché
 *    un elenco di nomi non dice se dentro c'è una riga di roadmap.
 *
 * `node scripts/igiene.mjs` censisce; `--pulisci` cancella **solo** il primo
 * gruppo, mai il terzo: la cancellazione di lavoro non integrato è una
 * decisione, e questo script non la prende.
 */
import { execSync } from 'node:child_process';

/**
 * I tre gruppi, come funzione pura: `dentroDev(ref)` dice se ogni commit del
 * ramo e' gia in `dev`, `prAperte` sono i rami con una PR aperta.
 *
 * Pura perche' il verdetto e' la parte che conta e deve essere provabile senza
 * un repository finto: la raccolta dei dati e' shell, la classificazione no.
 */
export function classifica(rami, dentroDev, prAperte) {
  const integrati = [];
  const inLavorazione = [];
  const abbandonati = [];
  for (const b of rami) {
    if (dentroDev(b)) integrati.push(b);
    else if (prAperte.has(b)) inLavorazione.push(b);
    else abbandonati.push(b);
  }
  return { integrati, inLavorazione, abbandonati };
}


function main() {
  const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
  const righe = (cmd) => sh(cmd).split('\n').filter(Boolean);
  const pulisci = process.argv.includes('--pulisci');

  sh('git fetch origin --quiet --prune');

  const prAperte = new Set(
    (() => {
      try {
        return JSON.parse(sh('gh pr list --state open --limit 200 --json headRefName')).map((p) => p.headRefName);
      } catch {
        // Senza `gh` ogni ramo con lavoro finisce fra gli abbandonati. È il
        // verso giusto in cui sbagliare: segnala troppo, non cancella niente.
        process.stderr.write('igiene: `gh` non disponibile — le PR aperte non sono note\n');
        return [];
      }
    })(),
  );

  const locali = righe("git for-each-ref --format='%(refname:short)' refs/heads/");
  const remoti = righe('git ls-remote --heads origin').map((r) => r.split('refs/heads/')[1]);
  const tutti = [...new Set([...locali, ...remoti])].filter((b) => b !== 'main' && b !== 'dev').sort();

  const esiste = (r) => {
    try { sh(`git rev-parse --verify --quiet ${r}`); return true; } catch { return false; }
  };

  const dentroDev = (b) => {
    const ref = esiste(b) ? b : `origin/${b}`;
    if (!esiste(ref)) return true; // non esiste piu: niente da salvare
    try { execSync(`git merge-base --is-ancestor ${ref} origin/dev`, { stdio: 'ignore' }); return true; } catch { return false; }
  };

  const { integrati, inLavorazione, abbandonati: nomiAbbandonati } = classifica(tutti, dentroDev, prAperte);
  const abbandonati = nomiAbbandonati.map((nome) => {
    const ref = esiste(nome) ? nome : `origin/${nome}`;
    return { nome, commit: righe(`git log --oneline origin/dev..${ref}`).filter((l) => !/ Merge /.test(l)) };
  });

  console.log(`in lavorazione (PR aperta): ${inLavorazione.length}`);
  for (const b of inLavorazione) console.log(`  · ${b}`);

  console.log(`\nintegrati in dev: ${integrati.length}${pulisci ? '' : '  — `--pulisci` per cancellarli'}`);
  for (const b of integrati) {
    if (!pulisci) { console.log(`  · ${b}`); continue; }
    const inWorktree = sh('git worktree list --porcelain').includes(`branch refs/heads/${b}\n`);
    try { if (locali.includes(b) && !inWorktree) sh(`git branch -D ${b}`); } catch { /* già via */ }
    try { if (remoti.includes(b)) sh(`git push --quiet origin --delete ${b}`); } catch { /* già via */ }
    console.log(`  · ${b} — cancellato${inWorktree ? ' (solo remoto: il locale ha un worktree)' : ''}`);
  }

  console.log(`\nABBANDONATI — lavoro che dev non ha e che nessuna PR sta guardando: ${abbandonati.length}`);
  if (abbandonati.length === 0) console.log('  nessuno.');
  for (const { nome, commit } of abbandonati) {
    console.log(`  · ${nome}  (+${commit.length})`);
    for (const c of commit.slice(0, 4)) console.log(`      ${c}`);
    if (commit.length > 4) console.log(`      … e altri ${commit.length - 4}`);
  }
  if (abbandonati.length > 0) {
    console.log('\nOgnuno vuole un verdetto: ripreso, scartato con la ragione, o messo in `park/`');
    console.log('con un nome che dica cosa contiene. Restare in elenco non è un verdetto.');
  }

}

if (import.meta.url === `file://${process.argv[1]}`) main();
