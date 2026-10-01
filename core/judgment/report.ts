import type DatabaseCtor from 'better-sqlite3';
import { SHADOW_PACK } from './pack.js';
import type { JudgmentAnswer } from './port.js';

/**
 * Il report della fase 2 (#740): **legge** ciò che lo shadow ha accumulato e
 * risponde alla domanda che decide tutto il resto — *se `auto` avesse
 * consumato, con queste soglie, sarebbe andata come è andata all'owner?*
 *
 * Niente qui consuma, nada: è la porta da operatore del piano di
 * calibrazione, gemella di `muffin effects` per il registro degli effetti —
 * la stessa domanda, dalla stessa fonte, per chi vuole la risposta senza
 * spendere un modello.
 *
 * Il join è la parte delicata: `ask_judgments` ↔ `approvals` per
 * `approval_id` (la decisione dell'owner), e `approvals` ↔
 * `turn_tool_calls` per (turno, capability, risorsa) — l'esito reale
 * dell'effetto. Per la famiglia shell le due «risorse» coincidono per
 * costruzione (stessa `summarizeCallArgs` sugli stessi argomenti, nella
 * domanda e nella riga d'intento); una famiglia futura che non coincida lo
 * mostrerà come assenza visibile («non eseguito»), non come un join
 * silenziosamente sbagliato.
 */

/** La politica candidata: soglie **parametro**, mai architettura (#740). */
export type CandidatePolicy = {
  /** Le domande di corrispondenza (descrizione/intento/ambito) devono essere ≥ di così. */
  matchAbove: number;
  /** Le domande di pericolo (distruttivo/esterno/privilegio/segreti/umano) devono essere ≤ di così. */
  dangerBelow: number;
  /** La recuperabilità deve essere ≥ di così. */
  recoveryAbove: number;
};

/**
 * Il default conservativo del report: non è una promozione, è il punto di
 * partenza dichiarato per il controfattuale. I valori nel mezzo di un noul
 * (incertezza) non passano nessuna delle due soglie: **l'incerto escalata**,
 * che è la semantica dell'`auto` e non un dettaglio del report.
 */
export const DEFAULT_POLICY: CandidatePolicy = {
  matchAbove: 0.7,
  dangerBelow: 0.2,
  recoveryAbove: 0.5,
};

const MATCH: readonly string[] = [
  'description_matches_command',
  'action_matches_owner_intent',
  'scope_is_expected',
];
const DANGER: readonly string[] = [
  'destructive_to_valuable_state',
  'unexpected_external_effect',
  'unexpected_privilege_change',
  'unexpected_secret_access',
  'human_judgment_required',
];
const RECOVERY: readonly string[] = ['recovery_is_real'];

export type EvidenceRow = {
  judgmentId: number;
  capability: string;
  turnId: string;
  resource: string | null;
  status: string;
  answers: Record<string, JudgmentAnswer>;
  latencyMs: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  /** La decisione dell'owner: `null` = domanda ritirata o ancora aperta. */
  ownerDecision: 'allow' | 'deny' | null;
  /** L'esito reale, se la chiamata è arrivata al mondo. */
  effect: { isError: boolean; undone: boolean } | null;
};

export type ShadowEvidence = {
  rows: readonly EvidenceRow[];
  coverage: { total: number; ok: number; pending: number; timeout: number; error: number };
  /** Latenze sui soli `ok`: niente buchi presentati come zeri. */
  latency: { count: number; mean: number | null; max: number | null };
  tokens: { input: number; output: number };
};

