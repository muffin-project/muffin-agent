import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import type {
  ApprovalRequest,
  TurnDelta,
  TurnEvent,
  TurnInput,
  TurnResult,
} from '../../agent/loop/types.js';
import type { SessionRef } from '../session/store.js';
import type { DeliveryOutcome, FileSpec } from '../surface/types.js';
import { LANE_TURNS, type ModelLane } from '../turns/model-lane.js';
import type { TurnRecord, TurnStore } from '../turns/store.js';
import { resolveSocketPath } from './control-socket.js';

/**
 * Un turno del terminale eseguito dal gateway, sul runtime del gateway.
 *
 * Quando il gateway è vivo è l'unico execution owner della Home: il REPL non
 * ricostruisce provider/model/profile/budget/tool in proprio, ma chiede qui.
 * L'esecuzione avviene nel processo del gateway, sulla sua `ModelLane` — la
 * stessa che serializza scheduler e turn lane — quindi un turno del terminale
 * e uno di Telegram non chiamano mai il modello insieme.
 *
 * Il contratto, in breve (il dettaglio sta nei tipi sotto):
 *
 * - **un'execution, un id stabile**: coniato dal client (`input.id`), è anche
 *   l'id della riga del turno. Rieseguire lo stesso id non riesegue niente:
 *   a esecuzione finita torna l'esito registrato, a esecuzione in corso il
 *   secondo socket si attacca come osservatore. Nessun replay automatico, mai.
 * - **disconnect ≠ cancel**: chiudere il socket senza `cancel` lascia
 *   l'esecuzione in corso; l'esito resta interrogabile per id (`query`). Solo
 *   un frame `cancel` esplicito abortisce.
 * - **approvazione nello stesso owner**: la domanda del kernel viaggia al
 *   client sullo stesso socket e la risposta rientra nella stessa execution —
 *   non nasce mai una seconda execution per l'approvazione.
 * - **autorità invariata**: il gateway esegue, il kernel decide. Questo modulo
 *   non introduce grant, non allarga capability, non tocca trust/taint.
 */

export const FORWARD_CHANNEL_PREFIX = 'forward:';

export function forwardChannel(id: string): string {
  return `${FORWARD_CHANNEL_PREFIX}${id}`;
}

export function forwardIdOf(channel: string): string | null {
  return channel.startsWith(FORWARD_CHANNEL_PREFIX)
    ? channel.slice(FORWARD_CHANNEL_PREFIX.length)
    : null;
}

/** Prima riga C→S. `id` è l'execution id coniato dal client. */
export type RunRequest = {
  verb: 'run';
  protocol: 2;
  id: string;
  text: string;
  sessionId: string;
  images?: TurnInput['images'];
  audios?: TurnInput['audios'];
};

export type ServerEvent =
  | { kind: 'started'; turnId: string; model: string; ownerPid: number; attached: boolean }
  | { kind: 'delta'; delta: TurnDelta }
  | { kind: 'progress'; event: TurnEvent }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'file'; absolutePath: string; filename: string; caption?: string; bytes: number }
  | { kind: 'result'; result: TurnResult }
  | { kind: 'error'; error: string; outcome: 'failed' | 'unknown'; turnId?: string };

export type ClientFrame =
  | { kind: 'cancel' }
  | { kind: 'approval-answer'; answer: 'allow' | 'deny' | 'unavailable' };

export type ExecutionQuery =
  | { found: false }
  | {
      found: true;
      status: TurnRecord['status'];
      stopped: TurnResult['stopped'] | null;
      text: string | null;
      turnId: string;
    };

export type ForwardDeps = {
  modelLane: ModelLane;
  /** La claim di *questo* gateway, riletta — lo stesso controllo che scheduler e lane usano (P20). */
  stillOwner: () => boolean;
  turns: Pick<TurnStore, 'get'>;
  openSession: (id: string) => SessionRef;
  /** `runTurn` legato alle deps del gateway: provider, profilo, budget e tool di chi esegue. */
  execute: (input: TurnInput) => Promise<TurnResult>;
  /**
   * Il modello che l'esecuzione userà, letto all'attacco — non uno snapshot
   * del boot: dal #532 il modello si ricarica al confine del turno, e un
   * `/model` fra boot e `run` deve leggersi qui, non nel processo che chiede.
   */
  model: () => string;
  log: (line: string) => void;
};

type Observer = { send: (event: ServerEvent) => void; sock: Socket };

