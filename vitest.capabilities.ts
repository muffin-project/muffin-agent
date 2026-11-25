/**
 * globalSetup: misura le capacità d'ambiente una volta per run e le passa ai
 * test (`test-support/requires.ts`). Se una capacità pretesa da
 * `MUFFIN_REQUIRE_CAPABILITIES` (o dagli alias storici) manca, la run fallisce
 * qui, prima di qualunque test, dicendo quale e perché.
 */
import type { GlobalSetupContext } from 'vitest/node';
import {
  decide,
  describeReport,
  forcedCapabilities,
  probeAll,
  requiredCapabilities,
} from './test-support/capabilities.js';

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const required = requiredCapabilities();
  const forced = forcedCapabilities();
  const { report, missingRequired } = decide(await probeAll(), required, forced);
  console.log(describeReport(report));
  if (missingRequired.length > 0) {
    const righe = missingRequired.map((n) => `  - ${n}: ${report[n].reason}`).join('\n');
    throw new Error(
      `capacità richieste ma assenti su questa macchina (MUFFIN_REQUIRE_CAPABILITIES):\n${righe}\n` +
        'Qui un salto sarebbe un verde falso: la run si ferma invece di contare i test come saltati.',
    );
  }
  provide('muffinCapabilities', report);
}
