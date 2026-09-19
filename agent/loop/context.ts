import { ambienteSection, tenantClass, todoSection, type IstanzaFacts } from '../context/assemble.js';
import type { ReinjectedHistory } from '../context/history-taint.js';
import type { TodoItem } from '../../core/turns/todo.js';
import type { SessionMessage } from '../../core/session/store.js';
import type { AudioBlock, ContentBlock, ImageBlock, Message, MessageOrigin } from '../providers/types.js';
import { directiveMessage, harnessMessage, isAutomationPrincipal, ownerMessage, provenanceMessage } from './message-origin.js';
import type { TurnInput } from './types.js';

/**
 * Context assembly for the loop, moved out of `agent/loop.ts` in pure form:
 * the first-message media/text ordering, the media extractors a resume
 * rebuilds `TurnInput`-shaped data from, and `buildContext` itself. See
 * `agent/loop.ts`'s own module docstring for what the loop is.
 */

/**
 * Il contenuto del primo messaggio utente: le immagini e poi il testo.
 *
 * L'ordine non è estetico. Le docs Vision di Anthropic lo dicono esplicitamente
 * («Claude works best when images come before text»), e non costa niente farlo
 * anche sull'altro adattatore.
 *
 * Una sola funzione perché i due punti che costruiscono questo messaggio —
 * `enqueueTurn` e `runTurn` — devono costruirlo **identico**: erano già due
 * copie della stessa riga, e una riga duplicata che cresce è una riga che
 * diverge.
 */
export function primoMessaggio(input: TurnInput): ContentBlock[] {
  return [...media(input), { type: 'text', text: input.text }];
}

/**
 * Ciò che viaggia **prima** del testo nel primo messaggio utente.
 *
 * Un posto solo che lo sappia. Quando c'erano solo le immagini la stessa riga
 * era già scritta in due punti, e il commento accanto diceva che una riga
 * duplicata che cresce è una riga che diverge — l'audio è esattamente la
 * crescita che quel commento prevedeva.
 */
export function media(input: { images?: ImageBlock[]; audios?: AudioBlock[] }): (ImageBlock | AudioBlock)[] {
  return [...(input.images ?? []), ...(input.audios ?? [])];
}

/**
 * Le immagini che l'owner ha mandato in questo turno, dal record.
 *
 * Tutte quelle nei messaggi utente e non solo l'ultimo: il testo prende
 * l'ultimo perche' una ripresa vuole *la domanda corrente*, mentre
 * un'immagine mandata due giri fa e' ancora la cosa di cui si sta parlando.
 */
export function userImages(messages: Message[]): ImageBlock[] {
  return messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.filter((b): b is ImageBlock => b.type === 'image'));
}

/** Gemella di `userImages`, stessa ragione: una nota vocale di due giri fa è ancora la cosa di cui si parla. */
export function userAudios(messages: Message[]): AudioBlock[] {
  return messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.filter((b): b is AudioBlock => b.type === 'audio'));
}

/**
 * Context assembly, outermost-stable first: identity, then tool definitions,
 * then recalled memory, then the message. Variable content never precedes
 * stable content, or the cache prefix is invalidated on every turn.
 *
 * Since Context P0 the assembly is typed BEFORE it is flattened: `assembleSemantic`
 * returns one section per provenance (memory, runtime facts, open work, owner
 * bytes, history replay, truncation notice) and `buildContext` flattens the
 * sections into the wire-neutral `Message[]` every existing caller reads.
 * Provider `role` is never the source of truth for what a section is — see
 * `MessageOrigin` and the per-provider compiler (`agent/providers/compile.ts`).
 */
export type SemanticSectionKey = 'announcement' | 'history' | 'memory' | 'runtime' | 'work' | 'owner';

