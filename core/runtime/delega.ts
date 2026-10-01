import type Database from 'better-sqlite3';
import type { TurnStatus } from '../turns/store.js';

/**
 * La delega dell'owner: quale postura consuma gli `ask` di un lavoro (issue #740).
 *
 * Non è un secondo kernel e non decide cosa è permesso. Il kernel deterministico
 * resta sovrano: `deny` resta `deny` in ogni modalità, e solo un `ask` — cioè un
 * verdetto che il kernel stesso ha detto approvabile dall'owner — può essere
 * consumato per delega invece che con una domanda.
 *
 * ```text
 * manual: l'ask diventa una vera richiesta all'owner (il comportamento di oggi)
 * auto:   l'ask sale all'owner finché la busta di System One è vuota: classi non
 *         calibrate escalano per costruzione (#740, fase 3: «unknown classes
 *         escalate»). Il giudice semantico si innesterà qui.
 * yolo:    il proprietario ha pre-approvato ogni ask di questo lavoro
 * ```
 *
 * Durata e ambito: **il lavoro** (la riga `turns`), perché è la cosa che
 * l'owner sta delegando. Un lavoro nuovo è una riga nuova, quindi non eredita
 * niente; la continuazione di un lavoro (`continueTurn`, `resumeTurn`) è la
 * stessa riga, quindi la delega sopravvive al confine di continuazione che
 * l'owner intende — e non trapela mai a un lavoro, una sessione o un tenant
 * diversi.
 *
 * Accanto a `core/runtime/pausa.ts`: un fatto durevole letto a ogni consumo di
 * ask, non uno stato in memoria — un riavvio non deve né dimenticare la delega
 * né allargarla. Lettura fresca a ogni ask anche perché è così che `/manual`
 * vale subito: l'ask dopo il comando chiede di nuovo all'owner.
 */

export type DelegationMode = 'manual' | 'auto' | 'yolo';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delegation_modes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  mode    TEXT NOT NULL CHECK (mode IN ('manual','auto','yolo')),
  set_by  TEXT NOT NULL,
  set_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_modes_turn ON delegation_modes(turn_id, id);
`;

/** Una riga della storia: `delegation_mode_changed`, durevole e ispezionabile. */
export type DelegationChange = {
  mode: DelegationMode;
  setBy: string;
  setAt: string;
};

export class Delega {
  private readonly modeStmt: Database.Statement;
  private readonly sinceStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    this.modeStmt = db.prepare(
      `SELECT mode FROM delegation_modes WHERE turn_id = ? ORDER BY id DESC LIMIT 1`,
    );
    this.sinceStmt = db.prepare(
      `SELECT set_at FROM delegation_modes WHERE turn_id = ? ORDER BY id DESC LIMIT 1`,
    );
  }

  /**
   * La modalità attiva per questo lavoro. Assente = `manual`: il verso in cui
   * si degrada è chiedere all'owner, non eseguire da soli.
   */
  modo(turnId: string): DelegationMode {
    const row = this.modeStmt.get(turnId) as { mode: string } | undefined;
    return row?.mode === 'auto' || row?.mode === 'yolo' ? row.mode : 'manual';
  }

  /** Da quando vale la modalità attiva, o `null` se nessuno l'ha mai cambiata. */
  da(turnId: string): string | null {
    const row = this.sinceStmt.get(turnId) as { set_at: string } | undefined;
    return row?.set_at ?? null;
  }

  /**
   * Registra la postura che l'owner ha scelto per questo lavoro. Sempre in
   * append: la tabella **è** la storia dei cambi, così una delega non è mai un
   * booleano dimenticato ma una riga con chi, cosa e quando.
   */
  metti(turnId: string, mode: DelegationMode, setBy: string, at: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO delegation_modes (turn_id, mode, set_by, set_at) VALUES (?, ?, ?, ?)`,
      )
      .run(turnId, mode, setBy, at.toISOString());
  }
}

/** Cosa risponde la leva a `/yolo` e soci: il lavoro legato, o `null` se non ce n'è uno. */
export type LevaDelega = {
  modo: () => DelegationMode;
  metti: (modo: DelegationMode) => { turnId: string; cambiato: boolean; risposteDate: number } | null;
};

/**
 * La leva che i comandi ricevono (via `Controlli`), costruita una volta per
 * sessione da chi ha gli store in mano — il connettore Telegram e il REPL.
 *
 * Il lavoro a cui si lega è l'ultimo attivo di **questa** conversazione
 * (`TurnStore.latestActiveOfSession`): quello vivo, quello sospeso su una
 * domanda, quello in coda, quello continuabile o interrotto — mai uno `done`,
 * perché un lavoro finito non è più delegabile. La funzione e non il valore
 * per `sessionId`: il REPL ruota la sessione con `/new` senza ricostruire le leve.
 *
 * Solo i tre metodi che servono, in forma strutturale: la leva non deve
 * sapere che gli store sanno fare altro.
 */
export type ApprovazioniPerDelega = {
  decide: (id: string, decision: 'allow' | 'deny', now: Date, by?: 'owner' | 'delegation') => 'ok' | 'already' | 'unknown' | 'withdrawn';
  openRows: (turnId: string) => { id: string }[];
};

export type TurniPerDelega = {
  latestActiveOfSession: (sessionId: string) => { id: string; status: TurnStatus } | null;
  wake: (id: string, now: Date) => boolean;
};

export function levaDelega(deps: {
  delega: Delega;
  approvals: ApprovazioniPerDelega;
  turns: TurniPerDelega;
  sessionId: () => string;
  /** Spinta alla corsia dopo un risveglio — la stessa che il pulsante preme (`handleCallback`). */
  onWork?: (() => void) | undefined;
  now?: (() => Date) | undefined;
}): LevaDelega {
  const now = deps.now ?? (() => new Date());
  const lavoro = () => deps.turns.latestActiveOfSession(deps.sessionId());
  return {
    modo: () => {
      const riga = lavoro();
      return riga === null ? 'manual' : deps.delega.modo(riga.id);
    },
    metti: (modo) => {
      const riga = lavoro();
      if (riga === null) return null;
      // Un comando ridetto non è un cambio: la storia registra i cambi, e il
      // comando può dire «ero già» invece di scrivere una riga uguale.
      const cambiato = deps.delega.modo(riga.id) !== modo;
      if (cambiato) deps.delega.metti(riga.id, modo, 'owner', now());
      /**
       * `/yolo` su un lavoro sospeso: la domanda aperta non deve aspettare la
       * scadenza per diventare inutile. Si decide per delega e la riga si
       * risveglia — la stessa strada del dito sul pulsante (`handleCallback`:
       * `decide` poi `wake` poi `onWork`), quindi la ripresa rilegge la
       * risposta dal registro come ha sempre fatto. Mai `take` da qui: la
       * risposta vale quando il modello rifà la chiamata, non quando l'owner
       * scrive il comando.
       */
      let risposteDate = 0;
      if (modo === 'yolo') {
        for (const aperta of deps.approvals.openRows(riga.id)) {
          // Prima risposta vince: un pulsante premuto un attimo prima resta
          // dell'owner, non della delega.
          if (deps.approvals.decide(aperta.id, 'allow', now(), 'delegation') === 'ok') risposteDate += 1;
        }
        if (risposteDate > 0 && deps.turns.wake(riga.id, now())) {
          try {
            deps.onWork?.();
          } catch {
            /* la corsia batte comunque: la spinta è cortesia, non il risveglio */
          }
        }
      }
      return { turnId: riga.id, cambiato, risposteDate };
    },
  };
}
