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

/**
 * La seconda meta della catena, e per la stessa ragione della prima.
 *
 * `GATE_EXIT=$?` sta **fuori** dalla stringa fra apici singoli del container,
 * quindi i marcatori del blocco interno non possono raggiungerla per
 * costruzione: allargarli non e la riparazione. Finche questa coda era asserita
 * da due grep sul testo, una riga di pulizia perfettamente plausibile inserita
 * fra `docker run` e la cattura — lo script lascia dietro un clone intero in
 * `$OUT/src` e `$OUT/repo.tar` a ogni corsa, quindi `rm -f "$OUT/repo.tar"` e
 * proprio il genere di riga che ci finisce — azzerava `$?` e riportava il gate
 * a dire VERDE con il container uscito 1. I grep non possono vedere un comando
 * *aggiunto*: vedono solo che le righe che cercano esistono ancora.
 *
 * Qui la coda si esegue davvero, con un finto `docker` su `PATH` che esce con
 * il codice che vogliamo: `$OUT` e `$IMAGE` diventano argomenti del finto, e la
 * stringa del container non viene mai espansa (apici singoli).
 */
const APRE_CODA = /^set \+e$/m;
const CHIUDE_CODA = /^exit "\$GATE_EXIT"$/m;

export function codaEsterna(script: string): string {
  const inizio = APRE_CODA.exec(script);
  const fine = CHIUDE_CODA.exec(script);
  if (inizio === null || fine === null || fine.index < inizio.index) {
    throw new Error(
      'gate-linux.sh non ha piu una coda esterna riconoscibile (`set +e` … `exit "$GATE_EXIT"` a inizio riga). ' +
        'Se la forma e cambiata, aggiorna questa estrazione: senza, questo test non prova niente.',
    );
  }
  return script.slice(inizio.index, fine.index + fine[0].length);
}

describe('gate-linux.sh — la coda esterna, quella che decide l-esito dello script', () => {
  function eseguiConDocker(codice: number): { status: number | null; stdout: string } {
    const finto = join(lavoro, 'docker');
    writeFileSync(finto, `#!/usr/bin/env bash\nexit ${codice}\n`);
    chmodSync(finto, 0o755);

    const script = [
      `OUT=${JSON.stringify(join(lavoro, 'out'))}`,
      'IMAGE=immagine-finta',
      `PATH=${JSON.stringify(lavoro)}:$PATH`,
      codaEsterna(readFileSync(GATE, 'utf8')),
      '',
    ].join('\n');
    const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8' });
    return { status: run.status, stdout: `${run.stdout}${run.stderr}` };
  }

  it('esce 0 e dice VERDE quando il container esce 0', () => {
    const { status, stdout } = eseguiConDocker(0);
    expect(status).toBe(0);
    expect(stdout).toContain('GATE LINUX VERDE');
  });

  it('esce non-zero e dice ROSSO quando il container esce 1 — la suite rossa su Linux', () => {
    const { status, stdout } = eseguiConDocker(1);
    expect(status).toBe(1);
    expect(stdout).toContain('GATE LINUX ROSSO');
    expect(stdout).not.toContain('GATE LINUX VERDE');
  });

  it('non ingoia nemmeno un fallimento di docker stesso (125: immagine assente)', () => {
    // 125 e docker che non e riuscito a far partire il container: un gate che
    // non ha girato non e un gate verde.
    const { status, stdout } = eseguiConDocker(125);
    expect(status).toBe(125);
    expect(stdout).toContain('GATE LINUX ROSSO');
  });
});