/**
 * One turn's context as typed sections, stable first, volatile last.
 *
 * The stable prefix itself (constitution/system prompt, tool schemas) lives
 * OUTSIDE this structure — `ChatCall.system` (boot-built, byte-identical per
 * tenant class) and `ChatCall.tools` — so every section here is volatile by
 * construction and the owner input is always last. A Context Receipt observer
 * (see `describeAssembly`) reads the sections, never the flattened array.
 */
export type SemanticContext = {
  /** History-truncation notice, or null when nothing was cut. Harness control, not owner words. */
  announcement: Message | null;
  /**
   * Replayed session lines plus sparse temporal gap markers.
   *
   * Rebuilt from the session file, which stores no origin: replayed lines keep
   * their legacy (absent) origin on purpose — durable evidence, never harness
   * control, never the current owner input. Gap markers derived at render time
   * from `SessionMessage.createdAt` ride interleaved as harness control, so a
   * resumption after hours/days is legible without timestamping every line and
   * without laundering derived metadata as owner words (P1-A #529).
   */
  history: Message[];
  /** Rendered recall, or null when recall returned nothing. */
  memory: Message | null;
  /** Per-turn facts: clock, surface, model, instance. Always present. */
  runtime: Message;
  /** Open plan rows, or null when no row is open (zero cost). */
  work: Message | null;
  /**
   * The current directive, always last.
   *
   * Human turns carry ONLY surface bytes and media with `owner` origin. An
   * automation directive (`system`/`agent` principal — scheduler, dev) rides
   * here instead as `work` with explicit automation framing: WORK/RUNTIME
   * context, never impersonated owner input (P1-A #529 autonomy seam, via
   * `directiveMessage`).
   */
  owner: Message;
};

export type SemanticArgs = {
  input: TurnInput;
  recalled: ContentBlock[];
  open: TodoItem[];
  spoken: ReinjectedHistory;
  adesso: Date;
  modello: string;
  profilo: string;
  istanza: IstanzaFacts | undefined;
  timeZone: string | undefined;
  undoneTraceIds: ReadonlySet<string>;
  firstEncounter?: boolean;
};
export function buildContext(
  input: TurnInput,
  recalled: ContentBlock[],
  /**
   * The open plan, read and **taint-accounted by the caller**.
   *
   * Passed in rather than read here, and that is the whole point of the
   * parameter: showing these rows to the model raises the turn's taint, and a
   * function that both fetched them and rendered them would be the one place
   * where the raise could be forgotten without anything looking wrong. The
   * caller has the snapshot; this has the strings.
   */
  open: TodoItem[],
  /**
   * The session history, already cut to what will actually be reinjected —
   * **taint-accounted by the caller**, same reasoning as `open` immediately
   * above and the same reason it is a parameter rather than a re-read here:
   * `drive` computed `historyTaint` over this exact `kept` set and raised the
   * snapshot with it before calling this function, so a second, independent
   * read-and-slice in here could only ever disagree with that one by
   * accident. See `agent/context/history-taint.ts`'s `reinjectedHistory`.
   */
  spoken: ReinjectedHistory,
  /**
   * Il momento del turno.
   *
   * Passato, non letto qui, per la stessa ragione di `open` e `spoken`: la
   * funzione compone e non decide, e un `new Date()` dentro renderebbe questa
   * funzione impossibile da provare — la data cambierebbe a ogni esecuzione del
   * test. Il chiamante ha già il suo orologio iniettabile (`deps.now`).
   */
  adesso: Date,
  /** Quale modello sta rispondendo, e con quale profilo. Vedi `ambienteSection`. */
  modello: string,
  profilo: string,
  /**
   * I fatti d'istanza di `docs/evidence/orizzonte-del-turno-2026-09-03.md`
   * Parte 0 — `undefined` quando `deps.istanza` non è cablato (test minimi,
   * `LoopDeps` di default). Letto qui e non ricalcolato: `deps.istanza()` in
   * `agent/runtime.ts` legge le stesse fonti di `sys_inspect`.
   */
  istanza: IstanzaFacts | undefined,
  /**
   * Il fuso dell'owner dal RoT sigillato (`deps.timeZone`). `undefined` solo
   * nei test minimi che non lo cablano — `ambienteSection` cade allora sul
   * fuso del processo, lo stesso comportamento di prima di questo campo.
   */
  timeZone: string | undefined,
  /**
   * D11's other half: the `traceId`s of turns whose effects `muffin undo`
   * has already put back — resolved once by the caller (`drive`), same
   * shape as `taintByTrace`/`historyTaint` immediately above it there.
   *
   * Read only against `m.role === 'assistant'`: the agent's own claim is
   * what can go stale, and marking a `user` line here would be marking the
   * owner's own words as something that needs correcting, which is the
   * wrong direction entirely.
   */
  undoneTraceIds: ReadonlySet<string>,
  firstEncounter = false,
): Message[] {
  return flattenSemantic(
    assembleSemantic({
      input,
      recalled,
      open,
      spoken,
      adesso,
      modello,
      profilo,
      istanza,
      timeZone,
      undoneTraceIds,
      firstEncounter,
    }),
  );
}

