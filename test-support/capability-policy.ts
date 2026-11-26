/**
 * La parte pura del registro delle capacità: nomi, richieste, forzature, la
 * decisione e il conteggio dei test marcati. Niente probe e nessun import
 * pesante, così la può usare anche `scripts/test-capability-report.ts`.
 */
export const CAPABILITY_NAMES = ['sandbox', 'shell-boundary', 'systemd-analyze', 'plutil'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type Capability = {
  /** Il nome nel registro: finisce nell'etichetta del test. */
  name: CapabilityName;
  /** La capacità c'è (o è stata forzata, vedi `forced`). */
  ok: boolean;
  /** Perché sì o perché no, in parole. Mai vuota. */
  reason: string;
  /** Questa run la pretende: un salto qui sarebbe un difetto. */
  required: boolean;
  /** Forzata con `MUFFIN_FORCE_CAPABILITIES`: i test girano anche se il probe dice no. */
  forced: boolean;
};

export type CapabilityReport = Record<CapabilityName, Capability>;

type Probe = { ok: boolean; reason: string };

function parseList(name: string, value: string | undefined): CapabilityName[] {
  if (value === undefined || value.trim() === '') return [];
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const n of names) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(n)) {
      throw new Error(
        `${name}: capacità sconosciuta «${n}». Note: ${CAPABILITY_NAMES.join(', ')}.`,
      );
    }
  }
  return names as CapabilityName[];
}

/**
 * Le capacità pretese da questa run. Le due variabili storiche restano alias:
 * `MUFFIN_REQUIRE_SANDBOX=1` pretendeva sia il contenimento sia il confine shell
 * (vedi `evals/system/acceptance.test.ts`), `MUFFIN_REQUIRE_SYSTEMD=1` il parser.
 */
export function requiredCapabilities(env: NodeJS.ProcessEnv = process.env): Set<CapabilityName> {
  const required = new Set(
    parseList('MUFFIN_REQUIRE_CAPABILITIES', env['MUFFIN_REQUIRE_CAPABILITIES']),
  );
  if (env['MUFFIN_REQUIRE_SANDBOX'] === '1') {
    required.add('sandbox');
    required.add('shell-boundary');
  }
  if (env['MUFFIN_REQUIRE_SYSTEMD'] === '1') required.add('systemd-analyze');
  return required;
}

/**
 * Capacità forzate: i test girano anche se il probe dice no, e falliscono per
 * il motivo vero. Serve alla prova di mutazione della CI (togli i deny
 * AppArmor, il test di produzione deve diventare rosso nominando
 * `git_hooks_unprotected`): senza forzatura quel test salterebbe.
 */
export function forcedCapabilities(env: NodeJS.ProcessEnv = process.env): Set<CapabilityName> {
  return new Set(parseList('MUFFIN_FORCE_CAPABILITIES', env['MUFFIN_FORCE_CAPABILITIES']));
}

/** Combina probe, richieste e forzature. Puro: è la parte che i test unitari coprono. */
export function decide(
  probes: Record<CapabilityName, Probe>,
  required: Set<CapabilityName>,
  forced: Set<CapabilityName>,
): { report: CapabilityReport; missingRequired: CapabilityName[] } {
  const report = {} as CapabilityReport;
  const missingRequired: CapabilityName[] = [];
  for (const name of CAPABILITY_NAMES) {
    const probe = probes[name];
    const isForced = forced.has(name) && !probe.ok;
    report[name] = {
      name,
      ok: probe.ok || isForced,
      reason: isForced
        ? `forzata da MUFFIN_FORCE_CAPABILITIES; il probe dice: ${probe.reason}`
        : probe.reason,
      required: required.has(name),
      forced: isForced,
    };
    if (required.has(name) && !probe.ok && !isForced) missingRequired.push(name);
  }
  return { report, missingRequired };
}

/** Una riga per capacità, per il log della run. */
export function describeReport(report: CapabilityReport): string {
  return CAPABILITY_NAMES.map((name) => {
    const c = report[name];
    const stato = c.forced ? 'FORZATA' : c.ok ? 'sì' : 'no';
    const req = c.required ? ' (richiesta)' : '';
    return `[capacità] ${name}: ${stato}${req} — ${c.reason}`;
  }).join('\n');
}

/** L'etichetta che `withReason` mette nel nome di ogni test marcato. */
const MARKER = /\[richiede ([a-z-]+)(?: — saltato: (.*?))?\]/g;

