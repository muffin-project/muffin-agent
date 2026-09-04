/**
 * L'eco: la stessa cosa detta in più blocchi del system prompt.
 *
 * Owner, 28/08/2026: *«il prompt contiene tante cose che sono "preventive"
 * perché le stiamo portando indietro dal vecchio muffin»*. È vero, e il modo in
 * cui era vero non si vedeva leggendo: i quattro blocchi si leggono uno alla
 * volta, ognuno sembra ragionevole, e la ripetizione esiste solo *fra* di loro.
 * `identity.md` dice «non fingi di aver controllato», `persona.md` dice «non
 * descrivo un'azione come fatta se non l'ho fatta», `voice.md` ha una sezione
 * intera intitolata «Niente azioni simulate», e `WORK_RULES` chiude con «non
 * fingere di aver fatto». Quattro volte, in quattro registri diversi.
 *
 * Perché è un problema e non solo spreco: un prompt che ripete una regola in
 * quattro modi non la rende quattro volte più vera. La allunga — 22.904
 * caratteri pagati a ogni turno — e soprattutto **sposta il peso**: ciò che è
 * ripetuto pesa più di ciò che è detto una volta sola, e la ripetizione qui non
 * è nata da una decisione, è nata dal fatto che ogni file è stato scritto in un
 * momento diverso senza guardare gli altri.
 *
 * ## Perché uno strumento e non un audit
 *
 * L'elenco delle ripetizioni l'ho trovato leggendo, e leggendo si trova una
 * volta sola: il giro dopo il prompt è cambiato e l'elenco è vecchio. E
 * `persona.md` e `voice.md` sono file che l'**owner è invitato a riscrivere**,
 * quindi un test che ne fissa il contenuto sarebbe sbagliato in un altro modo.
 *
 * Quello che si può fissare è la *misura*. Questo modulo la calcola e
 * `muffin prompt show --eco` la stampa: l'eco diventa una cosa che si guarda
 * quando si tocca il prompt, invece di una cosa che si scopre.
 *
 * ## Come misura
 *
 * Confronto grezzo di proposito. Ogni affermazione diventa il suo insieme di
 * parole di contenuto (via le parole vuote), e due affermazioni sono un'eco se
 * gli insiemi si somigliano abbastanza. Non capisce il significato: prende le
 * riformulazioni che condividono le parole — che è come la ripetizione nasce
 * davvero quando quattro file dicono la stessa cosa — e si perde quelle che
 * dicono lo stesso con parole tutte diverse. È un misuratore, non un giudice:
 * la decisione su cosa togliere resta di chi legge.
 */

/**
 * Parole che non distinguono un'affermazione da un'altra.
 *
 * Senza toglierle ogni frase italiana somiglia a ogni altra: `di`, `che`, `non`
 * e `il` da soli portano la somiglianza sopra soglia fra due frasi che non
 * c'entrano niente.
 */
const PAROLE_VUOTE = new Set([
  'ad', 'ai', 'al', 'alla', 'alle', 'allo', 'anche', 'ancora', 'che', 'chi', 'coi', 'col', 'come', 'con', 'cosa',
  'cui', 'dai', 'dal', 'dalla', 'delle', 'dello', 'dei', 'del', 'della', 'dove', 'era', 'essere', 'fare', 'fra',
  'gli', 'hai', 'hanno', 'lei', 'mia', 'mie', 'miei', 'mio', 'nei', 'nel', 'nella', 'nelle', 'noi', 'oppure',
  'per', 'perche', 'perché', 'piu', 'più', 'poi', 'quando', 'quanto', 'quel', 'quella', 'quelle', 'quello',
  'questa', 'queste', 'questi', 'questo', 'qui', 'sei', 'senza', 'sia', 'siamo', 'sono', 'sua', 'sue', 'sui',
  'sul', 'sulla', 'suo', 'tra', 'tuo', 'una', 'uno', 'via', 'solo', 'ogni', 'tutto', 'tutti', 'tutte', 'tutta',
  'devo', 'deve', 'devi', 'può', 'puo', 'posso', 'puoi', 'sto', 'stai', 'sta', 'fai', 'faccio', 'dice', 'dico',
  'dici', 'invece', 'quindi', 'perte', 'cioè', 'cioe',
]);

/** Un'affermazione, e da dove viene. */
export type Affermazione = {
  /** Il nome del blocco: `persona`, `identity`, `voice`, `work-rules`. */
  blocco: string;
  /** Il testo come sta scritto, per poterlo mostrare. */
  testo: string;
  /** Le parole di contenuto, per confrontare. */
  parole: ReadonlySet<string>;
};

/** Una coppia che dice la stessa cosa in due blocchi diversi. */
export type Eco = {
  a: Affermazione;
  b: Affermazione;
  /** Quanto si somigliano, 0–1. */
  somiglianza: number;
};

/**
 * Le parole di contenuto di una frase.
 *
 * Gli apostrofi si spezzano (`l'azione` diventa `azione`) perché in italiano
 * l'elisione attacca una parola vuota a una piena, e non spezzarli fa sì che
 * `l'azione` e `azione` non si riconoscano.
 */
