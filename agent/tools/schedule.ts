import { z } from 'zod';
import { forwardIdOf } from '../../core/gateway/forward.js';
import { armingTier, type CapabilityDecl } from '../../core/policy/types.js';
import { type Job, JobError, type JobStore } from '../../core/scheduler/jobs.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * Conversational scheduling uses the same JobStore as the CLI.
 *
 * Fino a oggi `JobStore.add` aveva un solo chiamante fuori da test ed eval:
 * `muffin jobs add --cron`, digitato dall'owner a un terminale
 * (`cli/jobs.ts`). Una frase come «ricordamelo ogni giorno alle 9» non aveva
 * nessuna strada di produzione verso una riga durevole — e il sintomo è
 * registrato in `agent/context/assemble.ts` (WORK_RULES, episodio 310): senza
 * un tool da chiamare, il modello ha spiegato l'assenza come un permesso
 * negato, mandando l'owner a cercare un'impostazione che non esiste.
 *
 * La scorciatoia vietata è lo shell-out verso `muffin jobs add --cron`: un
 * job nasce lì con un principal di sistema a `taint: 0`, quindi un intento
 * scritto da un turno a taint 2 diventerebbe un giro futuro pulito —
 * provenance lavata attraverso una shell. Questo tool è l'unica seconda
 * strada, e atterra sullo **stesso store** con la **stessa validazione**
 * (`nextFire`): nessun secondo motore cron, nessuna shell arbitraria, nessuna
 * superficie con uno scheduler suo.
 *
 * Cosa attraversa il confine del job futuro e cosa no:
 *
 * - il turno scrive tenant, superficie, principal, turno e **soffitto**
 *   (`max(taint, intrinsicTaint)`, la stessa distinzione di `todo due`:
 *   l'intrinseco esclude per costruzione il caso differito) sulla riga;
 * - il giro futuro parte da quel taint, in quel tenant, attribuito al job
 *   (`agent/scheduler-run.ts` legge la riga invece del letterale 0);
 * - delivery goes to the originating conversation's `ctx.replyChannel`. An
 *   owner request from a place that cannot receive a later result (the plain
 *   terminal, or a terminal command forwarded to the gateway) goes to the
 *   owner's primary surface: its bare id, which each surface resolves to the
 *   owner's own room. Never a chat chosen by the model, never another chat.
+ *
+ * Contratto di cardinalità: one accepted durable schedule effect → one Job.
+ * Due chiamate distinte con gli stessi argomenti sono due richieste
+ * legittime (due righe); la STESSA identity `(turn_id, call_id)` non
+ * riesegue mai (`runTool` rigioca l'outcome registrato).
 */

const CLEAN: 0 = 0;

export const scheduleCapability: CapabilityDecl = {
  id: 'jobs.schedule',
  /**
   * `context`: i byte restano dentro il confine del tenant che li scrive —
   * una riga nella nostra tabella, niente sull'host, niente in rete adesso.
   * Ciò che la riga farà parlare domani passa dal giro futuro, che parte dal
   * taint scritto qui e attraversa il kernel come qualunque altro turno.
   */
  effect: 'context',
  /**
   * `low`, come `todo` e per la stessa ragione: scrive una riga in una
   * tabella nostra, delimitata al tenant chiamante dall'handler e non da un
   * argomento — niente sull'host, niente in rete adesso.
   *
   * NON `medium`: la classe di rischio decide anche il verdetto, e
   * `medium` + `undoable` è `draft` — un checkpoint che per un tool senza
   * `resolveEffectPath` (una riga DB non è un file fotografabile
   * dall'`UndoJournal`) rifiuta ogni chiamata con `draft_unsnapshottable`.
   * Il precedente che sembrava dire `medium`, `wait`, è `reversible: 'yes'`
   * ed è proprio quel `'yes'` a tenerlo eseguibile; qui le righe non si
   * cancellano mai (§I-8), quindi `undoable` è onesto e il rischio a renderlo
   * eseguibile deve essere `low`. Ciò che la riga impegna per domani (lavoro
   * e spesa dei giri futuri) resta misurato dove avviene: tetto per-job,
   * sigillo mensile e gate dello scheduler, non in questa dichiarazione.
   */
  risk: 'low',
  /**
   * `undoable`: la riga resta (`jobs` non cancella mai, §I-8) ma `jobs remove`
   * la spegne — le occorrenze future non partono più. Quelle già girate
   * restano avvenute, ed è ciò che distingue `undoable` da `yes`.
   */
  reversible: 'undoable',
  /**
   * **`false`, ed è la promessa load-bearing di questo file.**
   *
   * Dopo un crash il loop riesegue solo le chiamate la cui capability dice
   * `rerunnable`: una seconda esecuzione di questa handler scriverebbe una
   * seconda riga — «ricordamelo ogni giorno alle 9» detto due volte, ogni
   * giorno, per sempre. `todo plan` può dirsi `true` perché normalizza il
   * testo e fa upsert sulla stessa riga; qui due richieste identiche sono due
   * righe legittime (l'owner può volerlo davvero due volte), quindi nessuna
   * normalizzazione può renderle la stessa senza inventarsi un'identità. La
   * ripresa non ricrea: il modello, al turno ripreso, vede che non c'è un
   * esito e può chiedere di nuovo — una riga in più per una domanda esplicita
   * è recuperabile, una in più per un replay silenzioso no.
   */
  rerunnable: false,
  resourceKind: 'none',
  policyArgs: ['cron', 'goal'],
  /**
   * Host only, come `wait` e `todo`: la stessa domanda aperta — un membro che
   * arma lavoro durevole con il contesto dell'owner — e la stessa risposta
   * fail-closed finché non è esaminata. La manopola per dirgli di sì a una
   * stanza nominata è quella di ADR-0073 punto 5, non un flag qui.
   */
  hostOnly: true,
};

const scheduleSpec: ToolSpec = {
  name: 'schedule_recurring',
  description:
    'Create a recurring reminder or job from conversation ("remind me every day at 9", "ogni lunedì alle 18 ricordami X"). ' +
    'Use it when the owner asks for something repeated on a schedule. ' +
    'Takes a 5-field cron expression and the reminder text, validates both deterministically, and each accepted call persists ' +
    'one durable job on the same store as `muffin jobs add` — the job survives restarts and fires on schedule. ' +
    "`timezone` is an IANA zone and defaults to the owner's own zone; never guess one from the process environment. " +
    "Delivery goes to this conversation's surface; from the terminal it goes to the owner's primary messaging surface. " +
    'Not for independent one-shot objectives, dated reminders, or resuming this turn. Use `schedule_once`, `todo` + `due`, or `wait`, respectively. ' +
    'Never emulate this with a shell command: there is no shell path to the scheduler.',
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description: 'Standard 5-field cron expression, e.g. "0 9 * * *" for daily at 09:00',
      },
      goal: {
        type: 'string',
        description:
          "What Muffin should say or do at each fire, in the owner's words (max 500 chars)",
      },
      timezone: {
        type: 'string',
        description: "IANA timezone the cron is interpreted in (default: the owner's own zone)",
      },
    },
    required: ['cron', 'goal'],
  },
};

