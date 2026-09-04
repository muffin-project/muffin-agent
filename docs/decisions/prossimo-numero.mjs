#!/usr/bin/env node
/**
 * Il prossimo numero ADR libero — guardando **ogni ramo remoto**, non solo `dev`.
 *
 * `adr.test.ts` sa dire che due ADR condividono un numero, ma solo dopo che
 * entrambi sono su `dev`: due PR verdi separatamente producono un `dev` rosso,
 * e ogni ramo aperto diventa rosso con lui. È successo due volte il 04/09/2026
 * (0062, poi 0065) e la seconda dopo che il numero era già stato dato a voce.
 *
 * Il numero preso su un ramo **non ancora integrato** è preso lo stesso: è
 * l'unica differenza che conta fra questo script e un `ls docs/decisions/`.
 */
import { execSync } from 'node:child_process';

/**
 * Il massimo usato più uno — **non** il primo buco.
 *
 * Un ADR ritirato lascia il suo numero bruciato: il file sparisce, ma le
 * citazioni no (commit, PR, commenti nel codice, altri ADR). Riusare 0003
 * perché il file non c'è più fa puntare quelle citazioni a una decisione
 * diversa, in silenzio. Un buco costa un numero; un numero riusato costa la
 * tracciabilità di tutto ciò che lo citava.
 */
export function prossimoLibero(presi) {
  const set = presi instanceof Set ? presi : new Set(presi);
  return set.size === 0 ? 1 : Math.max(...set) + 1;
}

/** I numeri già usati, presi da ogni ramo che `elencaRami` nomina. */
export function numeriPresi(elencaRami, fileDiRamo) {
  const presi = new Set();
  for (const ramo of elencaRami()) {
    for (const file of fileDiRamo(ramo)) {
      const m = /(?:^|\/)(\d{4})-/.exec(file);
      if (m !== null) presi.add(Number(m[1]));
    }
  }
  return presi;
}

const ramiRemoti = () =>
  execSync('git ls-remote --heads origin', { encoding: 'utf8' })
    .split('\n')
    .map((r) => r.split('\t')[1])
    .filter(Boolean)
    .map((r) => r.replace('refs/heads/', ''));

const decisioniDi = (ramo) => {
  try {
    return execSync(`git ls-tree -r --name-only origin/${ramo} docs/decisions/`, { encoding: 'utf8' }).split('\n');
  } catch {
    // Un ramo elencato da `ls-remote` ma non recuperato in locale non è un
    // guasto: è un ramo che questo checkout non ha. Saltarlo però può far
    // proporre un numero preso là, quindi lo dice invece di tacere.
    process.stderr.write(`prossimo-numero: ${ramo} non recuperato — fai 'git fetch origin --prune'\n`);
    return [];
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(String(prossimoLibero(numeriPresi(ramiRemoti, decisioniDi))).padStart(4, '0'));
}