function paroleDi(frase: string): Set<string> {
  const fuori = new Set<string>();
  for (const grezza of frase.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (grezza.length < 3) continue;
    if (PAROLE_VUOTE.has(grezza)) continue;
    fuori.add(grezza);
  }
  return fuori;
}

/** Quante parole di contenuto deve avere una frase per valere un confronto. */
const MINIME = 4;

/**
 * Spezza un blocco nelle sue affermazioni.
 *
 * Le intestazioni saltano — `## Come lavoro` non è un'affermazione, e due
 * blocchi con un titolo simile non stanno ripetendo un contenuto. I marcatori
 * di elenco cadono e il testo resta: dentro un elenco le affermazioni ci sono
 * eccome, ed è dove `voice.md` tiene le sue.
 */
export function affermazioni(blocco: string, testo: string): Affermazione[] {
  const fuori: Affermazione[] = [];
  for (const frase of frasi(testo)) {
    const parole = paroleDi(frase);
    if (parole.size < MINIME) continue;
    fuori.push({ blocco, testo: frase, parole });
  }
  return fuori;
}

/**
 * Le frasi di un testo markdown mandato a capo a mano.
 *
 * **Le righe vanno ricucite prima di spezzarle.** `persona.md` e `voice.md`
 * vanno a capo attorno agli 80 caratteri, quindi una frase sta su due o tre
 * righe: leggere riga per riga taglia ogni frase a metà, e due mezze frasi
 * condividono troppe poche parole per riconoscersi. La prima versione di questo
 * modulo faceva così e trovava **4** coppie dove ce n'erano dieci volte tante —
 * un misuratore che dice «quasi niente» è peggio di nessun misuratore, perché
 * lo si crede.
 *
 * Quindi: una riga vuota, un'intestazione o un marcatore di elenco chiudono
 * l'unità; tutto il resto si attacca alla precedente con uno spazio. Poi si
 * spezza sulla punteggiatura di fine frase.
 */
function frasi(testo: string): string[] {
  const unita: string[] = [];
  let corrente = '';
  const chiudi = (): void => {
    if (corrente.trim() !== '') unita.push(corrente.trim());
    corrente = '';
  };

  for (const riga of testo.split('\n')) {
    const pulita = riga.trim();
    if (pulita === '' || pulita.startsWith('#') || pulita.startsWith('---')) {
      chiudi();
      continue;
    }
    // Un elenco: ogni voce è una sua affermazione, non la coda della frase
    // che la introduce.
    if (/^[-*>]\s/.test(pulita)) {
      chiudi();
      corrente = pulita.replace(/^[-*>]\s*/, '');
      continue;
    }
    corrente = corrente === '' ? pulita : `${corrente} ${pulita}`;
  }
  chiudi();

  return unita
    .flatMap((u) => u.replace(/\*\*/g, '').split(/(?<=[.;:!?])\s+/))
    .map((f) => f.trim())
    .filter((f) => f !== '');
}

/** Quanto due insiemi di parole si sovrappongono, sul più piccolo dei due. */
function quantoSiSomigliano(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let comuni = 0;
  for (const p of a) if (b.has(p)) comuni += 1;
  // Sul più piccolo, non sull'unione: una frase corta contenuta dentro una
  // lunga **è** un'eco, e l'unione la punirebbe per la lunghezza dell'altra.
  return comuni / Math.min(a.size, b.size);
}

/** Sopra questa soglia due affermazioni dicono la stessa cosa. */
const SOGLIA = 0.6;

/**
 * Le eco fra blocchi diversi, dalla più forte alla più debole.
 *
 * Solo **fra** blocchi: un file che si ripete al proprio interno è un difetto
 * di quel file e lo vede chi lo legge; quattro file che si ripetono a vicenda
 * non li vede nessuno, perché nessuno li legge insieme. È il caso che ha
 * bisogno di uno strumento.
 */
export function eco(blocchi: readonly { name: string; text: string }[], soglia = SOGLIA): Eco[] {
  const tutte = blocchi.flatMap((b) => affermazioni(b.name, b.text));
  const fuori: Eco[] = [];
  for (let i = 0; i < tutte.length; i += 1) {
    for (let j = i + 1; j < tutte.length; j += 1) {
      const a = tutte[i]!;
      const b = tutte[j]!;
      if (a.blocco === b.blocco) continue;
      const s = quantoSiSomigliano(a.parole, b.parole);
      if (s >= soglia) fuori.push({ a, b, somiglianza: s });
    }
  }
  return fuori.sort((x, y) => y.somiglianza - x.somiglianza);
}

/**
 * Quanti caratteri stanno in affermazioni che hanno almeno un'eco altrove.
 *
 * Non è «quanto si risparmierebbe»: una delle due copie va tenuta. È la misura
 * di quanto prompt è coinvolto nella ripetizione, che è la cosa da guardare
 * scendere quando si mette mano ai file.
 */
export function caratteriInEco(eco: readonly Eco[]): number {
  const viste = new Set<string>();
  let n = 0;
  for (const e of eco) {
    for (const lato of [e.a, e.b]) {
      const chiave = `${lato.blocco} ${lato.testo}`;
      if (viste.has(chiave)) continue;
      viste.add(chiave);
      n += lato.testo.length;
    }
  }
  return n;
}
