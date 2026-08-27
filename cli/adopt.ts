import { copyFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCheckoutRoot } from './update.js';
import { PLAIN, type Style } from './ui.js';
import {
  REAL_GIT,
  diagnoseDefaultsDrift,
  installedPathOf,
  recordCopied,
  shippedPathOf,
  type DefaultDrift,
  type Git,
} from '../core/config/defaults-drift.js';

/**
 * `muffin adopt` — il verbo che mancava a una diagnosi già completa.
 *
 * `core/config/defaults-drift.ts` sa da mesi distinguere un file di `defaults/`
 * mai toccato da uno riscritto dall'owner, e `muffin doctor` lo stampa. Ma
 * quello che stampava era **una riga da incollare**: `cp <spedito> <installato>`.
 * Misurato sull'installazione dell'owner il 27/08, questo è ciò che quella riga
 * costa quando nessuno la incolla: `persona.md` è rimasto alla versione spedita
 * il 9 agosto per diciotto giorni, mentre la riscrittura che l'owner aveva
 * approvato stava in `defaults/` senza arrivare mai al prompt vero.
 *
 * Un comando che stampa il rimedio invece di eseguirlo non è più prudente: è
 * la stessa quantità di rischio, spostata su una persona che deve ricordarsene.
 *
 * ## E c'è una cosa che il `cp` a mano sbaglia sempre
 *
 * `recordCopied` registra l'hash di ciò che è stato copiato: è la regola 1 di
 * `defaults-drift.ts`, quella che non ha bisogno di Git. Un `cp` incollato a
 * mano non la aggiorna. Al giro dopo, quando HEAD si muove di nuovo,
 * l'installato non corrisponde più né a HEAD né all'hash registrato — e la
 * diagnosi dice **`owner-modified`**: «modificato dall'owner, non toccato».
 * Da quel momento quel file non è più adottabile e non lo sarà mai più, e la
 * ragione è che è stato adottato nel modo che sembrava innocuo.
 *
 * Quindi chi copia registra. È la stessa regola di `cli/init.ts` — non una
 * nuova — e vale al contrario per `muffin rot reseal`, che *non* copia e
 * infatti non deve registrare niente.
 *
 * ## Il sigillo resta dell'owner
 *
 * Questo comando **non scrive mai dentro `rot/`**. Non perché sia impossibile,
 * ma perché adottare lì dentro fa divergere l'hash sigillato e manda
 * l'installazione in safe mode finché non gira `muffin rot reseal` — un atto
 * dell'autorità dell'owner (ADR-0003, e la stessa postura di
 * `core/rot/harden.ts`, che il piano lo stampa e non lo esegue). Per quei file
 * `adopt` stampa i due comandi in ordine e si ferma: la porta sul sigillo
 * resta una sola, e sono le mani dell'owner.
 */

export type AdoptDeps = {
  out: (line: string) => void;
  style?: Style;
  /** `undefined` = risolvilo da solo. `null` = nessun checkout (il caso che va provato). */
  checkoutRoot?: string | null;
  git?: Git;
  /** Iniettabile perché un test deve poter guardare *cosa* sarebbe stato copiato senza copiarlo. */
  copy?: (src: string, dst: string) => void;
};

/** Quello che l'owner ha scritto sulla riga di comando, già separato da ciò che è un flag. */
type Richiesta = { tutto: boolean; paths: string[] };

function leggiArgv(argv: string[]): Richiesta {
  const tutto = argv.includes('--tutto') || argv.includes('--all');
  return { tutto, paths: argv.filter((a) => !a.startsWith('--')) };
}

/**
 * Una riga per file, con lo stato davanti.
 *
 * Il segno prende il colore e il testo resta nudo — `cli/STYLES.md`, la regola
 * che tiene leggibile una lista in cui la riga che conta è una su venti.
 */
function riga(d: DefaultDrift, style: Style): string {
  const segno =
    d.status === 'up-to-date'
      ? style.ok('✓')
      : d.status === 'adoptable'
        ? style.warn('↑')
        : d.status === 'owner-modified'
          ? style.ok('·')
          : style.warn('?');
  return `${segno} ${style.bold(d.path)}  ${d.detail}`;
}

/**
 * Il resoconto, che è ciò che `muffin adopt` senza argomenti fa e basta.
 *
 * Senza argomenti non scrive niente: la lista di cosa cambierebbe è
 * un'informazione che serve *prima* di decidere, e un comando che adotta tutto
 * appena lo digiti non la lascia leggere a nessuno.
 */
