/**
 * Riepilogo dei test marcati con una capacità, dal report JSON di Vitest.
 *
 *   npx tsx scripts/test-capability-report.ts <report.json>        # solo riepilogo
 *   npx tsx scripts/test-capability-report.ts --ci <report.json>   # giudica
 *
 * Con `--ci` le capacità richieste vengono da `MUFFIN_REQUIRE_CAPABILITIES`
 * (gli stessi alias del globalSetup) e lo script esce 1 se:
 * - un test marcato con una capacità richiesta è saltato;
 * - hanno girato meno test marcati del minimo in `test-support/capability-minimums.json`;
 * - un'etichetta nomina una capacità sconosciuta.
 *
 * È la seconda cintura dopo il globalSetup: quello ferma la run se la capacità
 * manca, questo controlla che i test che la usano abbiano girato davvero e che
 * non siano spariti in silenzio. Senza `--ci` stampa e basta (il pre-push).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CapabilityName,
  formatMarked,
  judgeMarked,
  requiredCapabilities,
  type TestOutcome,
  tallyMarked,
} from '../test-support/capability-policy.js';

type VitestJson = {
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
};

const args = process.argv.slice(2);
const ci = args.includes('--ci');
const file = args.find((a) => !a.startsWith('--'));
if (file === undefined) {
  console.error('uso: test-capability-report.ts [--ci] <report.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8')) as VitestJson;
const root = `${process.cwd()}/`;
const tests: TestOutcome[] = report.testResults.flatMap((f) =>
  f.assertionResults.map((a) => ({
    file: f.name.startsWith(root) ? f.name.slice(root.length) : f.name,
    fullName: a.fullName,
    status: a.status,
  })),
);

const summary = tallyMarked(tests);
console.log(formatMarked(summary));

if (ci) {
  const minimums = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', 'test-support', 'capability-minimums.json'),
      'utf8',
    ),
  ) as Partial<Record<CapabilityName, number>>;
  const required = requiredCapabilities();
  const problems = judgeMarked(summary, required, minimums);
  if (problems.length > 0) {
    console.error(`\nverde falso evitato — ${problems.length} problemi:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `\nOK: capacità richieste ${[...required].join(', ') || '(nessuna)'}; nessun salto di queste, minimi rispettati.`,
  );
}
