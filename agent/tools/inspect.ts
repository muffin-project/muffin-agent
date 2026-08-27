import { z } from 'zod';
import type { CapabilityDecl, CapabilityId, Principal } from '../../core/policy/types.js';
import type { Config } from '../../core/config/config.js';
import type { DoctorReport } from '../../cli/doctor.js';
import type { PromptBlock } from '../context/assemble.js';
import { visibleTools } from '../context/assemble.js';
import { tenantClass } from '../context/assemble.js';
import type { Profile } from '../profiles/profile.js';
import type { RegisteredTool } from '../loop.js';
import type { BuildStamp } from '../../cli/update.js';
import type { TurnHealth } from '../../core/turns/store.js';
import { jobPayload, type Job } from '../../core/scheduler/jobs.js';

/**
 * Propriocezione tecnica: cosa sta usando **adesso**, non cosa dice il progetto.
 *
 * M5-BIS E7, lacuna aggiunta dall'owner il 17/08. Prima di questo file il
 * modello poteva soltanto recitare ciò che il prompt dice o indovinare: alla
 * domanda «che modello usi?» rispondeva con quello scritto nel testo che gli è
 * stato dato mesi fa, che è una risposta plausibile e scollegata dalla
 * macchina.
 *
 * **La regola che decide la forma di questo file è una sola:** legge dalle
 * *stesse fonti autorevoli* di `muffin doctor`, `muffin prompt show` e
 * `muffin gateway status`. Non ricalcola niente. Un secondo modo di sapere se
 * l'indice vettoriale è a posto sarebbe una seconda risposta che diverge dalla
 * prima il giorno che una delle due cambia — ed è esattamente il difetto
 * trovato in #174 (`inputSchema` che dichiarava e zod che pretendeva) una
 * settimana prima che qualcuno lo cercasse.
 *
 * Per la stessa ragione qui non c'è documentazione infilata nel system prompt:
 * la descrizione dell'architettura sta nei documenti, e questo tool risponde
 * solo a «com'è **questa istanza**, ora».
 */
export const inspectCapability: CapabilityDecl = {
  id: 'sys.inspect',
  risk: 'low',
  reversible: 'yes',
  // Una lettura di stato nostro: due chiamate di fila danno la stessa risposta
  // o una più fresca, e non cambiano niente.
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  /**
   * `hostOnly: true`, e non è cautela generica.
   *
   * Il contenuto è la configurazione dell'installazione: provider, modelli,
   * percorsi, quali server MCP sono attaccati, quanti turni sono aperti. È
   * roba dell'owner. Un membro di un gruppo su Telegram che chiede «come sei
   * fatto» otterrebbe l'inventario della macchina di qualcun altro, e nessuna
   * riga di questo report gli serve per la conversazione che sta avendo.
   */
  hostOnly: true,
};

/**
 * Le fonti, passate invece che raggiunte.
 *
 * Un handler che chiamasse `paths()` o `loadConfig()` da sé leggerebbe la
 * macchina *di chi esegue*, non l'istanza che sta girando — e sarebbe la
 * seconda copia che questo file esiste per non avere. Tutto arriva da
 * `buildRuntime`, che è l'unico posto che sa davvero cosa è stato costruito.
 */
export type InspectSources = {
  config: Config;
  profile: Profile;
  /** `null` quando il RoT è integro: è la condizione, non un errore. */
  safeMode: { reason: string; diverged: string[] } | null;
  /** Come `doctor`: lo stampo del build, o `null` se non è un checkout git. */
  build: () => Promise<BuildStamp | null>;
  tools: readonly RegisteredTool[];
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  promptBlocks: Readonly<Record<string, readonly PromptBlock[]>>;
  /** La stessa funzione che esegue `muffin doctor`. Iniettabile per i test. */
  doctor: () => Promise<DoctorReport>;
  /**
   * `TurnStore.health()` — la stessa lettura che fa `doctor` e che il boot
   * del runtime usa per le sue `bootLines`. Non un conteggio nuovo: quello
   * darebbe una seconda risposta a «quanti turni sono in sospeso».
   */
  turns: () => TurnHealth;
  /** `JobStore.list()`, come `muffin jobs`. */
  jobs: () => Job[];
};

const inspectArgs = z.object({});

const SPEC_DESCRIPTION =
  "Read-only: come è configurata QUESTA istanza adesso — build, provider e modello in uso, " +
  'profilo attivo, root of trust, stato dei check di salute, capability esposte a questo turno, ' +
  'blocchi del system prompt con la loro provenienza, turni aperti, job. ' +
  "Usalo quando ti si chiede come funzioni o cosa stai usando: la risposta è misurata, non ricordata. " +
  "Non descrive l'architettura del progetto, solo lo stato vivo.";

