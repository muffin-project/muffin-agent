import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Il gate locale deve *uscire* rosso, non solo stamparlo — e soprattutto non
 * deve poter stampare verde uscendo bene per un motivo che non e «tutto e
 * passato».
 *
 * Il difetto di classe che questo file uccide e lo stesso gia ucciso su
 * `gate-linux.sh` (v. `evals/acceptance/gate-linux.test.ts`): un blocco finale
 * che stampa un esito invece di consumarlo. Qui il rischio e speculare — il
 * verdetto sta in un trap EXIT, e un trap che guarda solo `$?` direbbe verde a
 * un `exit 0` anticipato che non ha fatto girare niente.
 *
 * Il blocco viene **estratto dallo script vero**, non ricopiato: una copia
 * proverebbe la copia.
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const GATE = join(QUI, 'local-gate.sh');
const APRE = '# >>> BLOCCO PROVATO DA local-gate.test.ts';
const CHIUDE = '# <<< BLOCCO PROVATO DA local-gate.test.ts';

export function bloccoVerdetto(script: string): string {
  const inizio = script.indexOf(APRE);
  const fine = script.indexOf(CHIUDE);
  if (inizio === -1 || fine === -1 || fine < inizio) {
    throw new Error(
      `local-gate.sh non contiene piu i marcatori del verdetto (${APRE} … ${CHIUDE}). ` +
        `Se il blocco e stato spostato, sposta i marcatori con lui: senza, questo test non prova niente.`,
    );
  }
  return script.slice(inizio + APRE.length, fine);
}

/**
 * Fa girare il verdetto vero con lo stato che vogliamo iniettare.
 *
 * `coda` e cio che lo script farebbe dopo il trap: `PASSATO=1` quando tutti i
 * passi sono passati, un `exit` quando uno e caduto, niente quando qualcuno in
 * futuro aggiungesse un'uscita anticipata.
 */
function esegui(coda: string): { status: number | null; stdout: string; stderr: string } {
  const script = [
    'SHA=abc123def456',
    'LAVORO=""',
    'PASSATO=0',
    bloccoVerdetto(readFileSync(GATE, 'utf8')),
    coda,
  ].join('\n');
  const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('local-gate.sh — il verdetto', () => {
  it('stampa PASS con lo SHA esatto solo quando tutti i passi sono passati', () => {
    const { status, stdout } = esegui('PASSATO=1');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('LOCAL-GATE PASS @ abc123def456');
  });

  it('esce non-zero e dice FAIL quando un passo cade', () => {
    const { status, stdout, stderr } = esegui('exit 7');
    expect(status).toBe(7);
    expect(stderr).toContain('LOCAL-GATE FAIL @ abc123def456');
    expect(stdout).not.toContain('PASS');
  });

  it('un uscita zero senza aver girato resta rossa — il caso pericoloso', () => {
    // Se un domani qualcuno inserisse un `exit 0` prima della fine (una scorciatoia,
    // un `if` che salta i passi lenti), `$?` direbbe 0. Senza `PASSATO=1` deve
    // comunque uscire 1: un rosso non puo stampare verde.
    const { status, stdout, stderr } = esegui('exit 0');
    expect(status).toBe(1);
    expect(stdout).not.toContain('PASS');
    expect(stderr).toContain('LOCAL-GATE FAIL');
  });

  it('non stampa mai «CI»: questo gate non e CI', () => {
    // Il gate gira sulla macchina dell owner, con la sua rete e la sua Docker.
    // Chiamarlo CI e la scorciatoia che fa leggere a un futuro handoff «CI verde».
    const testo = readFileSync(GATE, 'utf8');
    const righeStampate = testo
      .split('\n')
      .filter((r) => !/^\s*#/.test(r))
      .filter((r) => /\b(echo|printf)\b/.test(r) || r.includes('LOCAL-GATE'));
    expect(righeStampate.some((r) => r.includes('LOCAL-GATE PASS'))).toBe(true);
    for (const riga of righeStampate) {
      expect(riga).not.toMatch(/\bCI\b/);
    }
  });

  it('cancella la directory di lavoro, e la tiene solo se richiesto', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(
        'bash',
        [
          '-euo',
          'pipefail',
          '-c',
          [
            'SHA=abc',
            'LAVORO="$(mktemp -d)"',
            'PASSATO=0',
            'echo "$LAVORO"',
            bloccoVerdetto(readFileSync(GATE, 'utf8')),
            'PASSATO=1',
          ].join('\n'),
        ],
        { encoding: 'utf8', env: { ...process.env, ...env } },
      );
    const via = run({}).stdout.split('\n')[0] ?? '';
    expect(via.length).toBeGreaterThan(0);
    expect(existsSync(via)).toBe(false);

    const tenuta = run({ MUFFIN_GATE_TIENI: '1' }).stdout.split('\n')[0] ?? '';
    expect(tenuta.length).toBeGreaterThan(0);
    expect(existsSync(tenuta)).toBe(true);
    rmSync(tenuta, { recursive: true, force: true });
  });
});