function resoconto(drift: DefaultDrift[], style: Style, out: (l: string) => void): number {
  for (const d of drift) out(riga(d, style));

  const adottabili = drift.filter((d) => d.status === 'adoptable');
  const liberi = adottabili.filter((d) => !d.sealed);
  const sigillati = adottabili.filter((d) => d.sealed);

  out('');
  if (adottabili.length === 0) {
    out('Niente da adottare: ogni file è allineato a HEAD, o è tuo.');
    return 0;
  }
  if (liberi.length > 0) {
    out(`${String(liberi.length)} da adottare: ${liberi.map((d) => d.path).join(', ')}`);
    out(`  → \`muffin adopt --tutto\`, oppure \`muffin adopt ${liberi[0]?.path ?? ''}\` per uno solo`);
  }
  for (const d of sigillati) out(`  ${style.warn('!')} ${d.path} è dentro il sigillo: ${consegnaSigillata(d)}`);
  return 0;
}

/**
 * La frase che accompagna un file sigillato — la conseguenza **prima** del
 * comando, mai dopo. Chi la legge deve poter smettere di leggere a metà e non
 * aver già mandato l'installazione in safe mode.
 */
function consegnaSigillata(d: DefaultDrift): string {
  return (
    `adottarlo fa divergere l'hash sigillato e manda l'installazione in safe mode. ` +
    `Se la vuoi: \`${d.adoptCommand ?? '(comando non disponibile)'}\`, poi \`muffin rot reseal\``
  );
}

export function cmdAdopt(home: string, argv: string[], deps: AdoptDeps): number {
  const out = deps.out;
  const style = deps.style ?? PLAIN;
  const checkoutRoot =
    deps.checkoutRoot !== undefined ? deps.checkoutRoot : findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  const drift = diagnoseDefaultsDrift(home, checkoutRoot, deps.git ?? REAL_GIT);

  if (drift.length === 0) {
    // Stessa scelta di `cli/doctor.ts`: una riga dichiarata, non N righe mute.
    out("Non ho potuto guardare: né un registro d'installazione né un checkout Git leggibile.");
    return 1;
  }

  const { tutto, paths } = leggiArgv(argv);
  if (!tutto && paths.length === 0) return resoconto(drift, style, out);

  const perPath = new Map(drift.map((d) => [d.path, d] as const));
  // `--tutto` prende solo i liberi. I sigillati non ci finiscono dentro
  // *per selezione*, non per un rifiuto stampato dopo: un flag che chiede
  // «tutto» non deve poter significare «e anche il sigillo».
  const scelti: DefaultDrift[] = tutto
    ? drift.filter((d) => d.status === 'adoptable' && !d.sealed)
    : paths.map((p) => perPath.get(p) ?? { path: p, sealed: false, status: 'missing' as const, detail: 'non è un file di defaults/ che io conosca' });

  if (tutto && scelti.length === 0) {
    out('Niente da adottare.');
    for (const d of drift.filter((x) => x.status === 'adoptable' && x.sealed)) {
      out(`  ${style.warn('!')} ${d.path} è dentro il sigillo: ${consegnaSigillata(d)}`);
    }
    return 0;
  }

  const copia = deps.copy ?? ((src, dst) => copyFileSync(src, dst));
  const copiati: { path: string; content: Buffer }[] = [];
  let problemi = 0;

  for (const d of scelti) {
    if (d.sealed) {
      out(`${style.warn('!')} ${d.path} — ${consegnaSigillata(d)}`);
      problemi += 1;
      continue;
    }
    if (d.status !== 'adoptable') {
      // Il rifiuto porta la ragione della diagnosi, non una sua parafrasi:
      // «modificato dall'owner» e «non so dire» chiedono cose diverse.
      out(`${style.warn('!')} ${d.path} — non adottabile: ${d.detail}`);
      problemi += 1;
      continue;
    }
    if (checkoutRoot === null) {
      out(`${style.warn('!')} ${d.path} — nessun checkout da cui copiare`);
      problemi += 1;
      continue;
    }
    const src = shippedPathOf(checkoutRoot, d.path);
    const dst = installedPathOf(home, d.path);
    try {
      copia(src, dst);
    } catch (error) {
      out(`${style.fail('✗')} ${d.path} — non ho potuto copiarlo: ${(error as Error).message}`);
      problemi += 1;
      continue;
    }
    // Letto **dalla destinazione**, non dalla sorgente: è l'hash di ciò che
    // adesso sta davvero in `~/.muffin` che la regola 1 confronterà, e una
    // copia che è andata storta a metà deve registrarsi per com'è finita.
    try {
      copiati.push({ path: d.path, content: readFileSync(dst) });
    } catch (error) {
      out(`${style.warn('!')} ${d.path} — copiato, ma non rileggibile per il registro: ${(error as Error).message}`);
      problemi += 1;
      continue;
    }
    out(`${style.ok('↑')} ${d.path} adottato`);
  }

  // Una sola scrittura del registro, alla fine, e solo con ciò che è stato
  // davvero copiato *e* riletto.
  if (copiati.length > 0) {
    recordCopied(home, copiati);
    out('');
    out(style.dim(`registro d'installazione aggiornato — al prossimo giro questi file restano adottabili, non "modificati da te"`));
  }
  return problemi > 0 ? 1 : 0;
}
