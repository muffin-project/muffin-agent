import type DatabaseCtor from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { ensureColumn } from '../lock/durable.js';
import type { TrustTier } from '../policy/types.js';

/**
 * Le approvazioni chieste e non ancora date.
 *
 * ## Perché esiste
 *
 * Il kernel ha sempre saputo chiedere; quello che mancava era **dove mettere
 * la domanda mentre l'owner non c'è**. Su una superficie senza un approvatore
 * sincrono il turno finiva con `stopped: 'ask'` e la frase «su questa
 * superficie non posso chiederla» — cioè da Telegram niente di ciò che chiede
 * conferma era usabile, e per l'owner questo vuol dire quasi tutto (`sys.shell`
 * chiede sempre finché `muffin rot harden` non è stato fatto).
 *
 * DAY-1 requirement D12 lo nomina da mesi: *«resta la coda durevole degli ask
 * (`turn_outcome='ask'` persistito, nessun consumer lo rilegge)»*. Questa
 * tabella è quella coda, e ha un consumer.
 *
 * ## Una decisione, un uso
 *
 * `consumed_at` non è contabilità: è la proprietà di sicurezza. Un'approvazione
 * data una volta deve valere **una** volta, sulla chiamata per cui è stata
 * chiesta. Senza, un sì detto per `sys.shell` su un comando diventerebbe un sì
 * per ogni `sys.shell` di quel turno — che è il modo in cui un'approvazione
 * smette di essere una domanda e diventa un interruttore che l'owner ha girato
 * senza saperlo.
 *
 * Per la stessa ragione `take` confronta capability **e** risorsa: la domanda
 * mostrava quel comando, quell'URL, quel percorso (D12: *«un'approvazione il
 * cui soggetto è invisibile è teatro»*), quindi la risposta vale per quelli.
 *
 * ## Perché una tabella e non una colonna su `turns`
 *
 * Chi scrive la risposta non è chi ha fatto la domanda: la domanda nasce dentro
 * un turno, la risposta arriva da un `callback_query` di Telegram gestito da un
 * altro pezzo del processo — o da un processo diverso, dopo un riavvio. Due
 * scrittori, due momenti, e in mezzo un crash che deve poter succedere senza
 * perdere niente.
 */

/**
 * Quanto resta valida una domanda senza risposta: sei ore.
 *
 * Il tetto non protegge da un pulsante premuto tardi — quello funziona finché
 * la riga c'è. Protegge dal caso opposto: un turno sospeso che nessuno
 * risveglia tiene il suo contesto e uno degli otto posti sospesi per tenant
 * (`MAX_SUSPENDED_PER_TENANT`), e in silenzio.
 *
 * Sei ore e non un'ora perché una domanda fatta di notte deve poter aspettare
 * la mattina; e non sette giorni — il tetto di `wait` — perché una scadenza
 * lunga così non è un'attesa, è una cosa dimenticata. Alla scadenza il turno si
 * sveglia e **lo dice**: l'owner legge «non hai risposto, non l'ho fatto»
 * invece di non leggere niente.
 */