/**
 * Una riga di check, senza il testo di terze parti.
 *
 * `doctor` mette nei `detail` anche il messaggio d'errore di una sonda — per
 * esempio quello dell'embedder locale, che è testo scritto da un processo che
 * non siamo noi. Passarlo di qui lo farebbe entrare nel turno, e allora questo
 * outcome non potrebbe più dichiarare `tier: 0` onestamente.
 *
 * Quindi: nome e livello sempre, `detail` solo per i check che passano. Il
 * valore della riga è «l'embedder risponde o no», non l'errno: chi vuole
 * l'errno ha `muffin doctor`, che lo mostra all'owner e non al modello.
 */
/**
 * Da dove arriva il turno, senza inventare un campo che non tutti i principal
 * hanno: scheduler e consolidamento non vengono da una surface, e dire
 * `undefined` sarebbe peggio che dire `interno`.
 */
function surfaceOf(principal: Principal): string {
  return 'connector' in principal ? principal.connector : `interno (${principal.kind})`;
}

function checkLine(c: DoctorReport['checks'][number]): string {
  const segno = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗';
  return c.level === 'ok' ? `  ${segno} ${c.name}: ${c.detail}` : `  ${segno} ${c.name}`;
}

export function makeInspectTool(sources: InspectSources): RegisteredTool {
  return {
    capability: inspectCapability.id,
    spec: {
      name: 'sys_inspect',
      description: SPEC_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
    },
    // Tier 0, e la ragione è la selezione fatta sopra: ogni byte di questo
    // report è una nostra frase, un valore che l'owner ha scritto nella config,
    // o un conteggio. Niente arriva da un terzo — per questo `checkLine` taglia
    // i `detail` dei check falliti invece di inoltrarli.
    throwTier: 0,
    handler: async (args, ctx) => {
      inspectArgs.parse(args);
      const principal: Principal = ctx.principal;
      const cls = tenantClass(principal, ctx.tenant);
      const [report, build] = await Promise.all([sources.doctor(), sources.build()]);
      const esposti = visibleTools(
        sources.tools.map((t) => ({ capability: t.capability, name: t.spec.name })),
        principal,
        sources.capabilities,
      );
      const blocchi = sources.promptBlocks[cls] ?? [];
      const salute = sources.turns();
      const job = sources.jobs();

      const righe = [
        '# Questa istanza, adesso',
        '',
        `build: ${build ? `${build.sha.slice(0, 12)} (${build.date})${build.dirty ? ' +modificato' : ''}` : 'sconosciuta — non è un checkout git'}`,
        `provider: ${sources.config.provider.kind}${sources.config.provider.baseUrl ? ` · ${sources.config.provider.baseUrl}` : ''}`,
        `modello: ${sources.config.models.main} (main) · ${sources.config.models.light} (light)`,
        // Il profilo non è cosmetico: decide quanti tool vede il modello e se
        // il reasoning viene chiesto spento (#167).
        `profilo: ${sources.profile.name} — max ${sources.profile.maxToolsExposed} tool esposti, ${sources.profile.maxToolCallsPerTurn} call/turno, thinking ${sources.profile.thinking}`,
        `root of trust: ${sources.safeMode ? `SAFE MODE (${sources.safeMode.reason}: ${sources.safeMode.diverged.join(', ')}) — capability sopra 'low' negate` : `${sources.config.rot.mode}, integro`}`,
        '',
        `# Questo turno`,
        `surface: ${surfaceOf(principal)} · principal: ${principal.kind} · tenant: ${ctx.tenant} · classe prompt: ${cls}`,
        `taint corrente: ${ctx.taint()}`,
        `capability esposte: ${esposti.map((t) => t.name).sort().join(', ')}`,
        sources.tools.length === esposti.length
          ? ''
          : `  (${sources.tools.length - esposti.length} registrate ma non esposte a questo principal)`,
        '',
        '# Salute, misurata adesso (le stesse verifiche di `muffin doctor`)',
        ...report.checks.map(checkLine),
        '',
        `# System prompt (classe ${cls}): ${blocchi.length} blocchi`,
        ...blocchi.map((b) => `  ${b.name} ← ${b.source} (${b.text.length} caratteri)`),
        '  [il recall della memoria non è qui: entra nei messages a ogni turno]',
        '',
        `# Turni: ${salute.total} in tutto · ${salute.waiting.count} in attesa · ${salute.undeliverable.count} senza indirizzo · ${salute.interrupted.length} interrotti`,
        `# Job (${job.length}):`,
        ...job.map(
          (j) =>
            `  ${j.cron} ${j.timezone} → ${j.channel} · ${j.kind} · ${j.active ? 'attivo' : 'spento'} · ultimo ${j.lastRunAt?.toISOString() ?? 'mai'} — ${jobPayload(j).slice(0, 60)}`,
        ),
      ];
      return { content: righe.filter((r) => r !== '').join('\n'), tier: 0 };
    },
  };
}