type Execution = {
  id: string;
  abort: AbortController;
  observers: Set<Observer>;
  /** Presente solo a esecuzione finita: la fonte per dedup e query. */
  result?: TurnResult;
  error?: { error: string; outcome: 'failed' | 'unknown' };
  approvalWaiter: { resolve: (answer: 'allow' | 'deny' | 'unavailable') => void } | null;
};

/** Quanti esiti finiti restano in memoria: oltre, la riga durevole è la fonte (query). */
const DONE_KEEP = 100;

const LANE_POLL_MS = 50;

export function mintExecutionId(): string {
  return randomBytes(16).toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTurnResult(value: unknown): TurnResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.text !== 'string' || typeof value.turnId !== 'string' || typeof value.stopped !== 'string') {
    return null;
  }
  return value as unknown as TurnResult;
}

export class ForwardHost {
  private readonly executions = new Map<string, Execution>();

  constructor(private readonly deps: ForwardDeps) {}

  /**
   * L'approvatore `cli` del gateway: instrada per turnId all'execution viva.
   *
   * Senza execution viva torna `unavailable` — il comportamento di oggi per un
   * turno `cli` che il gateway non sta eseguendo per nessuno: il turno si
   * ferma dicendo cosa voleva, invece di chiedere nel vuoto.
   */
  approve = (
    request: ApprovalRequest,
    where: { turnId: string },
  ): Promise<'allow' | 'deny' | 'asked' | 'unavailable'> => {
    const exec = this.executions.get(where.turnId);
    if (!exec || exec.result || exec.error) return Promise.resolve('unavailable');
    if (exec.observers.size === 0) return Promise.resolve('unavailable');
    return new Promise<'allow' | 'deny' | 'unavailable'>((resolve) => {
      exec.approvalWaiter = { resolve };
      // L'ultima risposta vince se il client si stacca: vedi `detach`.
      this.emit(exec, { kind: 'approval', request });
      exec.abort.signal.addEventListener(
        'abort',
        () => {
          if (exec.approvalWaiter !== null) {
            exec.approvalWaiter = null;
            // Un cancel durante l'approvazione non è un diniego: l'effetto non
            // è partito perché nessuno l'ha concesso. `unavailable` chiude il
            // turno dicendo cosa voleva (`stopped: 'ask'`), e il client che ha
            // cancellato lo dice come annullato.
            resolve('unavailable');
          }
        },
        { once: true },
      );
    });
  };

  ownsChannel(channel: string): boolean {
    return forwardIdOf(channel) !== null;
  }

  deliverFile = async (channel: string, file: FileSpec): Promise<DeliveryOutcome> => {
    const id = forwardIdOf(channel);
    const exec = id === null ? undefined : this.executions.get(id);
    if (!exec || exec.result || exec.error || exec.observers.size === 0) {
      return {
        delivered: false,
        why: 'il terminale che ha chiesto questo turno non è più collegato',
      };
    }
    let bytes = 0;
    try {
      bytes = statSync(file.absolutePath).size;
    } catch {
      return { delivered: false, why: `${file.absolutePath} non è leggibile` };
    }
    this.emit(exec, {
      kind: 'file',
      absolutePath: file.absolutePath,
      filename: file.filename,
      ...(file.caption === undefined ? {} : { caption: file.caption }),
      bytes,
    });
    return { delivered: true };
  };

  query(id: string): ExecutionQuery {
    const exec = this.executions.get(id);
    if (exec?.result) {
      return {
        found: true,
        status: 'done',
        stopped: exec.result.stopped,
        text: exec.result.text,
        turnId: exec.result.turnId,
      };
    }
    const row = this.deps.turns.get(id);
    if (!row) return { found: false };
    if (row.status === 'done') {
      return {
        found: true,
        status: row.status,
        stopped: row.outcome,
        text: lastAssistantText(row),
        turnId: row.id,
      };
    }
    return { found: true, status: row.status, stopped: null, text: null, turnId: row.id };
  }