/** Sections in wire-neutral order: stable first, owner input last. */
export function flattenSemantic(ctx: SemanticContext): Message[] {
  return [
    ...(ctx.announcement === null ? [] : [ctx.announcement]),
    ...ctx.history,
    ...(ctx.memory === null ? [] : [ctx.memory]),
    ctx.runtime,
    ...(ctx.work === null ? [] : [ctx.work]),
    ctx.owner,
  ];
}

/**
 * P1-A #529 temporal salience rules (exact, tested in `context-salience.test.ts`).
 *
 * - R1 background plan: undated open todos render as silent internal continuity
 *   (`todoSection`); surfacing needs relevance, an explicit plan question,
 *   blocking, due via the existing commitment path, or another explicit
 *   proactivity policy. "Still pending" alone never suffices.
 * - R2 temporal gaps: `SessionMessage.createdAt` + turn `adesso` derive sparse
 *   harness gap markers. Gaps below `HISTORY_GAP_MIN_MS` render nothing, so
 *   rapid chat stays clean; larger gaps render one marker each (`pausa` between
 *   lines, `ripresa` before the current turn), never a timestamp on every line.
 * - R3 provenance: replayed lines stay legacy evidence, markers stay harness
 *   control, plan stays `work`, facts stay `runtime`, automation directives
 *   ride as `work` (never `owner`). `describeAssembly` + provider compiler are
 *   reused unchanged; no parallel scheduler/cooldown exists.
 */

/** Below this gap, history renders with no temporal metadata at all. */
export const HISTORY_GAP_MIN_MS = 5 * 60 * 1000;

/** Human duration for a gap marker: minutes under an hour, hours under a day, days beyond. */
export function formatHistoryGapDuration(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 60) return `${minutes} minut${minutes === 1 ? 'o' : 'i'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} or${hours === 1 ? 'a' : 'e'}`;
  const days = Math.round(hours / 24);
  return `${days} giorn${days === 1 ? 'o' : 'i'}`;
}

