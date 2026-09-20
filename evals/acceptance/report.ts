#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST, promoteMarker, type ScenarioEntry } from './manifest.js';

/**
 * The command the DAY-1 requirements inventory's state is derived from, instead
 * of asserted by hand.
 *
 * requirements-status.md#la-regola-delle-quattro-risposte: an inventory's fourth, forbidden answer is "we hadn't
 * thought about it" — a row with no scenario is exactly that, silently. This
 * prints, for every row in the live inventory: a passing scenario, a scenario
 * that broke for real, a scenario still red on purpose (and why, and what
 * closes it), or no scenario at all. Rows this rig cannot exercise — a real
 * model, real audio hardware — get a fifth, explicit answer: "not provable
 * here", which the inventory itself does not allow but a report about the
 * inventory has to be able to say instead of mis-filing them as "no scenario".
 *
 * Runs the acceptance vitest project as a real subprocess (`npx vitest run
 * --reporter=json`) rather than re-implementing pass/fail: `scenario.ts`
 * turns an `atteso-rosso` row's failure into an ordinary vitest pass/fail —
 * pass when the error matches the manifest's own `expectFailure`, fail
 * (with a distinguishing message) otherwise — so this script reads
 * `failureMessages` out of the JSON reporter's own output (verified against
 * the installed vitest 2.1.9 with a throwaway probe file: `failureMessages:
 * string[]` carries the thrown `Error`'s message, one entry per assertion)
 * rather than re-implementing pass/fail itself. readiness-criteria.md#day-1-ready (P39): a
 * scenario that is red is not automatically "fine" — it has to be red for
 * the reason the manifest names, or this report has to say so.
 *
 * `parseInventory`/`acceptanceResults` are the only functions here that
 * touch disk or spawn a process (`acceptanceResults` splits further into
 * `runSuiteToJson` and `readSuiteJson`, each driven separately); everything
 * downstream of them (`verdictFor`,
 * `summarize`) is pure, exported, and what `report.test.ts` drives directly
 * with synthetic rows and results — real inventory text and a real vitest
 * subprocess would make "does the gate fire" a ~60s integration test instead
 * of a millisecond one, for a question that does not need either.
 */

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DAY1_REQUIREMENTS = join(REPO, 'docs', 'work', 'day1', 'requirements-status.md');

export type Stato = 'READY' | 'OUT' | 'BLOCKER' | '?';

export type InventoryRow = { id: string; area: string; question: string; stato: Stato; rawStato: string };

/**
 * Reads the inventory tables directly from the live document — never a copy —
 * so the report is always about today's inventory, not the one that existed
 * when this script was written. A row without a matching table line is a sign
 * the parser needs updating, not that the row does not exist.
 */
function parseInventory(): InventoryRow[] {
  return parseInventoryRows(readFileSync(DAY1_REQUIREMENTS, 'utf8'), DAY1_REQUIREMENTS);
}

/**
 * Il parser, separato dal file che legge, perché la sua trappola si prova solo
 * su testo.
 *
 * `(?:[^|\\]|\\.)+?` e non `[^|]+?`: in una tabella Markdown una barra dentro
 * una cella si scrive `\|`, ed è legale. Con la classe negata secca quella
 * cella terminava la colonna, la riga non corrispondeva più, e l'inventario
 * *perdeva la riga* — in silenzio. Misurato il 03/09: aggiungendo
 * `--channel <main\|dev>` alla riga A6, il rapporto non ha detto «A6 non si
 * legge» ma «scenario A6 orfano», cioè ha accusato il manifest di un difetto
 * che stava nella cella di un documento. Un `continue` che salta la riga
 * sbagliata è peggio di un errore: manda a cercare nel file sbagliato.
 */