const scheduleArgs = z.object({
  cron: z.string().min(1).max(100),
  goal: z.string().min(1).max(500),
  timezone: z.string().min(1).max(60).optional(),
});

const onceSpec: ToolSpec = {
  name: 'schedule_once',
  description:
    'Arm an independent background objective once, due on the next gateway tick ("fallo in background una sola volta"). ' +
    'Use it when the owner explicitly asks to delegate one run. The job survives restart and reports back to this conversation. ' +
    "From the terminal, results go to the owner's primary messaging surface. " +
    'Not for a dated reminder or resuming the current turn. Use `todo` + `due` or `wait`, respectively.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: "The owner's objective, in their words (max 500 chars)",
      },
    },
    required: ['goal'],
    additionalProperties: false,
  },
};

const onceArgs = z.strictObject({ goal: scheduleArgs.shape.goal }).transform(({ goal }) => ({
  goal,
  cron: undefined,
  timezone: undefined,
}));

export function makeScheduleTool(
  deps: {
    jobs: JobStore;
    /** La zona dell'owner dal RoT sigillato — mai quella del processo. */
    defaultTimezone: string;
    /**
     * The owner's primary surface id (`surfaces.default`, e.g. `telegram`), read
     * at call time because `muffin surface default` can change it while the
     * gateway runs. Used only for owner requests with no surviving reply channel.
     */
    ownerPrimarySurface?: () => string | undefined;
  },
  mode: 'recurring' | 'once' = 'recurring',
): RegisteredTool {
  const once = mode === 'once';
  return {
    capability: scheduleCapability.id,
    spec: once ? onceSpec : scheduleSpec,
    /**
     * `throwTier: 0`. L'handler è sincrono, valida con `safeParse`, e gli unici
     * throw raggiungibili sono `JobError` tradotto in `isError` qui sotto e un
     * errore SQLite dello store — il fallimento del tool stesso, senza un byte
     * del chiamante.
     */
    throwTier: 0,
    handler: (args, ctx) => {
      const parsed = (once ? onceArgs : scheduleArgs).safeParse(args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content: `argomenti non validi: ${issue?.path.join('.') ?? 'cron'} — ${issue?.message ?? 'illeggibile'}`,
          isError: true,
          tier: CLEAN,
        };
      }
      const cron = parsed.data.cron?.trim();
      const goal = cron === '' ? '' : parsed.data.goal.trim();
      if (goal === '') {
        return {
          content: 'il testo del promemoria è vuoto — dimmi cosa devo ricordare',
          isError: true,
          tier: CLEAN,
        };
      }
      // Il tenant e la provenance vengono dal turno, mai dagli argomenti — la
      // stessa regola di `todo` e `memory`: chiavi in più nel payload del
      // modello vengono ignorate, lo store non le vede mai.
      const { tenant, principal, turnId } = ctx;
      /**
       * Il soffitto che arma l'intento (`armingTier`, l'unico proprietario
       * dell'invariante — la stessa che `todo due` scrive come `due_tier`):
       * un trigger differito è proprio il caso che `intrinsicTaint()`
       * esclude per costruzione (pagina letta al turno N, promemoria chiesto
       * al turno N+1).
       */
      const arming = armingTier(ctx.taint(), ctx.intrinsicTaint());
      // Il canale è dove è nata la conversazione, mai un destinatario scelto
      // dal modello: quello sarebbe un nuovo recipient dentro una capability
      // `context`.
      const channel = deliveryChannel(ctx.replyChannel, principal.kind, deps.ownerPrimarySurface);
      if (channel === undefined) {
        return {
          content:
            'This conversation has no address for a later result and no primary messaging surface is connected. No job was created. Offer to do the work now, or ask the owner to connect a messaging surface (`muffin surface enable`).',
          isError: true,
          tier: CLEAN,
        };
      }
      const surface = channel.split(':', 1)[0] ?? channel;
      const timezone = parsed.data.timezone?.trim() || deps.defaultTimezone;
      const jobInput = {
        timezone,
        channel,
        goal,
        origin: { tenant, surface, principal: principal.kind, turnId, tier: arming },
      };
      let job: Job;
      try {
        job =
          cron === undefined ? deps.jobs.addOnce(jobInput) : deps.jobs.add({ ...jobInput, cron });
      } catch (error) {
        if (error instanceof JobError) {
          return { content: `promemoria non creato: ${error.message}`, isError: true, tier: CLEAN };
        }
        throw error;
      }
      if (job.once) {
        return {
          content: `job ${job.id.slice(0, 8)} armato una volta (${job.id}) — in coda per il prossimo giro\n${goal}`,
          tier: CLEAN,
        };
      }
      const next = job.nextFireAt.toLocaleString('it-IT', {
        timeZone: job.timezone,
        dateStyle: 'short',
        timeStyle: 'short',
      });
      return {
        content:
          `job ${job.id.slice(0, 8)} creato (${job.id}) — prossima esecuzione ${next} (${job.timezone}) su ${job.channel}\n` +
          `${goal}`,
        tier: CLEAN,
      };
    },
  };
}

/**
 * Where a deferred result goes. The conversation's own channel when it can
 * receive later messages. Otherwise, for the owner only, the bare id of the
 * owner's primary surface: a surface resolves its bare id to the owner's own
 * room (for Telegram, the paired private chat), so this fallback can never
 * name another chat. The terminal is not a destination for later results.
 */
export function deliveryChannel(
  replyChannel: string | null | undefined,
  principalKind: string,
  ownerPrimarySurface: (() => string | undefined) | undefined,
): string | undefined {
  if (replyChannel && forwardIdOf(replyChannel) === null) return replyChannel;
  if (principalKind !== 'owner') return undefined;
  const primary = ownerPrimarySurface?.()?.split(':', 1)[0]?.trim();
  if (!primary || primary === 'cli' || forwardIdOf(primary) !== null) return undefined;
  return primary;
}
