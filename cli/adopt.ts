import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 * ## E poi c'e' la casa che invecchia (03/09/2026)
 *
 * **Invariante di questo modulo, dalla riga qui sotto in poi: un default
 * spedito arriva anche in una casa nata prima che esistesse, e cio' che
 * l'owner ha scritto non viene mai sovrascritto.**
 *
 * Misurato sull'installazione dell'owner il 03/09: spediamo due skill in
 * `defaults/skills/`, `runInit` le installa in una casa nuova, e il suo
 * `defaults-manifest.json` elencava **un** file, `persona.md`. La sua casa e'
 * nata prima delle skill e nessuno gliele ha mai portate: `~/.muffin/skills`
 * non esisteva, `skillsPromptSection` tornava stringa vuota, il modello non
 * sentiva mai la parola «skill» e `skill_read` era un tool senza niente da
 * leggere. Ogni test passava, perche' una casa di test la crea `runInit` da
 * zero e quindi ha gia' tutto.
 *
 * La radice non e' delle skill. `muffin update` sposta il **codice**,
 * `runInit` semina una casa **nuova**, e nessuno riconciliava una casa
 * **esistente** con i default aggiunti dopo la sua nascita: qualunque default
 * futuro — una skill, una policy, un template — faceva la stessa fine.
 *
 * `reconcileDefaults` chiude quel buco, e installa **solo cio' che manca**.
 * La distinzione e' la sicurezza stessa:
 *
 *  - **assente** = non c'e' niente dell'owner da perdere. Sicuro per
 *    costruzione, si fa da soli.
 *  - **presente e invariato dalla copia** (`adoptable`) = sostituirlo cambia
 *    il comportamento di un'installazione viva. Resta `muffin adopt`, che e'
 *    un verbo che l'owner digita.
 *  - **presente e diverso** (`owner-modified`, o `unknown`) = non si tocca, si
 *    dichiara. Vale anche per l'incertezza: su una casa antecedente al
 *    registro, «mai installato» e «installato e poi modificato» si distinguono
 *    solo per un file **assente** (nessuna ambiguita' possibile); per un file
 *    presente decide la regola 2 di `defaults-drift.ts` (la storia Git), e
 *    quando neanche quella sa rispondere la direzione sicura e' non toccare.
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
 *
 * Vale identico per un file di `defaults/rot/` **assente**: installarlo non
 * distrugge niente, ma fa divergere l'hash sigillato lo stesso e manda
 * l'installazione in safe mode finche' non gira `muffin rot reseal`. Quindi
 * anche li' si nomina e non si scrive — `muffin init` e' l'unico percorso che
 * copia dentro il sigillo, ed e' l'unico perche' risigilla nello stesso giro
 * (`cli/init.ts`, `seal()` come ultimo passo).
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
        : d.status === 'missing'
          ? style.warn('+')
          : d.status === 'owner-modified'
            ? style.ok('·')
            : style.warn('?');
  return `${segno} ${style.bold(d.path)}  ${d.detail}`;
}

/**
 * I due stati che questo comando ha il diritto di scrivere, e nient'altro.
 *
 * `'missing'` sta accanto a `'adoptable'` e non e' un allargamento: e' il caso
 * **piu'** sicuro dei due, perche' non c'e' nessun file da sostituire e quindi
 * niente dell'owner da perdere. `'owner-modified'` e `'unknown'` restano
 * fuori, ed e' la stessa riga di prima: non so dire se e' tuo → e' tuo.
 */
