import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import DatabaseCtor from 'better-sqlite3';
import { paths } from '../core/config/config.js';
import {
  type CandidatePolicy,
  DEFAULT_POLICY,
  formatReport,
  readShadowEvidence,
} from '../core/judgment/report.js';

/**
 * `muffin judgments report` — il controfattuale della fase 2 (#740), da
 * terminale.
 *
 * Come `muffin effects`, sta nel secchio *developer/operator* della VISION:
 * è la porta per leggere la calibrazione quando serve una risposta senza
 * spendere un modello. **Non consuma e non configura niente**: le soglie
 * passate da riga di comando valgono per questo report soltanto — la
 * promozione di una classe è un atto dell'owner, non un flag.
 *
 * Una sola lettura per qualunque porta futura (`formatReport` sopra
 * `readShadowEvidence`): una dashboard domani non può rispondere una cosa
 * diversa da questa.
 */

const USAGE = `usage: muffin judgments report [--match-above 0.7] [--danger-below 0.2] [--recovery-above 0.5] [--db <path>]
  cosa avrebbe fatto /auto sugli ask gia' avvenuti, con le soglie dette:
  false-safe, escalation inutili, accordo — per domanda e per categoria.
  --match-above     soglia delle domande di corrispondenza (default 0.7)
  --danger-below    soglia delle domande di pericolo (default 0.2)
  --recovery-above  soglia della recuperabilita' (default 0.5)
  --db              un database diverso da quello dell'installazione, in sola lettura
`;

export function cmdJudgments(argv: string[]): number {
  let values: Partial<{
    'match-above': string;
    'danger-below': string;
    'recovery-above': string;
    db: string;
  }>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        'match-above': { type: 'string' },
        'danger-below': { type: 'string' },
        'recovery-above': { type: 'string' },
        db: { type: 'string' },
      },
      allowPositionals: true,
    }) as { values: typeof values; positionals: string[] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 78;
  }

  if (positionals.length === 0) {
    // `muffin judgments` senza sottocomando: oggi il report è l'unica cosa
    // che questa famiglia sa fare, e `report` è sottocomando per lasciare al
    // verbo lo spazio per ciò che la fase 3 porterà (le classi, la busta).
    process.stderr.write(`usage: muffin judgments <report>\n${USAGE}`);
    return 78;
  }
  if (positionals.length > 1 || positionals[0] !== 'report') {
    process.stderr.write(`sottocomando sconosciuto: ${positionals.join(' ')}\n${USAGE}`);
    return 78;
  }

  const soglia = (nome: string, testo: string | undefined, defaultV: number): number | null => {
    if (testo === undefined) return defaultV;
    const v = Number(testo);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      process.stderr.write(`${nome} deve essere un numero fra 0 e 1, non «${testo}»\n${USAGE}`);
      return null;
    }
    return v;
  };
  const matchAbove = soglia('--match-above', values['match-above'], DEFAULT_POLICY.matchAbove);
  const dangerBelow = soglia('--danger-below', values['danger-below'], DEFAULT_POLICY.dangerBelow);
  const recoveryAbove = soglia(
    '--recovery-above',
    values['recovery-above'],
    DEFAULT_POLICY.recoveryAbove,
  );
  if (matchAbove === null || dangerBelow === null || recoveryAbove === null) return 78;

  const file = values['db'] ?? paths().db;
  if (!existsSync(file)) {
    process.stderr.write(`nessun database in ${file}\n`);
    return 78;
  }

  const policy: CandidatePolicy = { matchAbove, dangerBelow, recoveryAbove };
  const db = new DatabaseCtor(file, { readonly: true, fileMustExist: true });
  try {
    process.stdout.write(`${formatReport(readShadowEvidence(db), policy)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
