import { ATTR, type Tracer } from '../tracing/types.js';
import { type AskFacts, buildEnvelope, stateHash } from './envelope.js';
import { SHADOW_PACK, SHADOW_PACK_CAPABILITIES, SHADOW_PACK_VERSION } from './pack.js';
import { JudgmentError, type SystemOnePort } from './port.js';
import type { JudgmentStore } from './store.js';

/**
 * Il runtime dello shadow: **giudica senza mai fermare la domanda**.
 *
 * Il ramo `ask` chiama `shadow()` e prosegue — l'owner riceve la sua
 * bolla subito, il turno si sospende come sempre, e il giudizio atterra
 * quando atterra (il turno tipico aspetta l'owner per minuti: il sensore
 * ha tutto il tempo). Nessun `await` nel percorso dell'ask, perché la
 * latenza di System One non deve diventare la latenza di una domanda
 * all'owner.
 *
 * Il ciclo: riga `pending` al momento del lancio, poi `ok`/`timeout`/
 * `error` quando il verdetto o il guasto arriva. Il crash a metà lascia
 * la pending in vista — il buco si legge, non si nasconde.
 *
 * **La chiusura**: fire-and-forget e un database che si chiude sono la
 * coppia che una volta si portava dietro il gateway (il commento di
 * `buildRuntime.close` lo nomina). In produzione `close()` **non aspetta**
 * i suoi hook (li lancia e chiude il db subito dopo), quindi i giudizi in
 * volo alla chiusura restano `pending`: la riga lo dice, il report lo
 * conta, e nessuno interpreta il buco come un verdetto — una settle contro
 * un db chiuso fallisce e finisce nel `.catch` qui sotto, senza rejections
 * orfane. `drain()` esiste per chi *può* aspettare (i test; un domani un
 * `close()` che sappia attendere): aspetta i volo con un tetto, e oltre
 * `DRAIN_MAX_MS` la riga resta pending e la verità è quella.
 */

const DRAIN_MAX_MS = 15_000;

export type ShadowJudge = {
  /** Le capability che questo pacchetto giudica — le altre non partono proprio. */
  capabilities: ReadonlySet<string>;
  /** Il provider attivo, per `sys.inspect`: la postura si legge, non si indovina. */
  provider: string;
  /** Il modello richiesto, per `sys.inspect`. Chi ha risposto davvero sta nelle righe. */
  model: string;
  /** Registra il giudizio per un ask e ritorna subito, comunque vada. */
  shadow(facts: AskFacts, keys: { approvalId: string; turnId: string }): void;
  /** Aspetta i giudizi in volo, al massimo `DRAIN_MAX_MS` — per la chiusura. */
  drain(): Promise<void>;
};

export function makeShadowJudge(deps: {
  port: SystemOnePort;
  store: JudgmentStore;
  tracer: Tracer;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}): ShadowJudge {
  const now = deps.now ?? (() => new Date());
  const inVolo = new Set<Promise<void>>();

  const esegui = (facts: AskFacts, keys: { approvalId: string; turnId: string }): Promise<void> => {
    const span = deps.tracer.start('muffin.judgment.shadow', {
      [ATTR.capability]: facts.capability,
    });
    const envelope = buildEnvelope(facts);
    const hash = stateHash(envelope);
    const partito = Date.now();
    const riga = deps.store.record({
      approvalId: keys.approvalId,
      turnId: keys.turnId,
      capability: facts.capability,
      pack: SHADOW_PACK_VERSION,
      stateHash: hash,
      envelope: JSON.stringify(envelope),
      provider: deps.port.provider,
      requestedModel: deps.port.model,
      delegationMode: facts.delegationMode,
      askedAt: now().toISOString(),
    });
    return deps.port
      .judge({ state: envelope, questions: SHADOW_PACK })
      .then((verdetto) => {
        deps.store.settle(riga, {
          status: 'ok',
          model: verdetto.model,
          answers: JSON.stringify(verdetto.answers),
          inputTokens: verdetto.usage?.inputTokens ?? null,
          outputTokens: verdetto.usage?.outputTokens ?? null,
          latencyMs: verdetto.latencyMs,
          settledAt: now().toISOString(),
        });
        span.setAttributes({
          'muffin.judgment.status': 'ok',
          'muffin.judgment.model': verdetto.model,
          'muffin.judgment.latency_ms': verdetto.latencyMs,
        });
        span.end({ status: 'ok' });
      })
      .catch((error: unknown) => {
        // Il timeout è un dato diverso dall'errore: la fase 2 ne conta i due
        // separatamente (affidabilità vs lentezza), e mescolarli qui
        // falsificherebbe il report a monte. Il kind arriva solo dall'adapter.
        const failure = error instanceof JudgmentError ? error.failure : null;
        const detail =
          failure !== null
            ? `${failure.kind}: ${failure.detail}`
            : error instanceof Error
              ? error.message
              : `guasto non tipizzato: ${JSON.stringify(String(error))}`;
        // La latenza del fallimento si misura come i secondi spesi, non come 0.
        const chiuso = deps.store.settle(riga, {
          status: failure?.kind === 'timeout' ? 'timeout' : 'error',
          detail,
          latencyMs: Date.now() - partito,
          settledAt: now().toISOString(),
        });
        // Lo span si chiude comunque: anche una settle che non può più
        // scrivere (db già chiuso) non deve lasciare un figlio appeso.
        span.setAttributes({
          'muffin.judgment.status': failure?.kind === 'timeout' ? 'timeout' : 'error',
          'muffin.judgment.error': detail,
        });
        span.end({ status: 'error', error: detail });
        if (!chiuso) return; // già chiusa: la storia non si riscrive
        (deps.log ?? (() => {}))(
          `system one: giudizio fallito per ${facts.capability} — ${detail}`,
        );
      });
  };

  return {
    capabilities: new Set(SHADOW_PACK_CAPABILITIES),
    provider: deps.port.provider,
    model: deps.port.model,
    shadow(facts, keys) {
      // Mai un giudizio che possa rompere il percorso dell'ask: neanche la
      // costruzione dei fatti ha autorità su quella domanda. Se il sensore
      // non parte, lo si legge nel log — l'owner non lo scopre mai.
      try {
        const volo = esegui(facts, keys).catch(() => {});
        inVolo.add(volo);
        void volo.then(() => {
          inVolo.delete(volo);
        });
      } catch (error) {
        (deps.log ?? (() => {}))(
          `system one: shadow non partito per ${facts.capability} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async drain() {
      const scadenza = Date.now() + DRAIN_MAX_MS;
      while (inVolo.size > 0 && Date.now() < scadenza) {
        await Promise.race([...inVolo, new Promise<void>((r) => setTimeout(r, 250))]);
      }
    },
  };
}
