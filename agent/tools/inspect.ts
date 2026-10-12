import { z } from 'zod';
import type { DoctorReport } from '../../cli/doctor.js';
import type { BuildStamp } from '../../cli/update.js';
import { formatRunStatus, type RunStatus } from '../../core/autonomy/run-status.js';
import type { Config } from '../../core/config/config.js';
import type { CapabilityDecl, CapabilityId, Principal } from '../../core/policy/types.js';
import type { DelegationMode } from '../../core/runtime/delega.js';
import { type Job, jobPayload } from '../../core/scheduler/jobs.js';
import type { TurnHealth } from '../../core/turns/store.js';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityExposure,
} from '../capability-exposure.js';
import type { PromptBlock } from '../context/assemble.js';
import { tenantClass, visibleTools } from '../context/assemble.js';
import type { RegisteredTool } from '../loop.js';
import type { Profile, ProfileOrigin } from '../profiles/profile.js';
import type { CapabilityGap } from './capability-status.js';

/**
 * Propriocezione tecnica: cosa sta usando **adesso**, non cosa dice il progetto.
 *
 * DAY-1 requirement E7, lacuna aggiunta dall'owner il 17/08. Prima di questo file il
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
  effect: 'context',
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
  /**
   * Dove atterra la scrittura di questo turno — `Runtime.workspace`, cioè
   * l'esatto risultato di `resolveWorkspace` (ADR-0059), non una seconda
   * lettura. `muffin doctor` (`cli/doctor.ts`) risponde alla stessa domanda
   * per l'installazione in generale, tramite `describeWorkspace`; questo campo
   * è quello vivo, per questo processo, e può differire quando l'owner ha
   * scelto una cwd propria (`muffin run`/REPL fuori dalla casa).
   */
  workspace: string;
  profile: Profile;
  /** `null` quando il RoT è integro: è la condizione, non un errore. */
  safeMode: { reason: string; diverged: string[] } | null;
  /** Come `doctor`: lo stampo del build, o `null` se non è un checkout git. */
  build: () => Promise<BuildStamp | null>;
  tools: readonly RegisteredTool[];
  capabilities: ReadonlyMap<CapabilityId, CapabilityDecl>;
  /**
   * I grant per stanza della policy sigillata (ADR-0073). `sys_inspect` deve
   * rispondere «cosa raggiungo **io**, in questa stanza», e senza questi
   * risponderebbe la domanda di ieri: la lista di ciò che non è `hostOnly`.
   */
  grants?: ReadonlyMap<string, ReadonlySet<CapabilityId>>;
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
  /**
   * Fired autonomous runs with their 6-state answer (#598 S1). Letto dalle
   * stesse righe durevoli che il resto del report legge — mai ricalcolato
   * qui. Assente = il chiamante non lo fornisce: la sezione non compare.
   */
  runs?: (() => readonly RunStatus[]) | undefined;
  /**
   * System One attivo su questa installazione (issue #740 fase shadow):
   * provider e modello richiesto, per dire «sto giudicando in shadow» invece
   * di lasciarlo indovinare. Assente = nessun giudice configurato: la riga
   * non compare, non compare come «off» — il silenzio è il default onesto.
   */
  judgment?: (() => { provider: string; model: string }) | undefined;
  /**
   * La postura di delega di **questo** lavoro (issue #740): `manual`, `auto`
   * o `yolo`, e da quando. Letta dal registro durevole — `ctx.turnId`, mai
   * una copia — così il modello vede la stessa modalità che il loop applicherà
   * al prossimo ask.
   */
  delega?: ((turnId: string) => { modo: DelegationMode; dal: string | null }) | undefined;
  /**
   * Ogni capacità che questo assemblaggio ha spento o tagliato, dalla stessa
   * lista che produce le `bootLines` e che `muffin doctor` legge (E7, la
   * lacuna misurata il 03/09/2026: `web_search` spento, tre turni a
   * riprovare, e il motivo — un host mancante in `rot/egress.json` — seduto
   * in `gateway.err` da prima del primo tentativo).
   */
  capabilityGaps: readonly CapabilityGap[];
};

const inspectArgs = z.object({});