  handleRun(sock: Socket, first: Record<string, unknown>): void {
    const req = readRunRequest(first);
    if (!req) {
      sendLine(sock, {
        kind: 'error',
        error: 'richiesta `run` illeggibile (id, text, sessionId)',
        outcome: 'failed',
      } satisfies ServerEvent);
      sock.end();
      return;
    }
    const known = this.executions.get(req.id);
    if (known?.result) {
      sendLine(sock, { kind: 'result', result: known.result } satisfies ServerEvent);
      sock.end();
      return;
    }
    if (known?.error) {
      sendLine(sock, { kind: 'error', ...known.error } satisfies ServerEvent);
      sock.end();
      return;
    }
    if (known) {
      this.attach(sock, known, true);
      return;
    }
    // Una riga con lo stesso id ma nessuna execution viva: un tentativo
    // precedente (magari di un processo morto) l'ha già scritta. Rieseguirla
    // duplicherebbe gli effetti — fail closed: niente esecuzione, esito
    // interrogabile per id.
    if (this.deps.turns.get(req.id)) {
      sendLine(sock, {
        kind: 'error',
        error: `un turno con id ${req.id} esiste già: non lo rieseguo, interroga il suo esito`,
        outcome: 'unknown',
        turnId: req.id,
      } satisfies ServerEvent);
      sock.end();
      return;
    }
    const exec: Execution = {
      id: req.id,
      abort: new AbortController(),
      observers: new Set(),
      approvalWaiter: null,
    };
    this.executions.set(req.id, exec);
    this.attach(sock, exec, false);
    void this.run(req, exec);
  }

