import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Il gate Linux deve *uscire* rosso, non solo stamparlo.
 *
 * Finche i minuti GitHub non ci sono, `gate-linux.sh` e l'unico percorso
 * eseguibile che vede Linux — la piattaforma dove Muffin va a vivere. Il blocco
 * finale del suo script-container e quindi l'unica cosa che trasforma «la suite
 * e rossa» in «questo comando e fallito», per un hook, un loop o una persona
 * che ne legge solo l-exit code.
 *
 * Il difetto che questo file uccide: quel blocco finiva con `set -e`, che esce
 * 0. I due exit venivano *stampati* e nessuno li consumava, quindi con
 * `ACCEPT_EXIT=1` e `REPORT_EXIT=1` il container usciva 0, `docker run` usciva
 * 0, e `gate-linux.sh` — con `set -euo pipefail` — usciva 0.
 *
 * Il blocco viene **estratto dallo script vero** e non ricopiato qui: una copia
 * proverebbe la copia. Le due invocazioni passano per `$AS` (in produzione
 * `runuser -u nobody -- env HOME=...`), quindi basta puntare `AS` a un finto che
 * esce con gli esiti che vogliamo iniettare per far girare il blocco vero senza
 * Docker, senza container e senza la suite.
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const GATE = join(QUI, 'gate-linux.sh');
const APRE = '# >>> BLOCCO PROVATO DA gate-linux.test.ts';
const CHIUDE = '# <<< BLOCCO PROVATO DA gate-linux.test.ts';

/** Il blocco decisionale, letto da `gate-linux.sh` invece che ricopiato. */
export function bloccoDecisionale(script: string): string {
  const inizio = script.indexOf(APRE);
  const fine = script.indexOf(CHIUDE);
  if (inizio === -1 || fine === -1 || fine < inizio) {
    throw new Error(
      `gate-linux.sh non contiene piu i marcatori del blocco decisionale (${APRE} … ${CHIUDE}). ` +
        `Se il blocco e stato spostato, sposta i marcatori con lui: senza, questo test non prova niente.`,
    );
  }
  return script.slice(inizio + APRE.length, fine);
}

let lavoro: string;

beforeEach(() => {
  lavoro = mkdtempSync(join(tmpdir(), 'muffin-gate-linux-'));
});

afterEach(() => {
  rmSync(lavoro, { recursive: true, force: true });
});

/**
 * Esegue il blocco vero con i due esiti iniettati, nell-ordine in cui il blocco
 * invoca `$AS`. Il finto conta le proprie chiamate su file: cosi il test non
 * deve sapere *come* sono scritte le due righe, solo che sono due.
 */
function eseguiConEsiti(accept: number, report: number): { status: number | null; stdout: string } {
  const contatore = join(lavoro, 'chiamate');
  writeFileSync(contatore, '0\n');
  const finto = join(lavoro, 'finto-as');
  writeFileSync(
    finto,
    [
      '#!/usr/bin/env bash',
      'n=$(cat "$MUFFIN_FINTO_CONTATORE")',
      'echo $((n + 1)) > "$MUFFIN_FINTO_CONTATORE"',
      'IFS=, read -ra codici <<< "$MUFFIN_FINTO_CODICI"',
      'exit "${codici[$n]}"',
      '',
    ].join('\n'),
  );
  chmodSync(finto, 0o755);

  const script = `AS=${JSON.stringify(finto)}\n${bloccoDecisionale(readFileSync(GATE, 'utf8'))}\n`;
  const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MUFFIN_FINTO_CONTATORE: contatore,
      MUFFIN_FINTO_CODICI: `${accept},${report}`,
    },
  });
  return { status: run.status, stdout: `${run.stdout}${run.stderr}` };
}

describe('gate-linux.sh — il blocco che decide l-uscita del container', () => {
  it('esce 0 quando la suite e il report sono entrambi verdi', () => {
    const { status, stdout } = eseguiConEsiti(0, 0);
    expect(status).toBe(0);
    expect(stdout).toContain('ACCEPT_EXIT=0');
    expect(stdout).toContain('REPORT_EXIT=0');
  });

  it('esce non-zero quando la suite e rossa — il caso b-job-script su Linux', () => {
    const { status, stdout } = eseguiConEsiti(1, 0);
    expect(status).not.toBe(0);
    expect(stdout).toContain('ACCEPT_EXIT=1');
  });

  it('esce non-zero quando il report e rosso anche se la suite e verde', () => {
    // I due gate sono distinti: il report puo fallire su una riga READY
    // scoperta o su un rosso fuori inventario con ogni test verde.
    const { status, stdout } = eseguiConEsiti(0, 1);
    expect(status).not.toBe(0);
    expect(stdout).toContain('REPORT_EXIT=1');
  });

  it('non confonde i due esiti fra loro', () => {
    const { stdout } = eseguiConEsiti(3, 7);
    expect(stdout).toContain('ACCEPT_EXIT=3');
    expect(stdout).toContain('REPORT_EXIT=7');
  });
});

describe('gate-linux.sh — lo script esterno', () => {
  const script = readFileSync(GATE, 'utf8');

  it('propaga l-esito del container invece di finire sull-ultimo comando', () => {
    expect(script).toMatch(/^exit "\$GATE_EXIT"$/m);
  });

  it('dice se e verde o rosso', () => {
    expect(script).toContain('GATE LINUX ROSSO');
    expect(script).toContain('GATE LINUX VERDE');
  });
});