export function parseInventoryRows(text: string, source = DAY1_REQUIREMENTS): InventoryRow[] {
  const CELL = String.raw`(?:[^|\\]|\\.)+?`;
  const riga = new RegExp(String.raw`^\|\s*([A-Z]\d{1,2})\s*\|\s*(${CELL})\s*\|\s*(${CELL})\s*\|\s*(${CELL})\s*\|\s*$`);
  const rows: InventoryRow[] = [];
  for (const line of text.split('\n')) {
    const m = riga.exec(line);
    if (!m) {
      // A line that *starts* like a data row and *carries* a status but does
      // not parse has a bare `|` inside a cell: skipping it would resurface
      // as «scenario X orfano» and send whoever reads the report to the
      // manifest, when the defect sits in this document (E1, 05/09/2026:
      // `<dollari|none>` written without the backslash). Refuse instead.
      const inizio = /^\|\s*([A-Z]\d{1,2})\s*\|/.exec(line);
      if (inizio && /\|\s*(?:READY|OUT|BLOCKER|\?)/.test(line)) {
        throw new Error(
          `riga ${inizio[1]} in ${source} non si legge: una barra non sfuggita (\`|\`) dentro una cella la spezza in più colonne — scrivila \\|`,
        );
      }
      continue;
    }
    const [, id, area, question, rawStato] = m as unknown as [string, string, string, string, string];
    let stato: Stato;
    if (rawStato.startsWith('READY')) stato = 'READY';
    else if (rawStato.startsWith('OUT')) stato = 'OUT';
    else if (rawStato.startsWith('BLOCKER')) stato = 'BLOCKER';
    else if (rawStato.startsWith('?')) stato = '?';
    else continue; // not a data row (header, or a `|---|` separator)
    rows.push({ id, area, question, stato, rawStato });
  }
  if (rows.length === 0)
    throw new Error(`nessuna riga trovata in ${source} — il parser è disallineato dal formato`);
  return rows;
}

/**
 * Rows this harness structurally cannot exercise, with the reason written
 * once here rather than left to be inferred from "no scenario". Kept to
 * genuine impossibilities — no real audio hardware, no real model to judge
 * against — not to rows nobody has gotten to yet, which stay honestly
 * "nessuno scenario".
 */
/**
 * Il motivo che `annunciaSalto` (`evals/acceptance/non-provabile.ts`) infila nel
 * titolo del test saltato. Una sola forma, scritta in un posto e letta in un
 * altro: se le due divergono il salto torna a leggersi come un rosso, quindi la
 * forma è pinnata da un test che le confronta.
 *
 * `(.+)\]$` e non `([^\]]+)\]`: `annunciaSalto` appende il motivo in coda al
 * titolo, quindi la parentesi che chiude è l'ultimo carattere del nome — e un
 * motivo che contenga a sua volta un `]` (il messaggio di bwrap, per dire, o un
 * `argv[0]`) veniva troncato lì e il verdetto stampava mezza ragione.
 */
const MOTIVO_NEL_TITOLO = /\[non provabile qui: (.+)\]$/;

/** Il nome, senza il motivo che `annunciaSalto` gli ha appeso — la forma con cui `chiaviEsito` confronta un salto dichiarato. */
function senzaMotivo(full: string): string {
  return full.replace(MOTIVO_NEL_TITOLO, '').trimEnd();
}

/** Il marcatore con cui `outcomesOf` nomina un file che non si è caricato: non è un test, ma è un rosso, e deve avere un nome. */
const FILE_NON_CARICATO = '[file non caricato]';

const NOT_PROVABLE_HERE: Record<string, string> = {
  // C8 non è più qui (slice/c8-b16-voce-e-reply): la ragione — "richiede una
  // trascrizione audio reale, e property 2 del brief vieta chiavi/chiamate a
  // pagamento in questa suite" — presumeva che l'unico modo di prendere il
  // ramo trascritto fosse whisper.cpp/ffmpeg veri. `core/audio/trascrivi.ts`
  // trova i due binari **per percorso** (`trovaBinario`), quindi lo scenario
  // punta `config.audio.{whisperBin,ffmpegBin}` — una manopola già esistente
  // e documentata — a due script finti: nessuna chiave, nessuna chiamata a
  // pagamento, nessun binario di questa macchina. Vedi `c-audio.accept.ts`.
  //
  // B16 non è più qui. L'override esiste ora in produzione —
  // `surfaces.telegram.apiBase`, con `muffin surface enable telegram
  // --api-base <url>` — e non come cablaggio da test: Telegram pubblica il Bot
  // API come server ospitabile («You can run it locally and send the requests
  // to your own server instead of https://api.telegram.org»,
  // core.telegram.org/bots/api), quindi la manopola è una modalità di
  // deployment documentata che *per costruzione* rende la superficie
  // provabile. `evals/acceptance/telegram.ts` è il Bot API finto che ne
  // approfitta, e `scenarios/b-telegram-pairing.accept.ts` guida il binario
  // vero attraverso pairing, sconosciuto e codice sbagliato.
  //
  // La lezione, per chi aggiungerà la prossima superficie: la ragione per cui
  // questa riga è rimasta qui per settimane non era la difficoltà, era che
  // mancava un argomento a un costruttore che lo accettava già.
};