const SPEC_DESCRIPTION =
  'Read-only: come è configurata QUESTA istanza adesso — build, provider e modello in uso, ' +
  'profilo attivo, root of trust, stato dei check di salute, capability esposte a questo turno, ' +
  'blocchi del system prompt con la loro provenienza, turni aperti, job. ' +
  'Usalo quando ti si chiede come funzioni o cosa stai usando (che modello ti esegue, quanti tool vedi, ' +
  'se il RoT è integro): è il tool per questo, non un comando di sistema — la risposta è misurata, non ricordata. ' +
  "Non per l'architettura del progetto in teoria (quella sta nei documenti), solo per lo stato vivo di questo processo. " +
  'Ritorna un report testuale a sezioni: istanza, turno corrente, capacità spente, salute, system prompt, turni, job. ' +
  'e.g. sys_inspect({}) risponde a "che modello ti sta eseguendo, di preciso?" senza lanciare nulla in shell_run.';

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
 *
 * **Non «niente di terzi», però: una cosa passa, e la nomina un giudice.** I
 * nomi dei tool MCP (`mcp_<server>_<def.name>`) li sceglie il server, e questo
 * outcome li stampa. Il `tier: 0` regge lo stesso, ma per una ragione diversa da
 * quella scritta sopra: quei nomi sono fissati dal pin di `verifyTools`, cioè
 * l'owner li ha approvati uno per uno, e un server che ne cambia uno rompe il
 * pin invece di far comparire testo nuovo. È una difesa più stretta della frase
 * generica che aveva preso il suo posto.
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
      const runtimeInfo = ctx.runtimeInfo;
      const profile = runtimeInfo?.profile ?? sources.profile;
      const profileSource = runtimeInfo?.profileSource;
      const profiloOrigine =
        profileSource === undefined
          ? ''
          : profileSource.origin === 'conservative'
            ? ' · conservativo (nessun profilo matcha)'
            : ` · ${profileSource.origin} (${profileSource.file.split('/').pop()})`;
      const [report, build] = await Promise.all([sources.doctor(), sources.build()]);
      // Same authority filter and same #469 projection as the live loop.
      // Under the cap capability_search disappears entirely (ordinary fast
      // path). Under pressure the cap bounds only the currently loaded schemas:
      // the remaining authorized tools stay reachable through discovery.
      const filtrati = visibleTools(
        [...sources.tools],
        principal,
        sources.capabilities,
        sources.grants?.get(ctx.tenant),
      );
      const discoveryTool = filtrati.find(
        (tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME,
      );
      const initialProjection = createCapabilityExposure({
        eligible: filtrati,
        maxToolsExposed: profile.maxToolsExposed,
        ...(discoveryTool === undefined ? {} : { discoveryTool }),
      });
      const exposure =
        ctx.capabilityDiscovery?.snapshot() ?? {
          visible: initialProjection.exposed.map((tool) => tool.spec.name),
          pressured: initialProjection.pressured,
          hiddenCount: initialProjection.hiddenCount,
        };
      const esposti = [...exposure.visible];
      const spente = sources.capabilityGaps.filter((g) => g.kind === 'disabled');
      const blocchi = sources.promptBlocks[cls] ?? [];
      const salute = sources.turns();
      const job = sources.jobs();
      // Una sola lettura: la proiezione è pura, ma due chiamate sarebbero due
      // giri di SELECT per la stessa risposta.
      const runs = sources.runs?.() ?? null;

      const righe = [
        '# Questa istanza, adesso',
        '',
        `build: ${build ? `${build.sha.slice(0, 12)} (${build.date})${build.dirty ? ' +modificato' : ''}` : 'sconosciuta — non è un checkout git'}`,
        `provider: ${runtimeInfo?.providerKind ?? sources.config.provider.kind}${(runtimeInfo?.providerBaseUrl ?? sources.config.provider.baseUrl) ? ` · ${runtimeInfo?.providerBaseUrl ?? sources.config.provider.baseUrl}` : ''}`,
        `modello: ${runtimeInfo?.mainModel ?? sources.config.models.main} (main) · ${runtimeInfo?.lightModel ?? sources.config.models.light} (light)`,
        // Dove atterra la scrittura di *questo* turno — non «l'installazione»
        // in generale, che è la domanda a cui risponde `muffin doctor`. Stessa
        // fonte di `Runtime.workspace`: mai una seconda cartella calcolata qui.
        `cartella di lavoro: ${sources.workspace}`,
        // Il profilo non è cosmetico: decide quanti tool vede il modello e se
        // il reasoning viene chiesto spento (#167).
        `profilo: ${profile.name}${profiloOrigine} — max ${profile.maxToolsExposed} tool esposti, ${profile.maxToolCallsPerTurn === null ? 'nessun tetto numerico di tool call' : `${profile.maxToolCallsPerTurn} call/turno`}, thinking ${profile.thinking}`,
        `root of trust: ${sources.safeMode ? `SAFE MODE (${sources.safeMode.reason}: ${sources.safeMode.diverged.join(', ')}) — capability sopra 'low' negate` : `${sources.config.rot.mode}, integro`}`,
        ...(sources.judgment === undefined
          ? []
          : [
              `system one: ${sources.judgment().provider} · ${sources.judgment().model} — shadow: giudica accanto agli ask, non consuma`,
            ]),
        '',
        `# Questo turno`,
        `surface: ${surfaceOf(principal)} · principal: ${principal.kind} · tenant: ${ctx.tenant} · classe prompt: ${cls}`,
        `taint corrente: ${ctx.taint()}`,
        // La postura che il loop applicherà al prossimo ask (issue #740):
        // `manual` chiede, `yolo` ha pre-approvato, `auto` chiede finché il
        // giudizio non è calibrato. Letta adesso, non ricordata.
        `delega: ${(() => {
          const d = sources.delega?.(ctx.turnId);
          if (d === undefined || d.modo === 'manual')
            return "manual — ogni conferma arriva all'owner";
          if (d.modo === 'yolo')
            return `yolo — ask pre-approvati per delega${d.dal === null ? '' : ` dal ${d.dal}`}`;
          return `auto — chiede finché il giudizio non è calibrato${d.dal === null ? '' : ` (attiva dal ${d.dal})`}`;
        })()}`,
        `capability esposte: ${esposti.sort().join(', ')}`,
        sources.tools.length === filtrati.length
          ? ''
          : `  (${sources.tools.length - filtrati.length} registrate ma non esposte a questo principal)`,
        exposure.pressured
          ? `  (catalogo discoverable: ${exposure.hiddenCount} tool autorizzati non-core; maxToolsExposed limita gli schema caricati, non la raggiungibilità)`
          : '',
        '',
        // Distinto da quanto sopra apposta: qui non è «non visto da questo
        // principal» né «tagliato dal tetto», è «non esiste in questa
        // installazione», con la ragione misurata e non ricordata (E7).
        ...(spente.length === 0
          ? []
          : [
              '# Capacità spente',
              ...spente.map(
                (g) =>
                  `  ✗ ${g.capability}: ${g.reason}${g.remedy === null ? '' : ` → ${g.remedy}`}`,
              ),
              '',
            ]),
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
            // Il tetto per-job compare solo quando c'è: è la differenza fra
            // «questo job può ancora girare» e «questo job è fermo finché non
            // cambia il mese», e senza la riga il modello che si ispeziona
            // leggerebbe un job attivo che in realtà non parte più.
            `  ${j.cron} ${j.timezone} → ${j.channel} · ${j.kind} · ${j.active ? 'attivo' : 'spento'}${j.perJobUsd === null ? '' : ` · tetto $${j.perJobUsd}/mese`} · ultimo ${j.lastRunAt?.toISOString() ?? 'mai'} — ${jobPayload(j).slice(0, 60)}`,
        ),
        // Le run autonome armate (#598 S1): la stessa proiezione che il
        // runtime espone, una riga per occorrenza registrata. Assente = il
        // chiamante non la fornisce, e la sezione non compare.
        ...(runs === null
          ? []
          : [
              `# Run autonome (${runs.length}):`,
              ...runs.map((r) => `  ${formatRunStatus(r)}`),
              '  stati: pending/running/continuable/done/needs-owner/failed — vedi core/autonomy/run-status.ts',
            ]),
      ];
      return { content: righe.filter((r) => r !== '').join('\n'), tier: 0 };
    },
  };
}