function historyTimeOf(m: SessionMessage): number | undefined {
  const at = Date.parse(m.createdAt);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * One turn's context as typed sections.
 *
 * Same inputs as `buildContext` (which delegates here and flattens): the
 * split is the invariant. Memory, runtime facts and open work each ride in
 * their own message with their own provenance, and the current directive
 * carries ONLY its own bytes — owner surface bytes for a person, framed
 * WORK/RUNTIME automation context for a system/agent principal — never
 * `role: 'user'` as a sack for everything the loop knows.
 */
export function assembleSemantic(args: SemanticArgs): SemanticContext {
  const { input, recalled, open, spoken, adesso, modello, profilo, istanza, timeZone, undoneTraceIds } = args;
  const firstEncounter = args.firstEncounter ?? false;
  const { kept, dropped } = spoken;

  // A REPL session used all afternoon would otherwise grow until the provider
  // refuses the request — and then refuse it again on every following turn,
  // because the next turn reads the same oversized history. The session was
  // permanently dead and the only cure was guessing `/new`.
  //
  // The cut is at the front and it is announced, so the model knows there is a
  // before rather than believing the conversation started here. Recall is what
  // brings back the parts that mattered, which is the whole reason it exists.
  //
  // The notice is loop-written, not owner-authored: it goes out marked
  // harness, so a continuation to a new lease archives it instead of replaying
  // a stale count, and no synthetic line ever reads as the owner's words.
  const announcement: Message | null =
    dropped > 0
      ? harnessMessage('user', [
          {
            type: 'text',
            text: `[${dropped} messaggi precedenti di questa sessione non sono nel contesto. Se ti serve qualcosa di prima, cercalo in memoria invece di indovinare.]`,
          },
        ])
      : null;
  /**
   * Da dove viene questa riga, quando non viene da qui.
   *
   * Finché ogni finestra veniva da una porta sola, `{role, content}` nudo era
   * giusto: non c'era niente da distinguere. Da ADR-0056 la conversazione
   * dell'owner attraversa le porte, e una riga senza marca è una riga di cui
   * il modello non sa se è stata detta a voce al telefono o scritta in un
   * terminale — la stessa classe di errore che `describeEpisodeSource` chiude
   * per la memoria, spostata dalla memoria al contesto.
   *
   * Marcata **solo** quando la superficie è diversa da quella del turno: una
   * marca che compare ovunque smette di essere letta, ed è la regola che
   * `core/memory/recall.ts` porta già scritta per `temporalLabel`. Una riga
   * vecchia senza `surface` non viene marcata: dire `[undefined]` sarebbe
   * peggio del silenzio.
   *
   * Replayed lines keep their legacy (absent) origin on purpose: the session
   * file stores no provenance, so reconstructing one here would be guessing.
   * Absent reads as durable evidence — never harness control, never the
   * current owner input — which is exactly what a replayed line is.
   */
  const history: Message[] = [];
  let previousAt: number | undefined;
  for (const m of kept) {
    const at = historyTimeOf(m);
    if (at !== undefined && previousAt !== undefined) {
      const gap = at - previousAt;
      if (gap >= HISTORY_GAP_MIN_MS) {
        history.push(
          harnessMessage('user', [
            { type: 'text' as const, text: `[pausa di circa ${formatHistoryGapDuration(gap)} nella conversazione]` },
          ]),
        );
      }
    }
    if (at !== undefined) previousAt = at;
    const altrove = m.surface !== undefined && m.surface !== '' && m.surface !== input.surface;
    const testo = altrove ? `[${m.surface}] ${m.content}` : m.content;
    /**
     * D11: la stessa riga che «ho scritto nota.md» smette di leggersi come
     * corrente dopo un `muffin undo` di quel turno. Non riscritta e non
     * tolta — è ancora ciò che il modello ha detto — ma marcata *qui*, alla
     * lettura, così una sessione che ha già scritto la riga su disco (JSONL,
     * append-only) non deve mai essere toccata per restare vera.
     */
    const disfatto = m.role === 'assistant' && m.traceId !== undefined && undoneTraceIds.has(m.traceId);
    history.push({
      role: m.role as 'user' | 'assistant',
      content: [
        {
          type: 'text' as const,
          text: disfatto
            ? `${testo}\n[quel turno è stato disfatto con \`muffin undo\`: i file che dice di aver toccato sono tornati com'erano prima. Non trattarla come stato attuale del disco.]`
            : testo,
        },
      ],
    });
  }
  // Trailing gap: the last replayed line may be hours/days before this turn.
  // The turn already knows `adesso` (runtime facts), but without this marker
  // the model cannot tell whether the replayed exchange ended seconds or days
  // ago. Sparse like the inter-line markers above: silence when recent.
  if (previousAt !== undefined) {
    const trailing = adesso.getTime() - previousAt;
    if (trailing >= HISTORY_GAP_MIN_MS) {
      history.push(
        harnessMessage('user', [
          {
            type: 'text' as const,
            text: `[ripresa dopo circa ${formatHistoryGapDuration(trailing)} — l'ultimo scambio risale a prima di questo turno]`,
          },
        ]),
      );
    }
  }
  /**
   * The plan, on every turn of the session, whether or not anyone asked.
   *
   * This is the read half of `todo`, and its placement is the decision: **not**
   * in `systemPrompts`, which is assembled once at boot and is the cacheable
   * prefix — a list that changes every turn would go in front of the stable
   * text and cost the warm prefix on every message, which is the mistake
   * `docs/history/design-notes/m3-caching-and-per-connector-timing.md` records the peers
   * avoiding. So it rides in the volatile tail, next to recalled memory, for
   * the same reason recall does.
   *
   * Unconditional availability, background salience (P1-A #529): a plan the
   * model has to remember to ask for is a plan it forgets the moment its own
   * earlier prose is compacted — but mere presence must not nag. See
   * `todoSection` for the quiet-state framing.
   */
  const plan = todoSection(open);

  /**
   * Che momento è, e dove stai parlando. Vedi `ambienteSection`: senza,
   * chiedere l'ora faceva partire una richiesta di permesso per `sys.shell`.
   */
  const ambiente = ambienteSection({
    adesso,
    surface: input.surface,
    classe: tenantClass(input.principal, input.tenant),
    tenant: input.tenant,
    model: modello,
    profilo,
    ...(istanza ? { istanza } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(firstEncounter ? { firstEncounter } : {}),
  });

  // Recalled memory rides in the same turn as the message it is context for, not
  // as a separate user turn the model might answer — but in its OWN message,
  // marked as retrieved evidence. It is already fenced and framed as
  // low-authority context (renderForPrompt); the marker is what keeps the
  // fencing structural instead of prose the model must notice.
  const memory: Message | null =
    recalled.length > 0 ? provenanceMessage('user', 'memory', [...recalled]) : null;

  const runtime = provenanceMessage('user', 'runtime', [{ type: 'text' as const, text: ambiente }]);

  const work: Message | null =
    plan === '' ? null : provenanceMessage('user', 'work', [{ type: 'text' as const, text: plan }]);

  // Le immagini stanno **qui**, non nel record.
  //
  // `drive` svuota `messages` e lo ricostruisce da questa funzione a ogni
  // giro: cio' che sta nel record e' cio' che e' successo, cio' che sta qui
  // e' cio' che il modello vede. Metterle solo nel record — che e' quello
  // che avevo fatto — le faceva sparire in silenzio, e il modello
  // rispondeva «non vedo nessuna immagine» a una domanda su una foto che
  // era arrivata davvero. Misurato contro il modello vero il 28/08/2026.
  //
  // Subito prima del testo, dopo il ricordato e il piano: le docs di
  // entrambi i provider raccomandano immagine-poi-testo, e questa e'
  // l'unica posizione che lo rispetta senza separare la domanda dal suo
  // contesto.
  //
  // Persona umana: solo i byte della superficie — niente memoria richiamata,
  // niente fatti di runtime, niente piano. Ciò che l'owner ha scritto, e
  // nient'altro. Automazione (`system`/`agent`): WORK/RUNTIME context con
  // framing esplicito, mai parole dell'owner (P1-A #529 — la provenienza è
  // strutturale via `directiveMessage`, la distinguibilità per il modello è
  // testuale via il prefisso qui sotto, perché `origin` non viaggia sul filo).
  const owner = isAutomationPrincipal(input.principal)
    ? directiveMessage(input.principal, [
        ...media(input),
        {
          type: 'text' as const,
          text:
            `[lavoro automatico — non è l'owner a parlare; contesto WORK/RUNTIME, mai input dell'owner]\n${input.text}`,
        },
      ])
    : ownerMessage([...media(input), { type: 'text', text: input.text }]);

  return { announcement, history, memory, runtime, work, owner };
}

/**
 * What a Context Receipt observer can see of one assembly — and nothing else.
 *
 * Pure shaping over the sections: per-section source (`origin`), a fixed
 * inclusion reason, block count and byte/char sizes, and the stability class.
 * No raw text, no memory content, no owner words, no paths, no secrets cross
 * this boundary by construction: sizes are measured, never retained.
 *
 * Deliberately NOT the full Context Receipt (`agent/context/receipt.ts`,
 * #592): that module owns the turn-wide rollup (taint, strategies,
 * tool accounting, redaction counts) and recomputes nothing. This is the
 * assembly half of its future input — sections this function built, described
 * where they were built, so no second reader can disagree about what was
 * selected.
 */
export type AssemblySectionDescriptor = {
  key: SemanticSectionKey;
  origin: MessageOrigin | 'legacy';
  /** Why this section entered, fixed vocabulary. */
  reason:
    | 'history-truncated-notice'
    | 'session-replay'
    | 'recall-rendered'
    | 'turn-facts'
    | 'open-plan-rows'
    | 'surface-input'
    | 'automation-directive';
  /** Every section here is volatile: the stable prefix lives outside this structure. */
  stability: 'stable' | 'volatile';
  blocks: number;
  bytes: number;
  chars: number;
};

const SECTION_REASON: Record<SemanticSectionKey, AssemblySectionDescriptor['reason']> = {
  announcement: 'history-truncated-notice',
  history: 'session-replay',
  memory: 'recall-rendered',
  runtime: 'turn-facts',
  work: 'open-plan-rows',
  owner: 'surface-input',
};

function measureBlocks(content: ContentBlock[]): { blocks: number; bytes: number; chars: number } {
  let bytes = 0;
  let chars = 0;
  for (const b of content) {
    if (b.type === 'text') {
      bytes += Buffer.byteLength(b.text, 'utf8');
      chars += [...b.text].length;
    } else if (b.type === 'image' || b.type === 'audio') {
      // Base64 payload size, never the payload: enough to weigh the section.
      chars += b.data.length;
      bytes += b.data.length;
    }
    // tool_use / tool_result / thinking carry identity, not bulk: counted as blocks only.
  }
  return { blocks: content.length, bytes, chars };
}

export function describeAssembly(ctx: SemanticContext): AssemblySectionDescriptor[] {
  const sections: { key: SemanticSectionKey; message: Message }[] = [
    ...(ctx.announcement === null ? [] : [{ key: 'announcement' as const, message: ctx.announcement }]),
    ...ctx.history.map((message) => ({ key: 'history' as const, message })),
    ...(ctx.memory === null ? [] : [{ key: 'memory' as const, message: ctx.memory }]),
    { key: 'runtime' as const, message: ctx.runtime },
    ...(ctx.work === null ? [] : [{ key: 'work' as const, message: ctx.work }]),
    { key: 'owner' as const, message: ctx.owner },
  ];
  return sections.map(({ key, message }) => {
    const { blocks, bytes, chars } = measureBlocks(message.content);
    // The terminal section is keyed `owner` for shape stability, but an
    // automation directive rides it as `work`: the reason says what it is, so
    // a receipt reader never mistakes scheduled work for surface input.
    const reason =
      key === 'owner' && (message.origin ?? 'legacy') === 'work' ? 'automation-directive' : SECTION_REASON[key];
    return {
      key,
      origin: message.origin ?? 'legacy',
      reason,
      stability: 'volatile' as const,
      blocks,
      bytes,
      chars,
    };
  });
}