export const APPROVAL_WINDOW_MS = 6 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  capability  TEXT NOT NULL,
  resource    TEXT,
  prompt      TEXT NOT NULL,
  taint       INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3),
  asked_at    TEXT NOT NULL,
  decision    TEXT CHECK (decision IN ('allow','deny')),
  decided_at  TEXT,
  consumed_at TEXT,
  -- Chi ha deciso: l'owner sul pulsante, oppure la sua delega attiva per
  -- questo lavoro (issue #740: yolo consuma gli ask attraverso lo stesso
  -- registro, non accanto). Righe decise prima di questa colonna: solo
  -- l'owner poteva decidere, quindi leggono 'owner'.
  decided_by  TEXT CHECK (decided_by IN ('owner','delegation')),
  -- Quando il turno è finito con la domanda ancora aperta: la riga non è
  -- cancellata (niente si cancella) e non è decisa (nessuno ha risposto), ma
  -- non è più una domanda — open la ignora e un tocco tardivo non decide.
  withdrawn_at TEXT,
  -- Dove la domanda si è mostrata, come array JSON di id di messaggio
  -- (issue #784). Una riga può avere più bolle: un re-ask dopo un riavvio
  -- riusa la riga ma manda un messaggio nuovo, e la bolla vecchia resta
  -- dov'era. Solo scritture in aggiunta, mai sovrascritture: alla chiusura
  -- terminale si toglie la tastiera a tutte quelle registrate.
  question_message_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_turn ON approvals(turn_id, consumed_at);
`;

export type ApprovalRow = {
  id: string;
  turnId: string;
  capability: string;
  resource: string | null;
  prompt: string;
  taint: TrustTier;
  askedAt: string;
  decision: 'allow' | 'deny' | null;
  decidedAt: string | null;
  consumedAt: string | null;
  /** Solo quando `decision` non è null: chi ha risposto. */
  decidedBy: 'owner' | 'delegation' | null;
  /** Il turno è finito mentre la domanda era aperta: vedi `withdrawForTurn`. */
  withdrawnAt: string | null;
  /**
   * Gli id dei messaggi su cui questa domanda si è mostrata, in ordine di
   * invio — vedi `noteQuestionMessage`. Vuoto quando niente è stato
   * registrato: righe di prima della colonna, o domande mai arrivate sul filo.
   */
  questionMessageIds: number[];
};

type Raw = {
  id: string;
  turn_id: string;
  capability: string;
  resource: string | null;
  prompt: string;
  taint: number;
  asked_at: string;
  decision: string | null;
  decided_at: string | null;
  consumed_at: string | null;
  decided_by: string | null;
  withdrawn_at: string | null;
  question_message_ids: string | null;
};

/**
 * Gli id dei messaggi registrati su una riga, come numeri interi positivi.
 *
 * Difensivo di proposito: la colonna è JSON scritto solo da
 * `noteQuestionMessage`, ma una riga può arrivare da un database toccato a
 * mano o da una scrittura interrotta — una lettura che lancia qui
 * trasformerebbe una bolla orfana in un turno che non si chiude. Spazzatura
 * dentro, lista vuota fuori: la tastiera di quel messaggio resta dov'è, che
 * è lo stato di prima di questa colonna, mai un errore nuovo.
 */
const leggiDomande = (grezzo: string | null | undefined): number[] => {
  if (typeof grezzo !== 'string' || grezzo === '') return [];
  try {
    const parsed: unknown = JSON.parse(grezzo);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
};

const read = (r: Raw): ApprovalRow => ({
  id: r.id,
  turnId: r.turn_id,
  capability: r.capability,
  resource: r.resource,
  prompt: r.prompt,
  taint: r.taint as TrustTier,
  askedAt: r.asked_at,
  decision: r.decision === 'allow' || r.decision === 'deny' ? r.decision : null,
  decidedAt: r.decided_at,
  consumedAt: r.consumed_at,
  // Decisa ma senza autore: righe di prima della colonna, quando solo
  // l'owner poteva decidere — vedi lo schema.
  decidedBy: r.decision === null ? null : r.decided_by === 'delegation' ? 'delegation' : 'owner',
  withdrawnAt: r.withdrawn_at,
  questionMessageIds: leggiDomande(r.question_message_ids),
});

export class ApprovalStore {
  private readonly askStmt: DatabaseCtor.Statement;
  private readonly getStmt: DatabaseCtor.Statement;
  private readonly decideStmt: DatabaseCtor.Statement;
  private readonly matchStmt: DatabaseCtor.Statement;
  private readonly consumeStmt: DatabaseCtor.Statement;
  private readonly openStmt: DatabaseCtor.Statement;
  private readonly openRowsStmt: DatabaseCtor.Statement;
  private readonly decidedUnconsumedStmt: DatabaseCtor.Statement;
  private readonly withdrawStmt: DatabaseCtor.Statement;
  private readonly noteQuestionStmt: DatabaseCtor.Statement;
  private readonly withdrawnQuestionsStmt: DatabaseCtor.Statement;
  private readonly openForStmt: DatabaseCtor.Statement;

  constructor(db: DatabaseCtor.Database) {
    db.exec(SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` non tocca una tabella che esiste già: su un
    // database installato prima di questa colonna lo schema sopra è un no-op e
    // ogni SELECT che la nomina fallirebbe. `ensureColumn` è lo stesso meccanismo
    // di ogni altro store che ha aggiunto una colonna — con la sua gestione
    // della corsa fra due connessioni (`duplicate column name`), che una copia
    // locale di PRAGMA+ALTER non avrebbe.
    ensureColumn(db, 'approvals', 'withdrawn_at', 'withdrawn_at TEXT');
    // Stesso meccanismo, stessa ragione: la delega (#740) distingue chi ha
    // deciso, e un database installato prima di questa riga deve leggerla
    // senza che nessuno migri niente a mano.
    ensureColumn(
      db,
      'approvals',
      'decided_by',
      "decided_by TEXT CHECK (decided_by IN ('owner','delegation'))",
    );
    // Stesso meccanismo, stessa ragione: l'id del messaggio della domanda
    // (#784) su un database installato prima di questa colonna.
    ensureColumn(db, 'approvals', 'question_message_ids', 'question_message_ids TEXT');
    this.askStmt = db.prepare(
      `INSERT INTO approvals (id, turn_id, capability, resource, prompt, taint, asked_at)
       VALUES (@id, @turnId, @capability, @resource, @prompt, @taint, @askedAt)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM approvals WHERE id = ?`);
    /**
     * `decision IS NULL` nella `WHERE`, e non un controllo letto prima.
     *
     * Due tocchi sullo stesso pulsante sono la cosa più normale che succeda —
     * Telegram non toglie la tastiera da solo, e un tap che sembra non aver
     * fatto niente si ripete. La prima risposta vince perché è la sola che la
     * `UPDATE` trova; la seconda muove zero righe, e il chiamante lo legge
     * come «già risposto» invece che come un errore.
     */
    this.decideStmt = db.prepare(
      `UPDATE approvals SET decision = @decision, decided_at = @at, decided_by = @by
        WHERE id = @id AND decision IS NULL AND withdrawn_at IS NULL`,
    );
    this.matchStmt = db.prepare(
      `SELECT * FROM approvals
        WHERE turn_id = @turnId AND capability = @capability
          AND resource IS @resource
          AND decision IS NOT NULL AND consumed_at IS NULL
        ORDER BY decided_at ASC LIMIT 1`,
    );
    this.consumeStmt = db.prepare(`UPDATE approvals SET consumed_at = @at WHERE id = @id AND consumed_at IS NULL`);
    this.openStmt = db.prepare(
      `SELECT * FROM approvals WHERE turn_id = ? AND decision IS NULL AND withdrawn_at IS NULL
        ORDER BY asked_at ASC LIMIT 1`,
    );
    /**
     * Tutte le domande aperte di un turno, dalla più vecchia.
     *
     * La usa `/yolo` su un lavoro sospeso: un giro può averne lasciate due
     * (#741), e decidere solo la prima significherebbe risvegliare il turno
     * su una barriera che resta aperta.
     */
    this.openRowsStmt = db.prepare(
      `SELECT * FROM approvals WHERE turn_id = ? AND decision IS NULL AND withdrawn_at IS NULL
        ORDER BY asked_at ASC`,
    );
    this.openForStmt = db.prepare(
      `SELECT * FROM approvals
        WHERE turn_id = @turnId AND capability = @capability AND resource IS @resource
          AND decision IS NULL AND withdrawn_at IS NULL
        ORDER BY asked_at ASC LIMIT 1`,
    );
    this.withdrawStmt = db.prepare(
      `UPDATE approvals SET withdrawn_at = @at
        WHERE turn_id = @turnId AND decision IS NULL AND withdrawn_at IS NULL`,
    );
    this.noteQuestionStmt = db.prepare(`UPDATE approvals SET question_message_ids = @ids WHERE id = @id`);
    this.withdrawnQuestionsStmt = db.prepare(
      `SELECT id, question_message_ids FROM approvals
        WHERE turn_id = ? AND withdrawn_at IS NOT NULL AND question_message_ids IS NOT NULL
        ORDER BY asked_at ASC`,
    );
    this.decidedUnconsumedStmt = db.prepare(
      `SELECT 1 AS uno FROM approvals WHERE turn_id = ? AND decision IS NOT NULL AND consumed_at IS NULL LIMIT 1`,
    );
  }

  /**
   * Registra una domanda e restituisce il suo id — che è anche la barriera
   * del turno.
   *
   * Se la **stessa** domanda (turno, capability, risorsa) è già aperta, ne
   * riusa la riga: un re-ask — il modello rifà la chiamata dopo un risveglio —
   * non deve creare una seconda domanda. Con due righe aperte la tastiera
   * mostrerebbe l'ultima e la barriera di ripresa vedrebbe la prima, quella
   * senza pulsanti, fino alla scadenza (#745).
   */
  ask(
    req: { turnId: string; capability: string; resource?: string | undefined; prompt: string; taint: TrustTier },
    now: Date,
  ): string {
    const aperta = this.openForStmt.get({
      turnId: req.turnId,
      capability: req.capability,
      resource: req.resource ?? null,
    }) as Raw | undefined;
    if (aperta !== undefined) return aperta.id;
    // Esadecimale: l'id finisce dentro `approval:<id>` in `wait_for` e dentro
    // il `callback_data` di Telegram (64 byte in tutto), quindi non può
    // contenere `:` né avere una lunghezza a sorpresa.
    const id = randomBytes(12).toString('hex');
    this.askStmt.run({
      id,
      turnId: req.turnId,
      capability: req.capability,
      resource: req.resource ?? null,
      prompt: req.prompt,
      taint: req.taint,
      askedAt: now.toISOString(),
    });
    return id;
  }

  get(id: string): ApprovalRow | null {
    const row = this.getStmt.get(id) as Raw | undefined;
    return row === undefined ? null : read(row);
  }

  /**
   * L'owner ha risposto — o la sua delega ha consumato la domanda (#740).
   *
   * `by` dice chi: `'owner'` il pulsante (anche il terminale), `'delegation'`
   * l'ask consumato sotto `/yolo`. Il default è l'owner perché ogni chiamante
   * esistente è un dito, e un dito che dimentica il parametro non deve
   * diventare delega.
   *
   * Tre esiti distinti perché portano a tre messaggi diversi sul pulsante:
   * `ok` la risposta è stata presa, `already` qualcuno (o lo stesso dito) aveva
   * già risposto, `unknown` quell'id non esiste — un pulsante di un database
   * ricreato, o qualcosa che nessuno ha chiesto.
   */
  decide(
    id: string,
    decision: 'allow' | 'deny',
    now: Date,
    by: 'owner' | 'delegation' = 'owner',
  ): 'ok' | 'already' | 'unknown' | 'withdrawn' {
    const changed = this.decideStmt.run({ id, decision, at: now.toISOString(), by }).changes;
    if (changed > 0) return 'ok';
    const row = this.get(id);
    if (row === null) return 'unknown';
    // Ritirata è diverso da «già risposto»: nessuno ha risposto, il turno è
    // finito. Il messaggio del pulsante deve poterlo dire.
    return row.withdrawnAt === null ? 'already' : 'withdrawn';
  }

  /**
   * Il turno è finito con la domanda ancora aperta: la domanda si **ritira**.
   *
   * Non si cancella (la riga resta come traccia) e non si decide (nessuno ha
   * risposto): smette di essere una domanda. `open` la ignora — quindi la
   * guardia di ripresa non la vede più — e un tocco tardivo riceve
   * `'withdrawn'` invece di decidere per un turno che non esiste più.
   *
   * Ritorna quante domande ha ritirato: zero è la risposta normale per un
   * turno che non aveva domande aperte.
   */
  withdrawForTurn(turnId: string, now: Date): number {
    return this.withdrawStmt.run({ turnId, at: now.toISOString() }).changes;
  }

  /**
   * Questa domanda si è mostrata su questo messaggio (#784).
   *
   * Chiamata dalla superficie **dopo** l'invio, con l'id che il filo ha
   * restituito — la riga esiste già (l'id viaggia dentro i pulsanti), il
   * messaggio no. Solo in aggiunta: un re-ask riusa la riga ma manda un
   * messaggio nuovo (dopo un riavvio, sempre), e sovrascrivere perderebbe la
   * bolla vecchia proprio nel caso che questa colonna esiste per chiudere.
   * Idempotente sullo stesso messaggio, silenziosa su un id sconosciuto: una
   * registrazione non può rompere una domanda già fatta.
   */
  noteQuestionMessage(id: string, messageId: number): void {
    const row = this.get(id);
    if (row === null || row.questionMessageIds.includes(messageId)) return;
    this.noteQuestionStmt.run({ id, ids: JSON.stringify([...row.questionMessageIds, messageId]) });
  }

  /**
   * Le bolle da spegnere alla chiusura terminale del turno (#784): per ogni
   * riga ritirata che ha mostrato una domanda, gli id dei messaggi registrati.
   *
   * Solo righe ritirate — una domanda aperta o decisa ha ancora (o ha avuto)
   * la sua tastiera gestita dal percorso vivo, e toccarla qui sarebbe
   * togliere pulsanti a una domanda che aspetta davvero. Righe senza
   * registrazione (prima della colonna, o mai arrivate sul filo) non ci sono:
   * niente id, niente edit, mai un falso.
   */
  withdrawnQuestionMessages(turnId: string): Array<{ id: string; messageId: number }> {
    const rows = this.withdrawnQuestionsStmt.all(turnId) as { id: string; question_message_ids: string | null }[];
    const out: Array<{ id: string; messageId: number }> = [];
    for (const r of rows) {
      for (const messageId of leggiDomande(r.question_message_ids)) out.push({ id: r.id, messageId });
    }
    return out;
  }

  /** La barriera del turno: c'è una risposta per questa domanda? */
  answered(id: string): boolean {
    const row = this.get(id);
    return row !== null && row.decision !== null;
  }

  /** La domanda aperta di un turno, se ce n'è una — quella che i pulsanti stanno mostrando. */
  open(turnId: string): ApprovalRow | null {
    const row = this.openStmt.get(turnId) as Raw | undefined;
    return row === undefined ? null : read(row);
  }

  /** Tutte le domande aperte di un turno, dalla più vecchia — vedi `openRowsStmt`. */
  openRows(turnId: string): ApprovalRow[] {
    const rows = this.openRowsStmt.all(turnId) as Raw[];
    return rows.map(read);
  }

  /**
   * C'è una decisione presa e non ancora consumata per questo turno?
   *
   * È la firma di un risveglio **da click** (rispetto a uno da scadenza):
   * l'owner ha deciso qualcosa, il tool non l'ha ancora consumato. La usano la
   * ripresa per distinguere «una delle domande è stata decisa» da «è scaduto
   * il tempo» (issue #741), senza leggere l'orologio del turno.
   */
  decidedUnconsumed(turnId: string): boolean {
    return this.decidedUnconsumedStmt.get(turnId) !== undefined;
  }

  /**
   * Consuma la risposta a *questa* chiamata, o `null` se non ce n'è una.
   *
   * Chiamata dal kernel quando il turno riprende e il modello rifà la stessa
   * chiamata: se l'owner aveva risposto, quella risposta vale qui e adesso, e
   * poi non vale più. `resource` entra nel confronto perché è ciò che l'owner
   * ha letto sul pulsante.
   */
  take(
    match: { turnId: string; capability: string; resource?: string | undefined },
    now: Date,
  ): 'allow' | 'deny' | null {
    const row = this.matchStmt.get({
      turnId: match.turnId,
      capability: match.capability,
      resource: match.resource ?? null,
    }) as Raw | undefined;
    if (row === undefined) return null;
    // Guardato dalla `WHERE`, non da una lettura precedente: due riprese dello
    // stesso turno in corsa sono possibili, e solo una può consumare.
    if (this.consumeStmt.run({ id: row.id, at: now.toISOString() }).changes === 0) return null;
    return read(row).decision;
  }
}
