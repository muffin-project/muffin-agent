import type Database from 'better-sqlite3';

/**
 * La coda dei giudizi shadow (`ask_judgments`): una riga per ogni ask della
 * famiglia giudicata, non per ogni risposta riuscita.
 *
 * ## Perché una tabella e non uno span
 *
 * Il tracing dice *come è andata* una chiamata; qui serve *il dato di
 * calibrazione* — e il dato vale settimane, sopravvive ai processi e deve
 * potersi aggiungere alla decisione dell'owner (`approvals`) e all'esito
 * reale (`turn_tool_calls`) con un join, non con l'immaginazione. Le tre
 * tabelle si tengono per chiavi (`approval_id`, `turn_id`) e nessuna
 * scrive nelle altre: chi chiede, chi risponde all'owner, chi giudica in
 * shadow sono tre scrittori con tre momenti, e in mezzo può esserci un
 * riavvio.
 *
 * ## Il ciclo di vita della riga
 *
 * `pending` appena l'ask parte (una riga pending che non si chiude mai è
 * il crash detto ad alta voce, non un buco); poi `ok` con le risposte, o
 * `timeout`/`error` con il perché — il fallimento del provider è un dato
 * di latenza e affidabilità, esattamente come il successo. **Mai una
 * cancellazione**: le righe di calibrazione si accumulano come la storia
 * degli approvazioni, e chi le consuma è il report (fase 2), non un job di
 * pulizia inventato qui.
 *
 * `envelope` si persiste per intero (redatto in `envelope.ts` prima di
 * arrivare qui): senza lo stato, rigiocare il pacchetto domande di domani
 * sul traffico di oggi sarebbe impossibile — e quella è tutta la ragione
 * d'essere della fase shadow.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ask_judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  pack TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  envelope TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','timeout','error')),
  answers TEXT,
  detail TEXT,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  latency_ms INTEGER,
  delegation_mode TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ask_judgments_approval ON ask_judgments(approval_id);
CREATE INDEX IF NOT EXISTS idx_ask_judgments_turn ON ask_judgments(turn_id);
`;

export type JudgmentStatus = 'pending' | 'ok' | 'timeout' | 'error';

export type JudgmentRow = {
  id: number;
  approvalId: string;
  turnId: string;
  capability: string;
  pack: string;
  stateHash: string;
  envelope: string;
  provider: string;
  requestedModel: string | null;
  model: string | null;
  status: JudgmentStatus;
  answers: string | null;
  detail: string | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  latencyMs: number | null;
  delegationMode: string;
  askedAt: string;
  settledAt: string | null;
};

export class JudgmentStore {
  private readonly insertStmt: Database.Statement;
  private readonly settleStmt: Database.Statement;
  private readonly forApprovalStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(readonly db: Database.Database) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO ask_judgments
         (approval_id, turn_id, capability, pack, state_hash, envelope, provider, requested_model,
          status, delegation_mode, asked_at)
       VALUES (@approvalId, @turnId, @capability, @pack, @stateHash, @envelope, @provider,
               @requestedModel, 'pending', @delegationMode, @askedAt)`,
    );
    this.settleStmt = db.prepare(
      `UPDATE ask_judgments SET
         status = @status, model = @model, answers = @answers, detail = @detail,
         usage_input_tokens = @inputTokens, usage_output_tokens = @outputTokens,
         latency_ms = @latencyMs, settled_at = @settledAt
       WHERE id = @id AND status = 'pending'`,
    );
    this.forApprovalStmt = db.prepare(
      `SELECT * FROM ask_judgments WHERE approval_id = ? ORDER BY id DESC LIMIT 1`,
    );
    this.countStmt = db.prepare(`SELECT count(*) AS n FROM ask_judgments`);
  }

  /**
   * La riga nasce `pending`, nel momento in cui la domanda all'owner parte.
   * L'id che ritorna è il filo con cui il verdetto la chiuderà.
   */
  record(req: {
    approvalId: string;
    turnId: string;
    capability: string;
    pack: string;
    stateHash: string;
    envelope: string;
    provider: string;
    requestedModel: string | null;
    delegationMode: string;
    askedAt: string;
  }): number {
    return Number(this.insertStmt.run(req).lastInsertRowid);
  }

  /**
   * Chiude la riga: verdetto o fallimento, una volta sola — il guard in
   * `WHERE status = 'pending'` fa sì che un riavvio che rigiudica non
   * sovrascriva la storia (se mai succederà, sarà una riga nuova).
   */
  settle(
    id: number,
    esito:
      | {
          status: 'ok';
          model: string;
          answers: string;
          detail?: undefined;
          inputTokens: number | null;
          outputTokens: number | null;
          latencyMs: number;
          settledAt: string;
        }
      | {
          status: 'timeout' | 'error';
          detail: string;
          settledAt: string;
          latencyMs: number | null;
        },
  ): boolean {
    return (
      this.settleStmt.run({
        id,
        status: esito.status,
        model: esito.status === 'ok' ? esito.model : null,
        answers: esito.status === 'ok' ? esito.answers : null,
        detail: esito.status === 'ok' ? null : esito.detail,
        inputTokens: esito.status === 'ok' ? esito.inputTokens : null,
        outputTokens: esito.status === 'ok' ? esito.outputTokens : null,
        latencyMs: esito.latencyMs,
        settledAt: esito.settledAt,
      }).changes === 1
    );
  }

  /** L'ultima riga per una domanda — quella che il join della fase 2 leggerà. */
  forApproval(approvalId: string): JudgmentRow | null {
    const row = this.forApprovalStmt.get(approvalId) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.read(row);
  }

  count(): number {
    return Number((this.countStmt.get() as { n: number }).n);
  }

  private read(r: Record<string, unknown>): JudgmentRow {
    return {
      id: Number(r.id),
      approvalId: String(r.approval_id),
      turnId: String(r.turn_id),
      capability: String(r.capability),
      pack: String(r.pack),
      stateHash: String(r.state_hash),
      envelope: String(r.envelope),
      provider: String(r.provider),
      requestedModel: (r.requested_model as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      status: r.status as JudgmentStatus,
      answers: (r.answers as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      usageInputTokens: r.usage_input_tokens === null ? null : Number(r.usage_input_tokens),
      usageOutputTokens: r.usage_output_tokens === null ? null : Number(r.usage_output_tokens),
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      delegationMode: String(r.delegation_mode),
      askedAt: String(r.asked_at),
      settledAt: (r.settled_at as string | null) ?? null,
    };
  }
}