/** Una riga del report JSON di Vitest, solo i campi che servono. */
export type TestOutcome = { file: string; fullName: string; status: string };

export type Tally = {
  /** Test marcati che hanno girato (passati o falliti). */
  ran: number;
  /** Test marcati saltati, per motivo. */
  skipped: Map<string, number>;
};

export type MarkedSummary = {
  byCapability: Record<CapabilityName, Tally>;
  /** Saltati senza etichetta: piattaforma, root, ecc. Elencati, non giudicati. */
  unmarkedSkips: TestOutcome[];
  /** Etichette con un nome che il registro non conosce: un refuso nel test. */
  unknownMarkers: string[];
};

const RAN = new Set(['passed', 'failed']);

export function tallyMarked(tests: readonly TestOutcome[]): MarkedSummary {
  const byCapability = Object.fromEntries(
    CAPABILITY_NAMES.map((n) => [n, { ran: 0, skipped: new Map<string, number>() }]),
  ) as Record<CapabilityName, Tally>;
  const unmarkedSkips: TestOutcome[] = [];
  const unknown = new Set<string>();
  for (const t of tests) {
    const seen = new Map<CapabilityName, string | undefined>();
    for (const m of t.fullName.matchAll(MARKER)) {
      const name = m[1] ?? '';
      if (!(CAPABILITY_NAMES as readonly string[]).includes(name)) {
        unknown.add(name);
        continue;
      }
      if (!seen.has(name as CapabilityName)) seen.set(name as CapabilityName, m[2]);
    }
    const ran = RAN.has(t.status);
    if (seen.size === 0) {
      if (!ran) unmarkedSkips.push(t);
      continue;
    }
    for (const [name, reason] of seen) {
      const tally = byCapability[name];
      if (ran) tally.ran += 1;
      else {
        const why = reason ?? 'saltato senza motivo nel nome';
        tally.skipped.set(why, (tally.skipped.get(why) ?? 0) + 1);
      }
    }
  }
  return { byCapability, unmarkedSkips, unknownMarkers: [...unknown].sort() };
}

const totalSkipped = (t: Tally): number => [...t.skipped.values()].reduce((a, b) => a + b, 0);

/**
 * I problemi che rendono rossa una run dove le capacità sono richieste (CI).
 * Un salto di una capacità richiesta è un verde falso; meno test marcati del
 * minimo registrato vuol dire che un'etichetta è sparita o un test è stato
 * tolto senza dirlo: il minimo si abbassa solo con una modifica rivista.
 */
export function judgeMarked(
  summary: MarkedSummary,
  required: Set<CapabilityName>,
  minimums: Partial<Record<CapabilityName, number>>,
): string[] {
  const problems: string[] = [];
  for (const marker of summary.unknownMarkers) {
    problems.push(
      `etichetta sconosciuta [richiede ${marker}]: note ${CAPABILITY_NAMES.join(', ')}`,
    );
  }
  for (const name of CAPABILITY_NAMES) {
    if (!required.has(name)) continue;
    const t = summary.byCapability[name];
    const skipped = totalSkipped(t);
    if (skipped > 0) {
      const motivi = [...t.skipped.keys()].join(' | ');
      problems.push(`${name} è richiesta ma ${skipped} test marcati sono saltati (${motivi})`);
    }
    const min = minimums[name];
    if (min === undefined) {
      problems.push(
        `${name} è richiesta ma non ha un minimo in test-support/capability-minimums.json`,
      );
    } else if (t.ran < min) {
      problems.push(`${name}: hanno girato ${t.ran} test marcati, il minimo registrato è ${min}`);
    }
  }
  return problems;
}

/** Il riepilogo leggibile: una riga per capacità, poi i salti senza etichetta. */
export function formatMarked(summary: MarkedSummary): string {
  const righe: string[] = [];
  for (const name of CAPABILITY_NAMES) {
    const t = summary.byCapability[name];
    const skipped = totalSkipped(t);
    righe.push(`[capacità] ${name}: ${t.ran} test eseguiti, ${skipped} saltati`);
    for (const [why, n] of t.skipped) righe.push(`  - ${n} saltati: ${why}`);
  }
  if (summary.unmarkedSkips.length > 0) {
    righe.push(`[capacità] saltati senza etichetta: ${summary.unmarkedSkips.length}`);
    for (const t of summary.unmarkedSkips) righe.push(`  - ${t.file} :: ${t.fullName}`);
  }
  return righe.join('\n');
}
