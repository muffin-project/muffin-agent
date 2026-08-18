#!/usr/bin/env node
/**
 * Il handoff non deve raccontare lavoro già fatto.
 *
 * Dopo ogni merge in `dev` tre documenti devono tornare veri **insieme**:
 * `docs/blueprint/gate1/PERCORSO-CRITICO.md` (la sequenza), l'evidenza per riga
 * di `docs/blueprint/M5-BIS.md` (il perché di ogni BLOCKER) e il blocco START
 * HERE di `docs/blueprint/STATE.md` (dove siamo). Incrementare il contatore
 * delle righe non basta: una sessione fresca che apre `/loop` legge il percorso
 * critico, e se là dentro c'è scritto «in volo: #53» quando #53 è mergiata da
 * ore, quella sessione va a lavorare su lavoro già fatto.
 *
 * È il difetto che l'owner ha trovato il 2026-08-17 e la ragione di questo file:
 * la regola esisteva come buona intenzione in `BRANCHING.md`, e una buona
 * intenzione non è un controllo. Questo script è il controllo — meccanico,
 * senza rete quando gli si passa uno stato già letto, e con un solo verdetto.
 *
 * Cosa verifica, e nient'altro:
 *
 *  1. **Nessuna PR mergiata (o chiusa) è descritta come in volo.** Ogni `#NN`
 *     che appare nella sezione «In volo adesso» del percorso critico, o accanto
 *     alle parole «in giudizio»/«in volo»/«in corso» in STATE/LAVORO, deve
 *     essere una PR ancora aperta.
 *  2. **Nessun branch nominato come in volo è già sparito.** Un `slice/...`
 *     citato in quella sezione deve esistere su `origin` (se è stato mergiato e
 *     cancellato, la riga è stale per costruzione).
 *  3. **Il commit di base dichiarato in testa al percorso critico esiste ed è
 *     un antenato di `HEAD`** — così «base dev @ <sha>» non resta indietro di
 *     dieci merge.
 *
 * Non giudica il *contenuto* delle motivazioni: nessuno script può stabilire se
 * la ragione scritta accanto a un BLOCKER è ancora quella vera. Quella parte
 * resta un lavoro di lettura, e `BRANCHING.md` checkpoint 4 la nomina.
 *
 * Uso:
 *   node .claude/riconcilia.mjs            # interroga `gh` per lo stato PR
 *   node .claude/riconcilia.mjs --stato f  # legge lo stato da un JSON (test/CI)
 *
 * Esce 0 quando i documenti sono riconciliati, 1 quando no (con l'elenco), 2 se
 * non riesce a stabilirlo (nessun `gh`, nessun `--stato`): «non lo so» non deve
 * mai passare per «va bene».
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PERCORSO = 'docs/blueprint/gate1/PERCORSO-CRITICO.md';
const ALTRI = ['docs/blueprint/STATE.md', 'docs/blueprint/LAVORO.md'];

/** «## 0 · In volo adesso» fino al titolo successivo. */
export function sezioneInVolo(testo) {
  const righe = testo.split('\n');
  const inizio = righe.findIndex((r) => /^##\s.*in volo/i.test(r));
  if (inizio === -1) return '';
  const dopo = righe.slice(inizio + 1).findIndex((r) => /^##\s/.test(r));
  return righe.slice(inizio, dopo === -1 ? undefined : inizio + 1 + dopo).join('\n');
}

/**
 * Le righe **logiche**: un elenco puntato o un paragrafo restano una cosa sola
 * anche quando il markdown li manda a capo a 80 colonne.
 *
 * Serve perché i marcatori («integrate», «in volo») stanno quasi sempre in testa
 * e i numeri di PR quasi sempre più avanti: leggendo riga per riga, la
 * continuazione di «Integrate oggi: #53 · #54 · …» perde il suo contesto e
 * ogni PR appena mergiata torna a sembrare lavoro vivo. Misurato su questo
 * stesso file il 17/08: cinque falsi reperti.
 */
export function righeLogiche(corpo) {
  const out = [];
  for (const riga of corpo.split('\n')) {
    // `#{1,6}\s` e non `#`: `#56` è una PR, non un titolo — ed è esattamente
    // l'errore che ha prodotto quattro falsi reperti la prima volta.
    const nuova = riga.trim() === '' || /^\s*([-*+]\s|\d+\.\s|\||#{1,6}\s|>)/.test(riga) || out.length === 0;
    if (nuova) out.push(riga);
    else out[out.length - 1] += ` ${riga.trim()}`;
  }
  return out;
}

/**
 * Le PR dichiarate vive: quelle nella sezione «in volo», più quelle che in
 * qualunque documento del handoff stanno nella stessa riga logica di «in
 * giudizio», «in volo» o «in corso». Un `#NN` in una cronaca («il 16/08 sono
 * entrate #28/#29») non è una dichiarazione di lavoro vivo e non va contato.
 */
export function prDichiarateVive(documenti) {
  const trovate = new Map(); // numero -> [dove]
  const aggiungi = (numero, dove) => {
    const lista = trovate.get(numero) ?? [];
    if (!lista.includes(dove)) lista.push(dove);
    trovate.set(numero, lista);
  };
  for (const { nome, testo, soloSezione } of documenti) {
    const corpo = soloSezione ? sezioneInVolo(testo) : testo;
    for (const riga of righeLogiche(corpo)) {
      // Anche dentro la sezione «in volo» una riga può elencare ciò che è
      // appena *entrato* — è utile al lettore umano e non è una dichiarazione
      // di lavoro vivo. Senza questa esclusione il controllo segnalava come
      // stale la riga che lo teneva aggiornato, che è il modo più rapido per
      // farlo disattivare da qualcuno.
      if (/integrat|mergiat|già dentro|chius[ae]|\bfatto\b/i.test(riga)) continue;
      const vivo = soloSezione || /in giudizio|in volo|in corso/i.test(riga);
      if (!vivo) continue;
      // Fino a quattro cifre: i riferimenti lunghi in questo repo sono
      // identificatori di paper e commit, non PR (`arXiv:2605.17062`).
      for (const m of riga.matchAll(/(?:^|[\s(«"'`])#(\d{1,4})\b/g)) aggiungi(Number(m[1]), nome);
    }
  }
  return trovate;
}

/** I branch `slice/...` nominati come in volo. */
export function branchDichiarativi(testo) {
  const trovati = new Set();
  for (const m of sezioneInVolo(testo).matchAll(/`?(slice\/[a-z0-9][a-z0-9-]*)`?/g)) trovati.add(m[1]);
  return [...trovati];
}

/** «base `dev` @ `<sha>`» in testa al percorso critico, se dichiarata. */
export function baseDichiarata(testo) {
  const m = /base\s+`?dev`?\s*@\s*`?([0-9a-f]{7,40})`?/i.exec(testo);
  return m ? m[1] : null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Stato delle PR da `gh`, o null se `gh` non è utilizzabile qui.
 *
 * Una sola chiamata di lista, non una `pr view` per numero: un numero che non
 * corrisponde a nessuna PR — un refuso, o un `#123` che era un'altra cosa — non
 * deve far fallire l'intero controllo. Quello che non compare resta semplicemente
 * sconosciuto, e `riconcilia` lo salta.
 */
function statoDaGh() {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const stato = {};
    for (const pr of JSON.parse(out)) stato[pr.number] = { state: pr.state, headRefName: pr.headRefName };
    return stato;
  } catch {
    return null;
  }
}

/**
 * Il controllo, puro: riceve i documenti e lo stato, restituisce i reperti.
 * `branchRemoti` è la lista dei branch che esistono su `origin`; `antenati` dice
 * se lo sha dichiarato è un antenato di HEAD (null = non verificabile).
 */
export function riconcilia({ documenti, statoPr, branchRemoti, base, baseEsiste, baseAntenata }) {
  const reperti = [];
  const vive = prDichiarateVive(documenti);
  for (const [numero, dove] of vive) {
    const stato = statoPr[numero];
    if (!stato) continue; // non interrogabile: riportato a parte dal chiamante
    if (stato.state !== 'OPEN') {
      reperti.push(
        `#${numero} è ${stato.state === 'MERGED' ? 'mergiata' : 'chiusa'} ma ${dove.join(', ')} la descrive come lavoro in volo`,
      );
    }
  }
  const percorso = documenti.find((d) => d.soloSezione);
  if (percorso) {
    for (const branch of branchDichiarativi(percorso.testo)) {
      if (!branchRemoti.includes(branch)) {
        reperti.push(`\`${branch}\` è nominato fra il lavoro in volo ma non esiste su origin (mergiato e cancellato?)`);
      }
    }
    if (base !== null) {
      if (baseEsiste === false) reperti.push(`la base dichiarata \`${base}\` non è un commit di questo repo`);
      else if (baseAntenata === false) reperti.push(`la base dichiarata \`${base}\` non è un antenato di HEAD: il percorso critico è indietro`);
    }
  }
  return reperti;
}

function main() {
  const radice = git(['rev-parse', '--show-toplevel']);
  const leggi = (p) => readFileSync(join(radice, p), 'utf8');
  const documenti = [
    { nome: PERCORSO, testo: leggi(PERCORSO), soloSezione: true },
    ...ALTRI.map((p) => ({ nome: p, testo: leggi(p), soloSezione: false })),
  ];

  const argIdx = process.argv.indexOf('--stato');
  const numeri = [...prDichiarateVive(documenti).keys()];
  const statoPr = argIdx !== -1 ? JSON.parse(readFileSync(process.argv[argIdx + 1], 'utf8')) : statoDaGh();
  if (statoPr === null) {
    process.stderr.write(
      `non riesco a leggere lo stato delle PR (\`gh\` assente o non autenticato): non posso dire se il handoff è riconciliato.\n` +
        `→ passa uno stato letto altrove: node .claude/riconcilia.mjs --stato <file.json>\n`,
    );
    process.exit(2);
  }

  const base = baseDichiarata(documenti[0].testo);
  let baseEsiste = null;
  let baseAntenata = null;
  if (base !== null) {
    try {
      git(['cat-file', '-e', `${base}^{commit}`]);
      baseEsiste = true;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { stdio: 'ignore' });
        baseAntenata = true;
      } catch {
        baseAntenata = false;
      }
    } catch {
      baseEsiste = false;
    }
  }

  const branchRemoti = git(['ls-remote', '--heads', 'origin'])
    .split('\n')
    .map((r) => r.split('refs/heads/')[1])
    .filter(Boolean);

  const reperti = riconcilia({ documenti, statoPr, branchRemoti, base, baseEsiste, baseAntenata });
  if (reperti.length === 0) {
    process.stdout.write(`handoff riconciliato: ${numeri.length} PR dichiarate vive, tutte aperte; base e branch coerenti\n`);
    process.exit(0);
  }
  process.stdout.write(`handoff NON riconciliato (${reperti.length}):\n${reperti.map((r) => `  · ${r}`).join('\n')}\n`);
  process.stderr.write(
    `\n→ aggiorna ${PERCORSO} §«In volo adesso», l'evidenza delle righe M5-BIS toccate e il blocco START HERE di STATE.md\n` +
      `  (BRANCHING.md checkpoint 4: la riconciliazione fa parte del merge, non è un lavoro successivo)\n`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