function scrivibile(d: DefaultDrift): boolean {
  return d.status === 'adoptable' || d.status === 'missing';
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

  const scrivibili = drift.filter(scrivibile);
  const liberi = scrivibili.filter((d) => !d.sealed);
  const sigillati = scrivibili.filter((d) => d.sealed);

  out('');
  if (scrivibili.length === 0) {
    out('Niente da adottare: ogni file è allineato a HEAD, o è tuo.');
    return 0;
  }
  if (liberi.length > 0) {
    // I mancanti si contano a parte perché chiedono una cosa diversa: non
    // «sostituisco la tua copia con quella nuova» ma «questo default non è mai
    // arrivato in questa casa». È il difetto misurato il 03/09, e va detto
    // con le sue parole.
    const mancanti = liberi.filter((d) => d.status === 'missing');
    if (mancanti.length > 0) {
      out(`${String(mancanti.length)} mai arrivati in questa casa: ${mancanti.map((d) => d.path).join(', ')}`);
    }
    const vecchi = liberi.filter((d) => d.status === 'adoptable');
    if (vecchi.length > 0) out(`${String(vecchi.length)} da adottare: ${vecchi.map((d) => d.path).join(', ')}`);
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
  if (d.status === 'missing') {
    return (
      `manca, ma installarlo fa divergere l'hash sigillato e manda l'installazione in safe mode. ` +
      '`muffin init` lo copia e risigilla nello stesso giro — è l\'unico percorso che entra nel sigillo senza lasciarlo rotto'
    );
  }
  return (
    `adottarlo fa divergere l'hash sigillato e manda l'installazione in safe mode. ` +
    `Se la vuoi: \`${d.adoptCommand ?? '(comando non disponibile)'}\`, poi \`muffin rot reseal\``
  );
}

/**
 * La copia vera, in un posto solo.
 *
 * `cmdAdopt` (l'owner che digita) e `reconcileDefaults` (l'aggiornamento che
 * passa) devono copiare **e registrare** nello stesso identico modo: due
 * copie di questo ciclo sarebbero libere di divergere proprio sul ramo che
 * nessuno guarda, e la meta' che si perde per prima e' `recordCopied` — cioe'
 * la regola 1 di `defaults-drift.ts`, quella che al giro dopo distingue «di
 * serie» da «tuo». Chi copia registra, sempre, da qui.
 */
function copiaERegistra(
  home: string,
  checkoutRoot: string,
  scelti: DefaultDrift[],
  copy: (src: string, dst: string) => void,
  nota: (path: string, esito: string) => void,
): { copiati: string[]; falliti: { path: string; why: string }[] } {
  const registrare: { path: string; content: Buffer }[] = [];
  const falliti: { path: string; why: string }[] = [];

  for (const d of scelti) {
    const src = shippedPathOf(checkoutRoot, d.path);
    const dst = installedPathOf(home, d.path);
    // Un percorso che il **registro** conosce ma che `defaults/` non spedisce
    // piu' (un default ritirato): non e' un guasto, e non e' niente da copiare.
    if (!existsSync(src)) {
      falliti.push({ path: d.path, why: `defaults/${d.path} non esiste piu' in questo checkout` });
      continue;
    }
    try {
      // `skills/<nome>/SKILL.md`: la cartella intermedia non esiste in una casa
      // che quel default non l'ha mai avuto, ed e' esattamente il caso per cui
      // questa funzione esiste.
      mkdirSync(dirname(dst), { recursive: true });
      copy(src, dst);
    } catch (error) {
      falliti.push({ path: d.path, why: (error as Error).message });
      continue;
    }
    // Letto **dalla destinazione**, non dalla sorgente: e' l'hash di cio' che
    // adesso sta davvero in casa che la regola 1 confrontera', e una copia
    // andata storta a meta' deve registrarsi per com'e' finita.
    try {
      registrare.push({ path: d.path, content: readFileSync(dst) });
    } catch (error) {
      falliti.push({ path: d.path, why: `copiato, ma non rileggibile per il registro: ${(error as Error).message}` });
      continue;
    }
    nota(d.path, d.status === 'missing' ? 'installato (mancava)' : 'adottato');
  }

  // Una sola scrittura del registro, alla fine, e solo con cio' che e' stato
  // davvero copiato *e* riletto.
  if (registrare.length > 0) recordCopied(home, registrare);
  return { copiati: registrare.map((r) => r.path), falliti };
}

/** Cio' che questa riconciliazione ha fatto, e — piu' importante — cio' che ha deciso di non fare. */
export type EsitoRiconciliazione = {
  /** Installati adesso perche' **assenti**: non c'era niente dell'owner da perdere. */
  installati: string[];
  /** Assenti ma dentro `rot/`: nominati, mai scritti — servirebbe un `muffin rot reseal`. */
  sigillati: DefaultDrift[];
  /** Riscritti dall'owner: mai toccati, dichiarati divergenti. */
  divergenti: DefaultDrift[];
  /** Presenti e indistinguibili: non so dire se sono tuoi, quindi sono tuoi. */
  incerti: DefaultDrift[];
  /** Presenti, invariati dalla copia, ma HEAD e' andato avanti: e' `muffin adopt`, non e' automatico. */
  adottabili: DefaultDrift[];
  falliti: { path: string; why: string }[];
};

/**
 * Porta in una casa **esistente** i default spediti dopo la sua nascita.
 *
 * Installa solo cio' che manca (vedi l'invariante in cima al file), non scrive
 * mai dentro il sigillo, e non sostituisce mai un file che c'e' gia' — nemmeno
 * uno che potrebbe essere adottato: quello resta una decisione dell'owner.
 *
 * Funzione, non comando: la chiamano `cmdAdopt` (la porta che l'owner digita)
 * e `runUpdate` (la porta che passa da sola). Stessa regola, un'implementazione.
 */
export function reconcileDefaults(
  home: string,
  checkoutRoot: string | null,
  deps: { git?: Git; copy?: (src: string, dst: string) => void } = {},
): EsitoRiconciliazione {
  const drift = diagnoseDefaultsDrift(home, checkoutRoot, deps.git ?? REAL_GIT);
  const esito: EsitoRiconciliazione = {
    installati: [],
    sigillati: [],
    divergenti: [],
    incerti: [],
    adottabili: [],
    falliti: [],
  };
  const daInstallare: DefaultDrift[] = [];
  for (const d of drift) {
    if (d.status === 'missing') (d.sealed ? esito.sigillati : daInstallare).push(d);
    else if (d.status === 'owner-modified') esito.divergenti.push(d);
    else if (d.status === 'unknown') esito.incerti.push(d);
    else if (d.status === 'adoptable') esito.adottabili.push(d);
  }
  if (daInstallare.length === 0) return esito;
  if (checkoutRoot === null) {
    for (const d of daInstallare) esito.falliti.push({ path: d.path, why: 'nessun checkout da cui copiare' });
    return esito;
  }
  const fatto = copiaERegistra(home, checkoutRoot, daInstallare, deps.copy ?? ((src, dst) => copyFileSync(src, dst)), () => undefined);
  esito.installati = fatto.copiati;
  esito.falliti = fatto.falliti;
  return esito;
}

/**
 * Una riga sola, per chi stampa un aggiornamento e non un resoconto.
 *
 * `null` quando non c'e' niente da dire: un aggiornamento che stampa «tutto a
 * posto» a ogni giro insegna a non leggerlo.
 */
export function rigaRiconciliazione(e: EsitoRiconciliazione): string | null {
  const pezzi: string[] = [];
  if (e.installati.length > 0) pezzi.push(`installati in casa ${String(e.installati.length)} default che mancavano: ${e.installati.join(', ')}`);
  if (e.sigillati.length > 0)
    pezzi.push(
      `${String(e.sigillati.length)} dentro il sigillo non installati (${e.sigillati.map((d) => d.path).join(', ')}) — ` +
        '`muffin init` li copia e risigilla nello stesso giro',
    );
  if (e.adottabili.length > 0)
    pezzi.push(`${String(e.adottabili.length)} da aggiornare, mai modificati da te: \`muffin adopt --tutto\``);
  for (const f of e.falliti) pezzi.push(`${f.path} non installato: ${f.why}`);
  return pezzi.length > 0 ? pezzi.join(' · ') : null;
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
  // `--tutto` prende i liberi: quelli da aggiornare **e** quelli che mancano
  // del tutto. I sigillati non ci finiscono dentro *per selezione*, non per un
  // rifiuto stampato dopo: un flag che chiede «tutto» non deve poter
  // significare «e anche il sigillo».
  const scelti: DefaultDrift[] = tutto
    ? drift.filter((d) => scrivibile(d) && !d.sealed)
    : paths.map((p) => perPath.get(p) ?? { path: p, sealed: false, status: 'unknown' as const, detail: 'non è un file di defaults/ che io conosca' });

  if (tutto && scelti.length === 0) {
    out('Niente da adottare.');
    for (const d of drift.filter((x) => scrivibile(x) && x.sealed)) {
      out(`  ${style.warn('!')} ${d.path} è dentro il sigillo: ${consegnaSigillata(d)}`);
    }
    return 0;
  }

  const daCopiare: DefaultDrift[] = [];
  let problemi = 0;

  for (const d of scelti) {
    if (d.sealed) {
      out(`${style.warn('!')} ${d.path} — ${consegnaSigillata(d)}`);
      problemi += 1;
      continue;
    }
    if (!scrivibile(d)) {
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
    daCopiare.push(d);
  }

  const fatto =
    checkoutRoot === null || daCopiare.length === 0
      ? { copiati: [] as string[], falliti: [] as { path: string; why: string }[] }
      : copiaERegistra(
          home,
          checkoutRoot,
          daCopiare,
          deps.copy ?? ((src, dst) => copyFileSync(src, dst)),
          (path, esito) => out(`${style.ok('↑')} ${path} ${esito}`),
        );
  for (const f of fatto.falliti) {
    out(`${style.fail('✗')} ${f.path} — ${f.why}`);
    problemi += 1;
  }

  if (fatto.copiati.length > 0) {
    out('');
    out(style.dim(`registro d'installazione aggiornato — al prossimo giro questi file restano adottabili, non "modificati da te"`));
  }
  return problemi > 0 ? 1 : 0;
}
