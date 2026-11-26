/**
 * Il lato test del registro delle capacità (`./capabilities.ts`).
 *
 * Uso:
 *
 *   const sandbox = capability('sandbox');
 *   describe.skipIf(!sandbox.ok)(withReason('il confine regge', sandbox), () => { … });
 *
 * Il valore arriva dal globalSetup (`vitest.capabilities.ts`) tramite
 * `provide`/`inject`: calcolato una volta per run, non una per worker. Se il
 * globalSetup non c'è (una config che non lo carica), `capability()` lancia a
 * raccolta: un file che non sa se può girare non deve né girare né saltare in
 * silenzio.
 */
import { inject } from 'vitest';
import type { Capability, CapabilityName, CapabilityReport } from './capabilities.js';

declare module 'vitest' {
  interface ProvidedContext {
    muffinCapabilities: CapabilityReport;
  }
}

export function capability(name: CapabilityName): Capability {
  const report = inject('muffinCapabilities');
  const c = report?.[name];
  if (c === undefined) {
    throw new Error(
      `capacità «${name}» non calcolata: questa config Vitest non carica vitest.capabilities.ts come globalSetup`,
    );
  }
  return c;
}

/**
 * Il nome del test con l'etichetta della capacità, sempre: `[richiede sandbox]`
 * quando gira, `[richiede sandbox — saltato: motivo]` quando salta. Il nome è
 * l'unico posto in cui un'etichetta e un motivo arrivano al report JSON
 * (misurato su vitest 2.1.9 e 5.1.2), ed è da lì che `scripts/test-capability-report.ts`
 * conta quanti test marcati hanno girato davvero. Un `describe` etichettato
 * marca tutti i test che contiene.
 */
export function withReason(name: string, c: Capability): string {
  return c.ok
    ? `${name} [richiede ${c.name}]`
    : `${name} [richiede ${c.name} — saltato: ${c.reason}]`;
}
