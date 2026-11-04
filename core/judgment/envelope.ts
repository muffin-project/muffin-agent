import { createHash } from 'node:crypto';
import { redactText } from '../tracing/redact.js';
import type { EnvelopeState } from './port.js';

/**
 * L'envelope dell'azione: **i fatti compatti che il giudizio serve**, non la
 * conversazione e non il repository (commento «Shell Action Envelope» della
 * #740). Costruito nel punto in cui l'ask nasce, dove questi fatti esistono
 * già tutti — il loop non calcola niente di nuovo per il sensore.
 *
 * Esce dalla macchina quando il provider è attivo, quindi esce **redatto**:
 * `redactText`, la stessa del tracing, su ogni campo testuale — un comando
 * con dentro un token diventa «curl -H Authorization: «redacted:N» …»
 * prima di partire e prima di finire nella riga. La descrizione del modello
 * è una *claim*, non una verità: entra come dato da giudicare, con la
 * domanda `description_matches_command` a verificarla.
 *
 * Lo stesso oggetto si persiste in `ask_judgments`: senza envelope la
 * calibrazione successiva non può rigiocare lo stesso stato con pacchetti
 * nuovi.
 */

/** I fatti grezzi che il ramo `ask` già possiede quando chiede all'owner. */
export type AskFacts = {
  /** La richiesta che ha aperto il lavoro — l'intenzione dell'owner. */
  intent: string | null;
  capability: string;
  effectRow: string | null;
  risk: string | null;
  reversible: string | null;
  rerunnable: boolean;
  /** Ciò che l'owner vede: il comando, l'URL, il percorso. */
  resource: string | undefined;
  /** La descrizione che il modello ha dato della sua chiamata. */
  description: string | undefined;
  taint: number;
  taintOrigin: string | null;
  principal: string;
  tenant: string;
  /** La postura di delega al momento dell'ask: serve a leggere la riga dopo. */
  delegationMode: string;
  /** Il perché il kernel ha chiesto invece di decidere da sé. */
  askPrompt: string;
};

const pulito = (testo: string | null | undefined): string | null =>
  testo === undefined || testo === null ? null : redactText(testo);

/**
 * L'envelope, con campi nominali — la stessa struttura arriva al modello e
 * alla riga, quindi chi legge il report vede ciò che il giudice ha visto.
 */
export function buildEnvelope(facts: AskFacts): EnvelopeState {
  return {
    owner_request: pulito(facts.intent),
    action: {
      capability: facts.capability,
      effect_row: facts.effectRow,
      risk: facts.risk,
      reversible: facts.reversible,
      rerunnable: facts.rerunnable,
      resource: pulito(facts.resource) ?? null,
      description: pulito(facts.description) ?? null,
    },
    context: {
      principal: facts.principal,
      tenant: facts.tenant,
      taint: facts.taint,
      taint_origin: pulito(facts.taintOrigin) ?? null,
      delegation_mode: facts.delegationMode,
    },
    policy: {
      verdict: 'ask',
      reason: pulito(facts.askPrompt) ?? null,
    },
  };
}

/**
 * L'impronta dello stato: la riga la porta perché il confronto fra
 * calibrazioni e rigiocature ragiona per stato, non per riga di database.
 * Sha-256 troncato a 16 esadecimali, come gli args del registro effetti —
 * stessa casa, stessa lunghezza, per non inventare una terza convenzione.
 */
export function stateHash(envelope: EnvelopeState): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex').slice(0, 16);
}
