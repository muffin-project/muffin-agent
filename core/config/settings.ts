import {
  describeSettableKnobs as describeFromRegistry,
  ownerCommandAuthorization,
  plan,
  SETTABLE_CONFIG_KEYS as REGISTRY_KEYS,
} from './actions.js';
import { commit } from './actions-commit.js';
import type { ActionSource } from './actions-types.js';

/**
 * `muffin config set <chiave> <valore>` — la funzione sola dietro le porte.
 *
 * ADR-0036 ha reso `muffin config` di sola lettura *apposta*, per non dover
 * sorvegliare una superficie di scrittura prima che il tetto di spesa fosse
 * sigillato per davvero (risolto da ADR-0039). Con quella precondizione
 * sciolta l'owner ha chiesto la superficie che ADR-0036 stessa anticipava —
 * *«le impostazioni le possiamo mettere solo tramite json, dovremo avere un
 * /settings»* — e ha posto un vincolo esplicito su questo giro: **il modello
 * non deve poter cambiare le impostazioni**. Non è la stessa domanda di «Muffin
 * può guidare la conversazione a scrivere `voice.md`» (quella resta la
 * superficie a capability, kernel-gated, non costruita qui) — è l'owner stesso
 * che digita un comando esplicito.
 *
 * Perché questo modulo vive in `core/` e non in `cli/` o `agent/`: la regola di
 * casa è che una manopola gira da una funzione sola chiamata da più porte
 * (`docs/decisions/`, il pattern di `promptVersion`/`cmdPromptVersion` e di
 * `cmdSurfaceDefault`). `cli/config.ts` la chiama per `muffin config set`,
 * `agent/comandi.ts` la chiama per `/config set` — e `agent/` non deve mai
 * importare da `cli/` (`agent/comandi.ts`, in testa al file, lo dice del
 * perché `muffin model` è iniettato invece che importato). Un core comune è
 * l'unico posto che entrambe possono raggiungere senza quella dipendenza
 * sbagliata.
 *
 * **Perché questo non passa dal kernel.** ADR-0055 ha reso `reply` e
 * `memory.write` capability del kernel proprio perché sono atti che il *turno*
 * compie da solo, senza un tool — e un turno è già in corso, con un taint da
 * decidere. Un comando `/config` non crea mai un turno: i connector lo
 * intercettano **prima** di interrogare il modello (`connectors/telegram/
 * connector.ts`, `resolve()`: *"Un comando non crea mai un turno — non chiama
 * il modello, non costa niente"*), esattamente come `/model`, `/think`,
 * `/stop`. Il modello non vede mai questo percorso: non c'è una `CapabilityDecl`
 * da dichiarare perché non c'è una decisione del modello da presidiare. La riga
 * di effetto `config` nella matrice (`core/policy/matrix.ts`) resta riservata
 * alla superficie a capability che ADR-0036 immagina e che questa slice non
 * costruisce — costruirla vorrebbe dire registrare un tool, che è esattamente
 * il passo che l'owner ha chiesto di non fare.
 *
 * **Chi può chiamarla non è compito di questo file.** Ogni porta lo decide
 * prima di arrivare qui: il REPL perché gira sulla macchina dell'owner
 * (`cli/repl.ts` passa sempre `tenant: 'host'`), Telegram perché
 * `tryCommand` rifiuta ogni `principal.kind !== 'owner'` — cioè `identify()`
 * ha già confrontato l'id reale della piattaforma con `ownerUserId` — prima
 * di chiamare `eseguiComando`. Discord non ha nessun livello di comandi
 * (`connectors/discord/connector.ts` non importa mai `agent/comandi.ts`): è
 * un relay di messaggi puro, quindi collegare `/config` lì significherebbe
 * costruire da zero l'intero livello che Telegram ha — lavoro sproporzionato
 * per questa slice, e non lo si fa a metà. Vedi `docs/decisions/0062-*.md`.
 */

export type SetKnobOutcome =
  | {
      readonly ok: true;
      readonly key: string;
      readonly previous: string;
      readonly next: string;
      readonly unchanged?: true;
    }
  | { readonly ok: false; readonly reason: string };

export const SETTABLE_CONFIG_KEYS: readonly string[] = REGISTRY_KEYS;

/** Una riga per chiave, per l'aiuto. */
export function describeSettableKnobs(): string {
  return describeFromRegistry();
}

/**
 * La funzione sola. Legge, valida, scrive, e ritorna un valore — mai una
 * stringa già formattata per un terminale: quella la fa ogni porta, perché
 * Telegram e il terminale non condividono un formato, ma condividono questo
 * verdetto (stessa idea di `DeliveryOutcome`, `core/surface/types.ts`).
 *
 * Da ADR-0114 questa funzione è un adattatore sottile sul registro unico:
 * `plan` + `commit`, con l'attestazione `owner-command` (il comando è già
 * stato digitato dall'owner su una porta autenticata). Nessun `--yes`.
 */
export function setConfigKnob(
  home: string,
  key: string,
  rawValue: string,
  source: ActionSource = 'cli',
): SetKnobOutcome {
  const ctx = { home, source };
  const planned = plan('config.set', { key, value: rawValue }, ctx);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  if (planned.plan.unchanged) {
    return {
      ok: true,
      key,
      previous: planned.plan.before,
      next: planned.plan.after,
      unchanged: true,
    };
  }
  const written = commit(planned.plan, ctx, ownerCommandAuthorization(planned.plan, source));
  if (!written.ok) return { ok: false, reason: written.reason };
  return {
    ok: true,
    key,
    previous: written.plan.before,
    next: written.plan.after,
  };
}

export function formatSetOutcome(outcome: SetKnobOutcome): string {
  if (!outcome.ok) return outcome.reason;
  if (outcome.unchanged) return `${outcome.key} è già ${outcome.next}: config.json non toccata`;
  return `${outcome.key}: ${outcome.previous} → ${outcome.next}`;
}