export type VitestStatus = 'passed' | 'failed' | 'pending' | 'skipped';

/** One assertion's outcome, plus whatever it threw — the input `verdictFor` needs to tell "promote" apart from "wrong reason". */
export type TestOutcome = { status: VitestStatus; failureMessages: string[] };

export type VitestJsonResult = {
  /** Presente nel JSON di vitest 2.1.9. `outcomesOf` lo legge come controprova: dice quante suite sono fallite. */
  numFailedTestSuites?: number;
  testResults: Array<{
    /** Il percorso del file. `undefined` solo in JSON sintetici: il reporter vero lo scrive sempre. */
    name?: string;
    /** L'esito del **file**, non delle sue assertion: `failed` con zero assertion significa «non si è caricato». */
    status?: VitestStatus;
    /** Il messaggio dell'errore di caricamento, quando il file non è arrivato a registrare nemmeno un test. */
    message?: string;
    assertionResults: Array<{ fullName: string; status: VitestStatus; failureMessages?: string[] }>;
  }>;
};

/**
 * Where the outcomes come from. In CI the suite has already run one step
 * earlier with `--reporter=json --outputFile.json=<file>`; re-spawning it here
 * doubled the job's wall clock past its `timeout-minutes`, and GitHub marks a
 * timed-out job `cancelled` even when every step — this report included — was
 * green. When `MUFFIN_ACCEPT_RESULTS` names that file, read it; a named file
 * that cannot be read is an error, never a silent second run. Unset, run the
 * suite here, exactly once, into a temp file: `npm run acceptance:report` on
 * a laptop stays one command, and the report consumes that run's JSON through
 * the same reader the CI path uses.
 */
