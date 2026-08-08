import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxExecutor } from '../../core/sandbox/executor.js';

/**
 * The overhead ADR-0018 owes: how much wall-clock the sandbox wrapper adds per
 * command, measured on THIS host, in a loop — the gap A6 §5.6 flagged as
 * unmeasured across the whole field.
 *
 * Method: warm the executor (the srt proxy starts once), then time N contained
 * runs of a trivial command against N plain `spawnSync` runs of the same
 * command. The delta is the per-command cost of containment — profile
 * generation + the sandbox-exec/bwrap fork — not of doing real work.
 *
 * Safe to run: no model, no network, no cost. Prints numbers; writes nothing.
 *
 *   tsx evals/system/sandbox-overhead.ts
 *   tsx evals/system/sandbox-overhead.ts --n 100
 */

const N = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 40);
const CMD = 'true'; // does nothing — we are timing the wrapper, not the work

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-overhead-'));
  const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] });

  const status = executor.status();
  if (!status.available) {
    process.stderr.write(`sandbox non disponibile: ${status.reason} — ${status.remedy}\n`);
    process.exit(1);
  }
  process.stdout.write(`sandbox: ${status.mechanism} · ${N} run di \`${CMD}\`\n`);

  // Warm-up: first run pays proxy init + first profile compile — excluded.
  await executor.run({ command: CMD, cwd: workspace, writeScope: [workspace] });

  const contained: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await executor.run({ command: CMD, cwd: workspace, writeScope: [workspace] });
    contained.push(performance.now() - t);
  }

  const plain: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    spawnSync('/bin/sh', ['-c', CMD], { cwd: workspace, stdio: 'ignore' });
    plain.push(performance.now() - t);
  }

  await executor.close();
  rmSync(workspace, { recursive: true, force: true });

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const cMed = median(contained);
  const pMed = median(plain);
  process.stdout.write(
    `contenuto:  mediana ${cMed.toFixed(1)}ms  (min ${Math.min(...contained).toFixed(1)}, max ${Math.max(...contained).toFixed(1)})\n` +
      `spawn nudo: mediana ${pMed.toFixed(1)}ms\n` +
      `overhead per comando: ~${(cMed - pMed).toFixed(1)}ms\n`,
  );
}

void main();