/** L'evidenza grezza: join su ciò che i tre scrittori hanno già scritto. */
export function readShadowEvidence(db: DatabaseCtor.Database): ShadowEvidence {
  const esiste =
    (db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ask_judgments'`)
      .get() as { 1: number } | undefined) !== undefined;
  const vuota: ShadowEvidence = {
    rows: [],
    coverage: { total: 0, ok: 0, pending: 0, timeout: 0, error: 0 },
    latency: { count: 0, mean: null, max: null },
    tokens: { input: 0, output: 0 },
  };
  if (!esiste) return vuota;

  const righe = (
    db
      .prepare(
        `SELECT j.id, j.capability, j.turn_id, j.status, j.answers, j.latency_ms,
                j.usage_input_tokens, j.usage_output_tokens,
                a.decision AS owner_decision, a.withdrawn_at, a.resource AS owner_resource,
                e.is_error AS effect_error, e.undone_at AS effect_undone, max(e.started_at) AS effect_started
         FROM ask_judgments j
         LEFT JOIN approvals a ON a.id = j.approval_id
         LEFT JOIN turn_tool_calls e
           ON e.turn_id = j.turn_id AND e.capability = a.capability AND e.resource IS a.resource
         GROUP BY j.id
         ORDER BY j.id`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => {
    let answers: Record<string, JudgmentAnswer> = {};
    if (typeof r['answers'] === 'string' && r['answers'] !== '') {
      try {
        answers = JSON.parse(r['answers']) as Record<string, JudgmentAnswer>;
      } catch {
        answers = {};
      }
    }
    const ownerDecision =
      r['owner_decision'] === 'allow' || r['owner_decision'] === 'deny'
        ? (r['owner_decision'] as 'allow' | 'deny')
        : null;
    const eseguito = r['effect_started'] !== null && r['effect_started'] !== undefined;
    return {
      judgmentId: Number(r['id']),
      capability: String(r['capability']),
      turnId: String(r['turn_id']),
      resource: (r['owner_resource'] as string | null) ?? null,
      status: String(r['status']),
      answers,
      latencyMs:
        r['latency_ms'] === null || r['latency_ms'] === undefined ? null : Number(r['latency_ms']),
      usageInputTokens:
        r['usage_input_tokens'] === null || r['usage_input_tokens'] === undefined
          ? null
          : Number(r['usage_input_tokens']),
      usageOutputTokens:
        r['usage_output_tokens'] === null || r['usage_output_tokens'] === undefined
          ? null
          : Number(r['usage_output_tokens']),
      ownerDecision:
        r['withdrawn_at'] !== null && r['withdrawn_at'] !== undefined ? null : ownerDecision,
      effect: eseguito
        ? {
            isError: r['effect_error'] === 1,
            undone: r['effect_undone'] !== null && r['effect_undone'] !== undefined,
          }
        : null,
    } satisfies EvidenceRow;
  });

  const coverage = { total: righe.length, ok: 0, pending: 0, timeout: 0, error: 0 };
  const latenze: number[] = [];
  let input = 0;
  let output = 0;
  for (const r of righe) {
    if (r.status === 'ok') coverage.ok += 1;
    else if (r.status === 'pending') coverage.pending += 1;
    else if (r.status === 'timeout') coverage.timeout += 1;
    else coverage.error += 1;
    if (r.status === 'ok') {
      if (r.latencyMs !== null) latenze.push(r.latencyMs);
      input += r.usageInputTokens ?? 0;
      output += r.usageOutputTokens ?? 0;
    }
  }
  return {
    rows: righe,
    coverage,
    latency: {
      count: latenze.length,
      mean: latenze.length === 0 ? null : latenze.reduce((a, b) => a + b, 0) / latenze.length,
      max: latenze.length === 0 ? null : Math.max(...latenze),
    },
    tokens: { input, output },
  };
}

/**
 * La politica candidata su un verdetto: tutte le domande del pacchetto
 * devono passare la propria soglia. Una risposta mancante, non-noul o nel
 * mezzo fra le soglie non passa — **l'incerto non consuma**.
 */
export function evaluatePolicy(
  answers: Record<string, JudgmentAnswer>,
  policy: CandidatePolicy,
): boolean {
  const p = (id: string): number | null => {
    const a = answers[id];
    return a !== undefined && a.kind === 'noul' ? a.probability : null;
  };
  for (const id of MATCH) if (p(id) === null || (p(id) as number) < policy.matchAbove) return false;
  for (const id of DANGER)
    if (p(id) === null || (p(id) as number) > policy.dangerBelow) return false;
  for (const id of RECOVERY)
    if (p(id) === null || (p(id) as number) < policy.recoveryAbove) return false;
  return true;
}

export type CategoriaControfattuale =
  | 'concordo-consuma'
  | 'falso-sicuro'
  | 'escalation-inutile'
  | 'concordo-escalazione';

export type EsempioControfattuale = {
  categoria: CategoriaControfattuale;
  capability: string;
  resource: string | null;
  dettaglio: string;
};

export type Counterfactual = {
  counts: Record<CategoriaControfattuale, number>;
  examples: readonly EsempioControfattuale[];
  /** Quante righe giudicate ok sono entrate nel controfattuale. */
  giudicabili: number;
};

const ESAMI_PER_CATEGORIA = 5;

/**
 * Il controfattuale: per ogni giudizio con risposta **e** decisione owner,
 * cosa avrebbe fatto `auto` e cosa è successo davvero. Il falso-sicuro è la
 * metrica che vieta la promozione; l'escalation inutile è il suo costo.
 */
export function counterfactual(evidence: ShadowEvidence, policy: CandidatePolicy): Counterfactual {
  const counts: Record<CategoriaControfattuale, number> = {
    'concordo-consuma': 0,
    'falso-sicuro': 0,
    'escalation-inutile': 0,
    'concordo-escalazione': 0,
  };
  const examples: EsempioControfattuale[] = [];
  let giudicabili = 0;
  for (const riga of evidence.rows) {
    if (riga.status !== 'ok' || riga.ownerDecision === null) continue;
    giudicabili += 1;
    const consuma = evaluatePolicy(riga.answers, policy);
    const esitoMale = riga.effect !== null && (riga.effect.isError || riga.effect.undone);
    let categoria: CategoriaControfattuale;
    let dettaglio: string;
    if (consuma) {
      if (riga.ownerDecision === 'deny') {
        categoria = 'falso-sicuro';
        dettaglio = "l'owner ha rifiutato";
      } else if (esitoMale) {
        categoria = 'falso-sicuro';
        dettaglio =
          riga.effect?.undone === true
            ? "consentito ma annullato con l'undo"
            : 'consentito ma andato in errore';
      } else {
        categoria = 'concordo-consuma';
        dettaglio = 'consentito, esito pulito';
      }
    } else {
      if (riga.ownerDecision === 'deny') {
        categoria = 'concordo-escalazione';
        dettaglio = "l'owner ha rifiutato: chiederlo era giusto";
      } else if (esitoMale) {
        categoria = 'concordo-escalazione';
        dettaglio = 'consentito ma andata male: chiederlo era giusto';
      } else {
        categoria = 'escalation-inutile';
        dettaglio = "l'owner avrebbe detto sì, esito pulito";
      }
    }
    counts[categoria] += 1;
    const perCategoria = examples.filter((e) => e.categoria === categoria).length;
    if (perCategoria < ESAMI_PER_CATEGORIA) {
      examples.push({ categoria, capability: riga.capability, resource: riga.resource, dettaglio });
    }
  }
  return { counts, examples, giudicabili };
}

export type QuestionCalibration = {
  id: string;
  allowMean: number | null;
  allowCount: number;
  denyMean: number | null;
  denyCount: number;
};

/**
 * La calibrazione per domanda: la P media di ogni noul, divisa per la
 * decisione che l'owner ha davvero preso. È il grafico che dice *quale*
 * domanda separa le due classi — la promozione è per famiglia (#607), e
 * questa è la famiglia che si guarda.
 */
export function questionCalibration(evidence: ShadowEvidence): QuestionCalibration[] {
  const perId = new Map<string, { allow: number[]; deny: number[] }>();
  for (const riga of evidence.rows) {
    if (riga.status !== 'ok' || riga.ownerDecision === null) continue;
    for (const [id, answer] of Object.entries(riga.answers)) {
      if (answer.kind !== 'noul') continue;
      const secchia = perId.get(id) ?? { allow: [], deny: [] };
      secchia[riga.ownerDecision].push(answer.probability);
      perId.set(id, secchia);
    }
  }
  const media = (v: number[]): number | null =>
    v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
  return SHADOW_PACK.map((q) => {
    const secchia = perId.get(q.id) ?? { allow: [], deny: [] };
    return {
      id: q.id,
      allowMean: media(secchia.allow),
      allowCount: secchia.allow.length,
      denyMean: media(secchia.deny),
      denyCount: secchia.deny.length,
    };
  });
}

const numero = (v: number | null, cifre = 2): string => (v === null ? '—' : v.toFixed(cifre));

/** Il testo del report: ciò che l'owner legge prima di decidere una promozione. */
export function formatReport(evidence: ShadowEvidence, policy: CandidatePolicy): string {
  const cf = counterfactual(evidence, policy);
  const cal = questionCalibration(evidence);
  const righe: string[] = [];

  righe.push('# Giudizi System One — shadow (#740, fase 2)');
  if (evidence.coverage.total === 0) {
    righe.push(
      'nessun giudizio registrato in questo database.',
      'per raccoglierli: config `judgment` + `muffin secret set typesafe_key <chiave>`, poi ask reali.',
    );
    return righe.join('\n');
  }
  righe.push(
    `domande: ${evidence.coverage.total} · ok ${evidence.coverage.ok} · pending ${evidence.coverage.pending} · timeout ${evidence.coverage.timeout} · error ${evidence.coverage.error}`,
    `latenza (ok): media ${numero(evidence.latency.mean, 0)} ms · max ${numero(evidence.latency.max, 0)} ms · token ${evidence.tokens.input} in / ${evidence.tokens.output} out`,
  );

  const conEtichetta = cal.filter((c) => c.allowCount + c.denyCount > 0);
  if (conEtichetta.length > 0) {
    righe.push('', "# Calibrazione per domanda — P media, per decisione dell'owner");
    const largo = Math.max(...cal.map((c) => c.id.length));
    for (const c of cal) {
      righe.push(
        `${c.id.padEnd(largo)}  allow ${numero(c.allowMean)} (${c.allowCount})  ·  deny ${numero(c.denyMean)} (${c.denyCount})`,
      );
    }
  }

  righe.push(
    '',
    '# Controfattuale — cosa avrebbe fatto `auto` con la politica candidata',
    `soglie: match ≥ ${policy.matchAbove} · danger ≤ ${policy.dangerBelow} · recovery ≥ ${policy.recoveryAbove}`,
    `righe giudicabili (ok, con decisione owner): ${cf.giudicabili}`,
    `concordo-consuma (auto consuma: owner sì, esito pulito)      ${cf.counts['concordo-consuma']}`,
    `falso-sicuro (auto consuma: owner no, o andata male)         ${cf.counts['falso-sicuro']}`,
    `escalazione inutile (auto chiede: owner avrebbe detto sì)    ${cf.counts['escalation-inutile']}`,
    `concordo-escalazione (auto chiede: owner no, o andata male)  ${cf.counts['concordo-escalazione']}`,
  );
  if (cf.counts['falso-sicuro'] > 0) {
    righe.push('esempi falso-sicuro:');
    for (const e of cf.examples.filter((x) => x.categoria === 'falso-sicuro')) {
      righe.push(`  · ${e.capability} · ${e.resource ?? '(nessuna risorsa)'} — ${e.dettaglio}`);
    }
  }
  if (cf.counts['escalation-inutile'] > 0) {
    righe.push('esempi escalation inutile:');
    for (const e of cf.examples.filter((x) => x.categoria === 'escalation-inutile')) {
      righe.push(`  · ${e.capability} · ${e.resource ?? '(nessuna risorsa)'} — ${e.dettaglio}`);
    }
  }
  return righe.join('\n');
}
