import { ambienteSection, tenantClass, todoSection, type IstanzaFacts } from '../context/assemble.js';
import type { ReinjectedHistory } from '../context/history-taint.js';
import type { TodoItem } from '../../core/turns/todo.js';
import type { AudioBlock, ContentBlock, ImageBlock, Message } from '../providers/types.js';
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
 */
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
  const { kept, dropped } = spoken;

  // A REPL session used all afternoon would otherwise grow until the provider
  // refuses the request — and then refuse it again on every following turn,
  // because the next turn reads the same oversized history. The session was
  // permanently dead and the only cure was guessing `/new`.
  //
  // The cut is at the front and it is announced, so the model knows there is a
  // before rather than believing the conversation started here. Recall is what
  // brings back the parts that mattered, which is the whole reason it exists.
  const messages: Message[] = [];
  if (dropped > 0) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[${dropped} messaggi precedenti di questa sessione non sono nel contesto. Se ti serve qualcosa di prima, cercalo in memoria invece di indovinare.]`,
        },
      ],
    });
  }
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
   */
  for (const m of kept) {
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
    messages.push({
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
   * Unconditional, and that is the point: a plan the model has to remember to
   * ask for is a plan it forgets the moment its own earlier prose is compacted.
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
  // as a separate user turn the model might answer. It is already fenced and
  // framed as low-authority context (renderForPrompt); here it simply precedes
  // the actual words.
  messages.push({
    role: 'user',
    content: [
      ...recalled,
      { type: 'text' as const, text: ambiente },
      ...(plan === '' ? [] : [{ type: 'text' as const, text: plan }]),
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
      ...media(input),
      { type: 'text', text: input.text },
    ],
  });
  return messages;
}