  private attach(sock: Socket, exec: Execution, attached: boolean): void {
    const observer: Observer = {
      sock,
      send: (event) => {
        try {
          sock.write(`${JSON.stringify(event)}\n`);
        } catch {
          // La scrittura fallita si scopre alla chiusura: non qui.
        }
      },
    };
    exec.observers.add(observer);
    observer.send({
      kind: 'started',
      turnId: exec.id,
      model: this.deps.model(),
      ownerPid: process.pid,
      attached,
    });
    let buf = '';
    sock.setEncoding('utf8');
    const onData = (chunk: string): void => {
      buf += chunk;
      // L'ultima riga può essere un frame a metà: resta nel buffer.
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        // Una riga che non è JSON è un client rotto: si ignora, la connessione
        // resta — chiudere qui trasformerebbe un typo in un esito sconosciuto.
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.onClientFrame(exec, frame);
      }
      // Un frame che non arriva mai è un client rotto o ostile: si tronca.
      if (buf.length > 65536) sock.destroy();
    };
    const onGone = (): void => {
      sock.off('data', onData);
      this.detach(exec, observer);
    };
    sock.on('data', onData);
    sock.on('close', onGone);
    sock.on('error', onGone);
  }

  private onClientFrame(exec: Execution, frame: Record<string, unknown>): void {
    if (frame.kind === 'cancel') {
      exec.abort.abort();
      return;
    }
    if (frame.kind === 'approval-answer' && exec.approvalWaiter !== null) {
      const answer = frame.answer;
      const waiter = exec.approvalWaiter;
      exec.approvalWaiter = null;
      waiter.resolve(answer === 'allow' ? 'allow' : answer === 'deny' ? 'deny' : 'unavailable');
    }
  }

  private detach(exec: Execution, observer: Observer): void {
    exec.observers.delete(observer);
    // L'ultima risposta a un'approvazione in attesa non resta appesa a un
    // socket morto: il turno si chiude dicendo cosa voleva (`ask`), e la riga
    // resta interrogabile. Mai un retry automatico.
    if (exec.approvalWaiter !== null && exec.observers.size === 0) {
      const waiter = exec.approvalWaiter;
      exec.approvalWaiter = null;
      waiter.resolve('unavailable');
    }
    try {
      observer.sock.destroy();
    } catch {
      // Chiusa già: niente da fare.
    }
  }

  private emit(exec: Execution, event: ServerEvent): void {
    for (const observer of [...exec.observers]) observer.send(event);
  }

  private finish(exec: Execution, event: Extract<ServerEvent, { kind: 'result' | 'error' }>): void {
    if (event.kind === 'result') exec.result = event.result;
    else exec.error = { error: event.error, outcome: event.outcome };
    this.emit(exec, event);
    // La connessione si chiude solo qui, a esito noto: una chiusura prima è
    // sempre `unknown` per il client, mai un silenzio da interpretare.
    for (const observer of [...exec.observers]) {
      try {
        observer.sock.end();
      } catch {
        // Chiusa già dal client: l'esito è stato comunque inviato.
      }
    }
    exec.observers.clear();
    // Dedup oltre la connessione: gli esiti finiti restano interrogabili per
    // id anche dopo che ogni socket si è chiuso.
    while (this.executions.size > DONE_KEEP) {
      const oldest = [...this.executions.keys()][0];
      const rec = oldest === undefined ? undefined : this.executions.get(oldest);
      if (oldest === undefined || rec === undefined) break;
      if (!rec.result && !rec.error) break;
      this.executions.delete(oldest);
    }
  }

  private async run(req: RunRequest, exec: Execution): Promise<void> {
    this.deps.log(
      `forward ${req.id.slice(0, 12)}: richiesta da terminale — sessione ${req.sessionId}`,
    );
    // La corsia, prima della riga: niente è partito finché non la teniamo, e
    // un client che si stacca qui non lascia niente alle spalle — l'errore è
    // deterministico (`failed`), mai `unknown`.
    while (!exec.abort.signal.aborted && exec.observers.size > 0) {
      if (!this.deps.stillOwner()) {
        return this.finish(exec, {
          kind: 'error',
          error: 'il gateway ha perso la claim prima di iniziare: niente è stato eseguito',
          outcome: 'failed',
        });
      }
      if (this.deps.modelLane.take(LANE_TURNS) === null) break;
      await new Promise((r) => setTimeout(r, LANE_POLL_MS));
    }
    if (exec.abort.signal.aborted || exec.observers.size === 0) {
      this.executions.delete(req.id);
      return;
    }
    if (!this.deps.stillOwner()) {
      this.deps.modelLane.release(LANE_TURNS);
      return this.finish(exec, {
        kind: 'error',
        error: 'il gateway ha perso la claim prima di iniziare: niente è stato eseguito',
        outcome: 'failed',
      });
    }
    let result: TurnResult;
    try {
      result = await this.deps.execute({
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: this.deps.openSession(req.sessionId),
        text: req.text,
        id: req.id,
        signal: exec.abort.signal,
        replyChannel: forwardChannel(req.id),
        onDelta: (delta) => this.emit(exec, { kind: 'delta', delta }),
        onProgress: (event) => this.emit(exec, { kind: 'progress', event }),
        ...(req.images !== undefined ? { images: req.images } : {}),
        ...(req.audios !== undefined ? { audios: req.audios } : {}),
      });
    } catch (error) {
      this.deps.modelLane.release(LANE_TURNS);
      // Dopo l'inizio l'esito è ambiguo per costruzione: potrebbe aver
      // eseguito effetti. Mai `failed`, mai un retry automatico.
      const row = this.deps.turns.get(req.id);
      this.deps.log(
        `forward ${req.id.slice(0, 12)}: errore dopo l'inizio — ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.finish(exec, {
        kind: 'error',
        error: `esecuzione interrotta da un errore (${error instanceof Error ? error.message : String(error)}) — esito sconosciuto`,
        outcome: row ? 'unknown' : 'failed',
        turnId: req.id,
      });
    }
    this.deps.modelLane.release(LANE_TURNS);
    this.deps.log(
      `forward ${req.id.slice(0, 12)}: esito ${result.stopped} dopo ${result.iterations} passaggi`,
    );
    this.finish(exec, { kind: 'result', result });
  }
}

function readRunRequest(first: Record<string, unknown>): RunRequest | null {
  if (first.verb !== 'run') return null;
  const id = first.id;
  const text = first.text;
  const sessionId = first.sessionId;
  if (typeof id !== 'string' || id === '' || id.length > 128) return null;
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return {
    verb: 'run',
    protocol: 2,
    id,
    text,
    sessionId,
    ...(first.images !== undefined ? { images: first.images as TurnInput['images'] } : {}),
    ...(first.audios !== undefined ? { audios: first.audios as TurnInput['audios'] } : {}),
  };
}

function sendLine(sock: Socket, event: ServerEvent): void {
  try {
    sock.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Una risposta che non parte si scopre alla chiusura.
  }
}

function lastAssistantText(row: TurnRecord): string | null {
  for (let i = row.messages.length - 1; i >= 0; i -= 1) {
    const m = row.messages[i];
    if (!m || m.role !== 'assistant') continue;
    const text = m.content
      .filter((b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text !== '') return text;
  }
  return null;
}

/**
 * L'esito non si è potuto determinare: l'esecuzione potrebbe aver completato
 * — effetti inclusi. Non è un errore da riprovare: è uno stato da
 * interrogare, per id.
 */
export class UnknownOutcomeError extends Error {
  constructor(readonly turnId: string) {
    super(
      `esito sconosciuto per il turno ${turnId.slice(0, 12)} — potrebbe aver completato, non rimandare alla cieca`,
    );
    this.name = 'UnknownOutcomeError';
  }
}

export type ForwardSink = {
  onDelta?: ((delta: TurnDelta) => void) | undefined;
  onProgress?: ((event: TurnEvent) => void) | undefined;
  onFile?:
    | ((file: { absolutePath: string; filename: string; caption?: string; bytes: number }) => void)
    | undefined;
  /** Chi ha eseguito davvero — modello e owner per la riga di chiusura. */
  onStarted?: ((info: { turnId: string; model: string; ownerPid: number }) => void) | undefined;
  approve: (request: ApprovalRequest) => Promise<'allow' | 'deny' | 'unavailable'>;
  signal?: AbortSignal | undefined;
};

/**
 * Esegue un turno sul gateway di questa home, come suo cliente.
 *
 * Il chiamante ha già risolto l'owner (`resolveExecutionOwner`): se il
 * gateway non c'era, non si arriva qui — si esegue in locale, sullo stesso
 * `TurnResult` ma su un altro owner, e lo si dice.
 */
export async function runViaGateway(
  home: string,
  req: {
    id?: string;
    text: string;
    sessionId: string;
    images?: TurnInput['images'];
    audios?: TurnInput['audios'];
  },
  sink: ForwardSink,
): Promise<TurnResult> {
  const id = req.id ?? mintExecutionId();
  const path = resolveSocketPath(home);
  if (!existsSync(path)) throw new Error('il gateway non risponde sul socket di controllo');
  const first: Record<string, unknown> = {
    verb: 'run',
    protocol: 2,
    id,
    text: req.text,
    sessionId: req.sessionId,
    ...(req.images !== undefined ? { images: req.images } : {}),
    ...(req.audios !== undefined ? { audios: req.audios } : {}),
  };
  return new Promise<TurnResult>((resolve, reject) => {
    let turnId = id;
    let settled = false;
    let buf = '';
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // Chiuso già.
      }
      fn();
    };
    const sock = connect(path);
    sock.setEncoding('utf8');
    const sendFrame = (frame: ClientFrame): void => {
      try {
        sock.write(`${JSON.stringify(frame)}\n`);
      } catch {
        // Il socket morto si scopre qui sotto, come `unknown`.
      }
    };
    if (sink.signal) {
      if (sink.signal.aborted) sendFrame({ kind: 'cancel' });
      else
        sink.signal.addEventListener('abort', () => sendFrame({ kind: 'cancel' }), { once: true });
    }
    sock.on('connect', () => {
      try {
        sock.write(`${JSON.stringify(first)}\n`);
      } catch (error) {
        done(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const kind = event.kind;
        if (kind === 'started') {
          if (typeof event.turnId === 'string') turnId = event.turnId;
          sink.onStarted?.({
            turnId,
            model: typeof event.model === 'string' ? event.model : '',
            ownerPid: typeof event.ownerPid === 'number' ? event.ownerPid : 0,
          });
        } else if (kind === 'delta') {
          sink.onDelta?.(event.delta as TurnDelta);
        } else if (kind === 'progress') {
          sink.onProgress?.(event.event as TurnEvent);
        } else if (kind === 'approval') {
          sink.approve(event.request as ApprovalRequest).then(
            (answer) => sendFrame({ kind: 'approval-answer', answer }),
            () => sendFrame({ kind: 'approval-answer', answer: 'unavailable' }),
          );
        } else if (kind === 'file') {
          sink.onFile?.(
            event as unknown as {
              absolutePath: string;
              filename: string;
              caption?: string;
              bytes: number;
            },
          );
        } else if (kind === 'result') {
          const result = asTurnResult(event.result);
          if (result) done(() => resolve(result));
          else done(() => reject(new UnknownOutcomeError(turnId)));
        } else if (kind === 'error') {
          const outcome = event.outcome;
          const message = typeof event.error === 'string' ? event.error : 'errore del gateway';
          if (outcome === 'unknown') done(() => reject(new UnknownOutcomeError(turnId)));
          else done(() => reject(new Error(message)));
        }
      }
      if (buf.length > 4_194_304) {
        done(() => reject(new UnknownOutcomeError(turnId)));
      }
    });
    // Una chiusura prima dell'esito non dice niente sull'esecuzione — che
    // continua — quindi non è un errore da riprovare: è `unknown`.
    sock.on('error', () => done(() => reject(new UnknownOutcomeError(turnId))));
    sock.on('close', () => done(() => reject(new UnknownOutcomeError(turnId))));
  });
}