export function acceptanceResults(run: SuiteRunner = spawnSync): Map<string, TestOutcome> {
  const given = process.env.MUFFIN_ACCEPT_RESULTS;
  if (given !== undefined && given !== '') {
    try {
      return outcomesOf(readSuiteJson(given));
    } catch (error) {
      throw new Error(
        `MUFFIN_ACCEPT_RESULTS=${given} non è un JSON di vitest leggibile: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const outFile = join(mkdtempSync(join(tmpdir(), 'muffin-accept-report-')), 'results.json');
  try {
    const result = runSuiteToJson(outFile, run);
    try {
      return outcomesOf(readSuiteJson(outFile));
    } catch (error) {
      throw new Error(
        `la suite di accettazione non ha prodotto un JSON leggibile (exit ${result.status}):\n` +
          `${result.stdout}\n${result.stderr}\ncausa: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    rmSync(join(outFile, '..'), { recursive: true, force: true });
  }
}

/**
 * The process seam `acceptanceResults` runs the suite through. A function
 * rather than a flag so the "exactly once, no wall-clock timeout" contract
 * stays provable in milliseconds (`report.test.ts` drives it with a fake
 * that writes a canned JSON instead of spawning vitest) — the real
 * `spawnSync` would make every assertion here an ~11-minute test.
 */
export type SuiteRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf8' },
) => { status: number | null; stdout: string; stderr: string };

/**
 * Run: the acceptance suite, exactly once, into `outFile` as vitest
 * `--reporter=json` — the same file the CI step hands over through
 * `MUFFIN_ACCEPT_RESULTS`, so there is one producer shape and one consumer.
 *
 * Deliberately no wall-clock `timeout`: the suite outgrew a hard-coded 10
 * minutes once already (#556), and any number here is a stima travestita da
 * gate — a slow run is not a broken run. A hung suite is stopped the same
 * way it is in CI, by the job's own `timeout-minutes`, or by Ctrl-C on a
 * laptop. Raising the number instead would only schedule the next identical
 * failure for whenever the suite outgrows the new number.
 *
 * A non-zero exit is NOT an error here: vitest exits non-zero when any test
 * fails, which an unexpected red legitimately does — the JSON file is
 * written either way, so only a missing or unreadable file fails loudly.
 */
export function runSuiteToJson(
  outFile: string,
  run: SuiteRunner = spawnSync,
): { status: number | null; stdout: string; stderr: string } {
  const result = run(
    'npx',
    ['vitest', 'run', '--config', 'vitest.acceptance.config.ts', '--reporter=json', `--outputFile=${outFile}`],
    { cwd: REPO, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Consume: one vitest `--reporter=json` file into outcomes. Throws the raw
 * cause — missing file, unparsable JSON, misaligned shape — and each caller
 * names where the file was supposed to come from, so a laptop run and a CI
 * file fail with different sentences but through this one reader.
 */
export function readSuiteJson(path: string): VitestJsonResult {
  return JSON.parse(readFileSync(path, 'utf8')) as VitestJsonResult;
}

/**
 * Every assertion of vitest's JSON reporter, keyed by its `fullName` the way `verdictFor`'s suffix match expects.
 *
 * Più un esito sintetico per ogni **file che non si è caricato**. Misurato su
 * vitest 2.1.9 con un file che lancia all'import: `numTotalTests 0`,
 * `numFailedTests 0`, e in `testResults` una voce `{ status: "failed",
 * assertionResults: [], message: "import-time boom" }`. Cioè: zero assertion,
 * quindi finché questa funzione leggeva solo `assertionResults` il rosso non
 * esisteva — il conteggio scendeva in silenzio e il report diceva OK.
 *
 * Non è ipotetico: è proprio il guasto di questa slice, i file `._<nome>.accept.ts`
 * che bsdtar infilava nel tar e che vitest raccoglieva e falliva a caricare.
 * Nessuna riga del manifest li rivendica, quindi finiscono in «fuori inventario
 * rosso» e fanno fallire il report come qualsiasi altro rosso.
 */
export function outcomesOf(json: VitestJsonResult): Map<string, TestOutcome> {
  const byTitle = new Map<string, TestOutcome>();
  for (const file of json.testResults) {
    for (const a of file.assertionResults) {
      const nome = a.fullName.trim();
      const nuovo: TestOutcome = { status: a.status, failureMessages: a.failureMessages ?? [] };
      // Due file diversi possono registrare lo stesso `fullName` (stesso
      // describe, stesso titolo). La `Map` ne tiene uno solo, e prima vinceva
      // **l'ultimo**: un file A rosso più un file B verde con lo stesso nome
      // lasciavano una sola chiave `passed`, cioè il rosso spariva. Qui vince
      // il peggiore: un rosso non si perde per omonimia.
      const gia = byTitle.get(nome);
      byTitle.set(nome, gia !== undefined && peggiore(gia, nuovo) === gia ? gia : nuovo);
    }
    if (file.status === 'failed' && file.assertionResults.length === 0) {
      // Il marcatore va in testa e il basename subito dopo: la riga di
      // `summarize` tronca a 110 caratteri, e con un percorso assoluto lungo
      // (`/app/evals/acceptance/scenarios/…`) il taglio si mangiava proprio il
      // nome del file — si imparava che *un* file non si era caricato, non quale.
      const percorso = (file.name ?? '(file senza nome nel reporter JSON)').trim();
      const base = percorso.split('/').pop() || percorso;
      byTitle.set(`${FILE_NON_CARICATO} ${base} (${percorso})`, {
        status: 'failed',
        failureMessages: [file.message ?? '(nessun messaggio di caricamento nel reporter JSON)'],
      });
    }
  }
  // Controprova a costo zero, con il contatore che il reporter scrive da sé: se
  // vitest dice che N suite sono fallite e qui non ne è comparsa nessuna con
  // zero assertion, la lettura per-file qui sopra ha smesso di funzionare — e
  // il modo in cui smetterebbe è tornare a essere silenziosa.
  const suiteRosseViste = [...byTitle.keys()].filter((k) => k.startsWith(FILE_NON_CARICATO)).length;
  const suiteRosseDichiarate = json.numFailedTestSuites ?? 0;
  if (suiteRosseDichiarate > 0 && suiteRosseViste === 0 && !haAssertionRosse(byTitle)) {
    throw new Error(
      `il reporter JSON dichiara ${suiteRosseDichiarate} suite fallite, ma non c'è né un'assertion rossa né un ` +
        `file non caricato: la lettura di testResults è disallineata dal formato di vitest, e un rosso sta passando in silenzio`,
    );
  }
  return byTitle;
}

/** L'esito peggiore fra i due, con `failed` in cima: serve solo a non perdere un rosso per omonimia. */
function peggiore(a: TestOutcome, b: TestOutcome): TestOutcome {
  const gravita = (s: VitestStatus): number => (s === 'failed' ? 3 : s === 'skipped' || s === 'pending' ? 2 : 1);
  return gravita(a.status) >= gravita(b.status) ? a : b;
}

function haAssertionRosse(byTitle: Map<string, TestOutcome>): boolean {
  for (const esito of byTitle.values()) if (esito.status === 'failed') return true;
  return false;
}

/**
 * **Tutti** i nomi completi con cui vitest può aver registrato lo scenario
 * `title` — non il primo che capita.
 *
 * Tre forme, in unione e non in cascata:
 *
 *  1. `title` esatto (la suite vera non lo produce mai da sola: ogni scenario
 *     vive dentro un `describe`, quindi il `fullName` è sempre prefissato).
 *  2. suffisso: vitest unisce il describe e il titolo dell'`it` con **uno
 *     spazio** — misurato, non ricordato: un `it("A5 …")` dentro
 *     `describe("acceptance · A · doctor, backup")` produce `fullName ===
 *     "acceptance · A · doctor, backup A5 …"`.
 *  3. salto dichiarato: `annunciaSalto` appende ` [non provabile qui: <motivo>]`,
 *     quindi il `fullName` non finisce più con `title`. Senza questa forma il
 *     ramo `non-provabile-qui` di `verdictFor` era irraggiungibile dalla
 *     produzione — si usciva prima con `nessuno-scenario` — e lo stesso test si
 *     contava due volte: una come riga scoperta, una come «fuori inventario».
 *
 * Unione e non cascata perché la cascata sceglieva: `find` prendeva la **prima**
 * voce in ordine di inserimento, e una precedenza sulla chiave esatta non
 * ripara niente su un percorso dove la chiave esatta non esiste. Il verde falso
 * che questo chiude: uno scenario reale `skipped` con motivo dichiarato (forma
 * 3) più un test estraneo inserito prima il cui nome finisce con lo stesso
 * titolo (forma 2) — la riga stampava `verde` sull'esito dell'estraneo, lo
 * scenario vero finiva in «fuori inventario · non provabile qui» senza contare
 * come rosso, e il report usciva 0 su una riga che nessuno aveva eseguito.
 *
 * Due candidati non sono un ballottaggio da vincere ai punti: sono un difetto
 * del manifest o della suite, e `verdictFor` li chiama `rosso-inatteso` con i
 * nomi in chiaro invece di sceglierne uno.
 */
export function chiaviEsito(title: string, results: Map<string, TestOutcome>): string[] {
  const trovate: string[] = [];
  for (const full of results.keys()) {
    if (full === title || full.endsWith(title) || senzaMotivo(full).endsWith(title)) trovate.push(full);
  }
  return trovate;
}

export type RowVerdict =
  | { kind: 'verde' }
  | { kind: 'rosso-inatteso'; detail: string }
  | { kind: 'atteso-rosso'; reason: string; closedBy: string }
  | { kind: 'atteso-rosso-ora-verde'; reason: string; closedBy: string }
  | { kind: 'non-provabile-qui'; reason: string }
  | { kind: 'provata-dal-meccanismo'; reason: string }
  | { kind: 'nessuno-scenario' };

export function verdictFor(
  row: InventoryRow,
  scenariosForRow: ScenarioEntry[],
  results: Map<string, TestOutcome>,
): RowVerdict {
  if (scenariosForRow.length === 0) {
    const reason = NOT_PROVABLE_HERE[row.id];
    return reason ? { kind: 'non-provabile-qui', reason } : { kind: 'nessuno-scenario' };
  }
  // One scenario per row today (the manifest is 1:1); a row with more than one
  // is reported on the first, since a mixed verdict across scenarios for the
  // same row would need its own presentation this suite does not need yet.
  const scenario = scenariosForRow[0]!;
  // `provata-dal-meccanismo` never registers a real `it()` (scenario.ts
  // refuses to — see its own comment), so there is no vitest outcome to look
  // up for it and looking would always miss, mis-filing it as `nessuno
  // scenario` next to rows that genuinely have no coverage at all.
  if (scenario.expectation.kind === 'provata-dal-meccanismo') {
    return { kind: 'provata-dal-meccanismo', reason: scenario.expectation.reason };
  }
  // Una sola ricerca, `chiaviEsito`, invece di due `find` con criteri diversi:
  // erano due, e il secondo cercava una forma che il primo aveva già escluso.
  const chiavi = chiaviEsito(scenario.title, results);
  if (chiavi.length === 0) {
    return { kind: 'nessuno-scenario' }; // registered in the manifest, but vitest never ran it
  }
  if (chiavi.length > 1) {
    return {
      kind: 'rosso-inatteso',
      detail:
        `titolo ambiguo: ${chiavi.length} esiti di vitest finiscono con "${scenario.title}" — ` +
        `${chiavi.map((c) => `"${c.slice(0, 90)}"`).join(', ')}. Un verdetto scelto fra questi sarebbe un ` +
        `lancio di moneta: rinomina il test estraneo o la riga di manifest.`,
    };
  }
  const chiave = chiavi[0]!;
  const { status, failureMessages } = results.get(chiave)!;
  // Saltato **dichiarando** perché: `scenario(..., nonProvabileQui)` mette il
  // motivo nel titolo del test, e questo è il posto dove quel motivo diventa un
  // verdetto contato invece di un `rosso-inatteso` con scritto «stato vitest:
  // skipped». Derivato dalla corsa, non da `NOT_PROVABLE_HERE` — quella tabella
  // si scrive a mano e vale solo per le righe *senza* scenario, quindi non può
  // dire niente su una macchina che oggi non può provare ciò che ieri provava.
  const dichiarato = MOTIVO_NEL_TITOLO.exec(chiave);
  if (status === 'skipped' && dichiarato?.[1]) {
    return { kind: 'non-provabile-qui', reason: dichiarato[1] };
  }
  if (scenario.expectation.kind === 'verde') {
    return status === 'passed' ? { kind: 'verde' } : { kind: 'rosso-inatteso', detail: `stato vitest: ${status}` };
  }
  const { reason, closedBy } = scenario.expectation;
  if (status === 'passed') return { kind: 'atteso-rosso', reason, closedBy };
  // Not passed: `scenario.ts` wraps every atteso-rosso body in a plain `it`
  // now, so this is either the promotion marker (the function stopped
  // throwing) or a failure that did not match `expectFailure` — and only the
  // marker means "promote". Anything else, including a status this map
  // cannot even see the message for, is `rosso-inatteso`: never the silent
  // default of "must be fine".
  return failureMessages.some((m) => m.includes(promoteMarker(row.id)))
    ? { kind: 'atteso-rosso-ora-verde', reason, closedBy }
    : {
        kind: 'rosso-inatteso',
        detail: `atteso-rosso con una firma diversa da quella dichiarata ("${reason}") — ${firstLine(failureMessages[0])}`,
      };
}

/** The message's own first line, without the stack trace `failureMessages` also carries. */
function firstLine(message: string | undefined): string {
  if (message === undefined) return '(nessun dettaglio di fallimento nel reporter JSON)';
  return message.split('\n')[0]!;
}

export type Summary = {
  lines: string[];
  counts: {
    verde: number;
    attesoRosso: number;
    unexpectedRed: number;
    attesoRossoOraVerde: number;
    nonProvabile: number;
    provataDalMeccanismo: number;
    nessunoScenario: number;
    readyWithoutScenario: number;
    readyWithAttesoRosso: number;
    orphanRows: number;
    /** Esiti vitest che nessuna riga del manifest rivendica — di cui `fuoriInventarioRossi` sono rossi o saltati in silenzio. */
    fuoriInventario: number;
    fuoriInventarioRossi: number;
  };
  /** Whether the report should fail the process — the gate, as one boolean instead of scattered across counters. */
  failed: boolean;
};

/**
 * Cross-references the inventory against the manifest and a suite's results,
 * and decides pass/fail. Pure and synchronous on purpose — this is the whole
 * gate, and `report.test.ts` calls it directly with synthetic inputs rather
 * than through a real inventory and a real vitest subprocess.
 */
export function summarize(inventory: InventoryRow[], manifest: readonly ScenarioEntry[], results: Map<string, TestOutcome>): Summary {
  const byRow = new Map<string, ScenarioEntry[]>();
  for (const s of manifest) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);

  const lines: string[] = [];
  let unexpectedRed = 0;
  let readyWithoutScenario = 0;
  let readyWithAttesoRosso = 0;
  let verde = 0;
  let attesoRosso = 0;
  let nessunoScenario = 0;
  let nonProvabile = 0;
  let provataDalMeccanismo = 0;
  let attesoRossoOraVerde = 0;

  /**
   * A manifest entry whose row id does not exist in the live inventory.
   *
   * The loop below walks `inventory`, not `byRow` — so before this check
   * existed, a typo'd id (`Z9`) or a row the inventory renumbered away from under
   * the manifest simply never got visited: not printed, not counted, exit
   * code untouched. The header still said "N scenari" (`manifest.length`
   * does not care), and the row it was supposed to prove looked exactly like
   * one nobody had written a scenario for yet. Silent, and one level above
   * the exact class of gap this whole report exists to surface — found by a
   * judge, not by this file, which is the reason to fix it here rather than
   * trust a future reader to notice a scenario count that does not add up.
   */
  const orphanRows = [...byRow.keys()].filter((row) => !inventory.some((r) => r.id === row));
  for (const row of orphanRows) {
    lines.push(
      `  ORFANO             ${row}  nel manifest ma non nei requisiti DAY-1 — ${byRow
        .get(row)!
        .map((s) => s.title)
        .join('; ')}`,
    );
  }

  for (const row of inventory) {
    const verdict = verdictFor(row, byRow.get(row.id) ?? [], results);
    switch (verdict.kind) {
      case 'verde':
        verde++;
        lines.push(`  verde              ${row.id}  ${row.area}`);
        break;
      case 'rosso-inatteso':
        unexpectedRed++;
        lines.push(`  ROSSO-INATTESO     ${row.id}  ${row.area} — ${verdict.detail}`);
        break;
      case 'atteso-rosso':
        attesoRosso++;
        // readiness-criteria.md#day-1-ready (P39): a row this inventory calls `READY` —
        // "implementata, cablata, provata, e il percorso reale ci arriva" —
        // cannot also carry a scenario that is still red on purpose. One of
        // the two statements is wrong, and the report has to say which
        // rather than print both and let a reader average them.
        if (row.stato === 'READY') {
          readyWithAttesoRosso++;
          lines.push(
            `  atteso-rosso       ${row.id}  ${row.area} — ${verdict.reason} (chiude: ${verdict.closedBy})  ` +
              `⚠️  READY ma scenario atteso-rosso: promuovi o degrada`,
          );
        } else {
          lines.push(`  atteso-rosso       ${row.id}  ${row.area} — ${verdict.reason} (chiude: ${verdict.closedBy})`);
        }
        break;
      case 'atteso-rosso-ora-verde':
        attesoRossoOraVerde++;
        lines.push(
          `  ATTESO-ROSSO→VERDE ${row.id}  ${row.area} — la ragione dichiarata non vale più, promuovi lo scenario ` +
            `a verde (era: ${verdict.reason})`,
        );
        break;
      case 'non-provabile-qui':
        nonProvabile++;
        lines.push(`  non provabile qui  ${row.id}  ${row.area} — ${verdict.reason}`);
        break;
      case 'provata-dal-meccanismo':
        provataDalMeccanismo++;
        lines.push(`  provata dal meccanismo  ${row.id}  ${row.area} — ${verdict.reason}`);
        break;
      case 'nessuno-scenario':
        nessunoScenario++;
        if (row.stato === 'READY') readyWithoutScenario++;
        lines.push(`  nessuno scenario   ${row.id}  ${row.area}${row.stato === 'READY' ? '  ⚠️  riga READY' : ''}`);
        break;
    }
  }

  /**
   * Ciò che vitest ha eseguito e che nessuna riga rivendica.
   *
   * Il ciclo qui sopra cammina l'inventario, quindi un file `.accept.ts` che non
   * passa dal manifest — `b-job-script`, oggi — non viene visitato: non stampato,
   * non contato, e **non fallisce il report anche quando è rosso**. Per chi
   * legge questo report, che il readiness-criteria.md#day-1-ready tratta come il gate
   * autoritativo, un rosso che non arriva qui è indistinguibile da uno scenario
   * mai esistito. È il buco che il judge di `slice/linux-la-macchina-che-conta`
   * ha nominato, ed è più vecchio di quella slice.
   *
   * Non li promuovo a requisiti DAY-1: non lo sono. Li dichiaro, e un loro
   * fallimento fa fallire il report come qualsiasi altro rosso.
   */
  /**
   * Rivendicato = la chiave esatta che `verdictFor` ha guardato per quella
   * riga, non «un nome che contiene il titolo».
   *
   * `nome.includes(t)` sussumeva `nome.endsWith(t)` — la condizione era solo
   * `includes` — e scartava in silenzio un esito **rosso** fuori inventario il
   * cui nome citasse un titolo di manifest come sottostringa: con manifest
   * `"A1 il giro"` e un extra rosso `"fuori inventario che parla di A1 il giro
   * e poi rompe"`, `failed` restava `false`. Passando per `chiaviEsito` la
   * deduplica e il verdetto guardano per costruzione lo stesso esito, quindi
   * non possono più divergere: né doppio conteggio, né rosso ingoiato.
   */
  const chiaviRivendicate = new Set<string>();
  for (const s of manifest) for (const chiave of chiaviEsito(s.title, results)) chiaviRivendicate.add(chiave);
  const orfaniDiScenario: { nome: string; stato: string }[] = [];
  for (const [nome, esito] of results) {
    if (chiaviRivendicate.has(nome)) continue;
    orfaniDiScenario.push({ nome, stato: esito.status });
  }
  let orfaniRossi = 0;
  for (const o of orfaniDiScenario) {
    const saltatoDichiarando = o.stato === 'skipped' && MOTIVO_NEL_TITOLO.test(o.nome);
    if (o.stato === 'passed' || saltatoDichiarando) {
      lines.push(
        `  fuori inventario   ${saltatoDichiarando ? 'non provabile qui' : 'verde'} — ${o.nome.slice(0, 110)}`,
      );
      continue;
    }
    orfaniRossi++;
    lines.push(`  FUORI INVENTARIO ROSSO — ${o.nome.slice(0, 110)} (stato vitest: ${o.stato})`);
  }

  const failed =
    unexpectedRed > 0 ||
    readyWithoutScenario > 0 ||
    readyWithAttesoRosso > 0 ||
    attesoRossoOraVerde > 0 ||
    orphanRows.length > 0 ||
    orfaniRossi > 0;

  return {
    lines,
    counts: {
      verde,
      attesoRosso,
      unexpectedRed,
      attesoRossoOraVerde,
      nonProvabile,
      provataDalMeccanismo,
      nessunoScenario,
      readyWithoutScenario,
      readyWithAttesoRosso,
      orphanRows: orphanRows.length,
      fuoriInventario: orfaniDiScenario.length,
      fuoriInventarioRossi: orfaniRossi,
    },
    failed,
  };
}

function main(): void {
  const inventory = parseInventory();
  const results = acceptanceResults();
  const { lines, counts, failed } = summarize(inventory, MANIFEST, results);

  // `MANIFEST.length` alone would count E4 too, but a `provata-dal-meccanismo`
  // entry never registers a real `it()` (scenario.ts refuses to) — counting it
  // here would make this header disagree with what `npm run test:acceptance`
  // actually runs, which is exactly the kind of stale count this report exists
  // to prevent elsewhere.
  const scenariReali = MANIFEST.filter((s) => s.expectation.kind !== 'provata-dal-meccanismo').length;
  process.stdout.write(
    `Accettazione requisiti DAY-1 — ${inventory.length} righe, ${scenariReali} scenari\n\n`,
  );
  process.stdout.write(`${lines.join('\n')}\n\n`);
  process.stdout.write(
    `verde ${counts.verde} · atteso-rosso ${counts.attesoRosso} · rosso-inatteso ${counts.unexpectedRed} · ` +
      `atteso-rosso→verde ${counts.attesoRossoOraVerde} · non provabile qui ${counts.nonProvabile} · ` +
      `provata dal meccanismo ${counts.provataDalMeccanismo} · nessuno scenario ${counts.nessunoScenario} · ` +
      `orfano ${counts.orphanRows} · fuori inventario ${counts.fuoriInventario} (di cui rossi ${counts.fuoriInventarioRossi})\n`,
  );

  if (failed) {
    process.stdout.write(
      `\nFALLITO: ${counts.unexpectedRed} rosso-inatteso, ${counts.readyWithoutScenario} riga READY senza scenario, ` +
        `${counts.readyWithAttesoRosso} riga READY con scenario atteso-rosso (promuovi o degrada), ` +
        `${counts.attesoRossoOraVerde} atteso-rosso da promuovere, ${counts.orphanRows} scenario orfano nel manifest, ` +
        `${counts.fuoriInventarioRossi} rosso fuori inventario.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    '\nOK: nessun rosso inatteso, nessuna riga READY scoperta o in contraddizione con un atteso-rosso, ' +
      'nessuno scenario orfano.\n',
  );
}

// Only run the real thing (parse the live requirements inventory, spawn the real suite)
// when this file is the process entrypoint — never on import. `report.test.ts`
// imports `verdictFor`/`summarize` for their pure logic; without this guard
// that import would trigger a ~60s subprocess spawn as a side effect of
// loading the module, once per test file.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) main();
