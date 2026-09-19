import { z } from 'zod';
import { armingTier, type CapabilityDecl } from '../../core/policy/types.js';
import { type Job, JobError, type JobStore } from '../../core/scheduler/jobs.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * `schedule_recurring` — la porta conversazionale sui job ricorrenti.
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
 * - il canale di consegna NON è un argomento: è `ctx.replyChannel` o il
 *   default di superficie. Un destinatario scelto dal modello sarebbe un nuovo
 *   recipient — effetto `outward` — dentro una capability `context`.
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
   * `medium`, come `wait` e per la stessa ragione: la chiamata costa una riga,
   * ma impegna lavoro e spesa futuri — ogni occorrenza chiama il modello e
   * consegna su un canale. Valutato per ciò che impegna, non per ciò che fa.
   */
  risk: 'medium',
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
    'Takes a 5-field cron expression and the reminder text, validates both deterministically, and persists exactly one durable job ' +
    'on the same store as `muffin jobs add` — the job survives restarts and fires on schedule. ' +
    "`timezone` is an IANA zone and defaults to the owner's own zone; never guess one from the process environment. " +
    "Delivery goes to this conversation's surface. " +
    'Not for one-shots ("il 3 ottobre devo…": that is `todo` + `due`) or for waiting inside this turn (that is `wait`). ' +
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

export function makeScheduleTool(deps: {
  jobs: JobStore;
  /** La zona dell'owner dal RoT sigillato — mai quella del processo. */
  defaultTimezone: string;
  /**
   * Dove recapitare quando il turno non ha un canale vivo (CLI in-band).
   *
   * Una funzione e non un valore, per la stessa ragione di `CommitmentLaneDeps.channel`:
   * `surfaces.default` si gira con `muffin surface default` da un altro
   * processo mentre il gateway resta acceso — un valore letto al boot
   * obbedirebbe per sempre a un ieri. `config.json` è fuori dal sigillo, una
   * rilettura non attraversa nessun confine di fiducia.
   */
  defaultChannel: string | (() => string);
}): RegisteredTool {
  return {
    capability: scheduleCapability.id,
    spec: scheduleSpec,
    /**
     * `throwTier: 0`. L'handler è sincrono, valida con `safeParse`, e gli unici
     * throw raggiungibili sono `JobError` tradotto in `isError` qui sotto e un
     * errore SQLite dello store — il fallimento del tool stesso, senza un byte
     * del chiamante.
     */
    throwTier: 0,
    handler: (args, ctx) => {
      const parsed = scheduleArgs.safeParse(args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content: `argomenti non validi: ${issue?.path.join('.') ?? 'cron'} — ${issue?.message ?? 'illeggibile'}`,
          isError: true,
          tier: CLEAN,
        };
      }
      const goal = parsed.data.cron.trim() === '' ? '' : parsed.data.goal.trim();
      if (goal === '') {
        return {
          content: 'il testo del promemoria è vuoto — dimmi cosa devo ricordare',
          isError: true,
          tier: CLEAN,
        };
      }
      const cron = parsed.data.cron.trim();
      if (cron === '') {
        return {
          content: 'espressione cron vuota — serve un cron a 5 campi, per esempio "0 9 * * *"',
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
      const fallback =
        typeof deps.defaultChannel === 'function' ? deps.defaultChannel() : deps.defaultChannel;
      const channel =
        typeof ctx.replyChannel === 'string' && ctx.replyChannel !== ''
          ? ctx.replyChannel
          : fallback;
      const surface = channel.split(':')[0] ?? fallback;
      const timezone = parsed.data.timezone?.trim()
        ? parsed.data.timezone.trim()
        : deps.defaultTimezone;
      let job: Job;
      try {
        // `JobStore.add` valida (cron + timezone) PRIMA di qualunque scrittura
        // e lancia `JobError`: nessun ramo qui sotto conferma ciò che non è
        // stato persistito.
        job = deps.jobs.add({
          cron,
          timezone,
          channel,
          goal,
          origin: {
            tenant,
            surface,
            principal: principal.kind,
            turnId,
            tier: arming,
          },
        });
      } catch (error) {
        if (error instanceof JobError) {
          return { content: `promemoria non creato: ${error.message}`, isError: true, tier: CLEAN };
        }
        throw error;
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
