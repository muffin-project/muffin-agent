import { ConfigError, ConfigSchema, loadConfig, saveConfig, type Config } from './config.js';

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
  | { readonly ok: true; readonly key: string; readonly previous: string; readonly next: string; readonly unchanged?: true }
  | { readonly ok: false; readonly reason: string };

type Knob = {
  readonly key: string;
  /** Una riga, per l'aiuto e per il messaggio di rifiuto quando la chiave non è questa. */
  readonly describe: string;
  readonly read: (config: Config) => string;
  readonly parse: (raw: string) => { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string };
  /** `null` quando il valore non si può scrivere in questa config così com'è (es. `search` mai configurata). */
  readonly apply: (config: Config, value: number) => Config | null;
  /** Perché `apply` ha risposto `null`, quando può succedere. */
  readonly whenMissing?: string;
};

function parsePositiveInt(raw: string, max?: number): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return { ok: false, reason: `«${raw}» non è un numero intero` };
  }
  const n = Number(trimmed);
  if (n <= 0) return { ok: false, reason: `${n} non è positivo` };
  if (max !== undefined && n > max) return { ok: false, reason: `${n} supera il massimo (${max})` };
  return { ok: true, value: n };
}

/**
 * L'insieme piccolo e motivato, non tutto `config.json`.
 *
 * Escluse per decisione dell'owner, testuale: **`rot.mode`** (postura di
 * sicurezza — hardened/single-user si cambia leggendo `docs/SECURITY.md`, non
 * con una riga digitata di corsa), **i provider** (`provider.*`, incluso
 * `provider.routing` — instradamento e `dataCollection` sono scelte che vanno
 * lette una volta, non girate come un termostato) e **i segreti**
 * (`provider.apiKeyRef`, `search.apiKeyRef`, `embedder.apiKeyRef`: quelli
 * restano `muffin secret set`, da stdin, mai da un valore che finisce in un
 * argomento di comando o in una traccia).
 *
 * Escluso anche tutto ciò che ha **già** una funzione dedicata — aggiungerne
 * una seconda qui sarebbe esattamente la divergenza che la casa vieta (`models.*`
 * → `muffin model`/`/model`; `thinking` → `/think`; `surfaces.default` →
 * `muffin surface default`; `prompt.version` → `muffin prompt version`).
 * Questo elenco esiste per le manopole che oggi **non hanno nessuna porta**.
 */
const KNOBS: readonly Knob[] = [
  {
    key: 'traces.retentionDays',
    describe: 'quanti giorni tenere le tracce dei turni prima che vengano ripulite (intero positivo)',
    read: (c) => String(c.traces.retentionDays),
    parse: (raw) => parsePositiveInt(raw),
    apply: (c, value) => ({ ...c, traces: { retentionDays: value } }),
  },
  {
    key: 'search.maxResults',
    describe: 'quanti risultati chiedere a ogni ricerca web, da 1 a 20 (tocca solo il numero: motore e chiave restano dove sono)',
    read: (c) => (c.search ? String(c.search.maxResults ?? '(default del motore)') : '(ricerca non configurata)'),
    parse: (raw) => parsePositiveInt(raw, 20),
    apply: (c, value) => (c.search ? { ...c, search: { ...c.search, maxResults: value } } : null),
    whenMissing:
      'la ricerca web non è configurata su questa installazione — provider e chiave si impostano a mano in config.json, ' +
      'questo comando cambia solo il numero di risultati quando la ricerca esiste già',
  },
];

/** Le chiavi che questo meccanismo sa scrivere, nell'ordine in cui `--help`/`/config` le mostrano. */
export const SETTABLE_CONFIG_KEYS: readonly string[] = KNOBS.map((k) => k.key);

/** Una riga per chiave, per l'aiuto. */
export function describeSettableKnobs(): string {
  return KNOBS.map((k) => `  ${k.key.padEnd(20)} ${k.describe}`).join('\n');
}

/**
 * La funzione sola. Legge, valida, scrive, e ritorna un valore — mai una
 * stringa già formattata per un terminale: quella la fa ogni porta, perché
 * Telegram e il terminale non condividono un formato, ma condividono questo
 * verdetto (stessa idea di `DeliveryOutcome`, `core/surface/types.ts`).
 */
export function setConfigKnob(home: string, key: string, rawValue: string): SetKnobOutcome {
  const knob = KNOBS.find((k) => k.key === key);
  if (!knob) {
    return {
      ok: false,
      reason:
        `«${key}» non è un'impostazione modificabile da qui. Quelle che lo sono:\n${describeSettableKnobs()}\n` +
        `Le altre si leggono con \`muffin config\`; molte hanno un comando dedicato ` +
        `(\`muffin model\`, \`/think\`, \`muffin surface default\`, \`muffin prompt version\`), ` +
        `e provider, segreti e \`rot.mode\` non si toccano da qui di proposito.`,
    };
  }

  let config: Config;
  try {
    config = loadConfig(home);
  } catch (error) {
    return { ok: false, reason: error instanceof ConfigError ? error.message : String(error) };
  }

  const parsed = knob.parse(rawValue);
  if (!parsed.ok) return { ok: false, reason: `${knob.key}: ${parsed.reason}` };

  const previous = knob.read(config);
  const next = knob.apply(config, parsed.value);
  if (next === null) {
    return { ok: false, reason: `${knob.key}: ${knob.whenMissing ?? 'non applicabile su questa config'}` };
  }

  // Belt-and-suspenders: nessun `apply` sopra dovrebbe produrre una config che
  // lo schema rifiuta, ma questa funzione è l'unico cancello fra un comando
  // digitato e `saveConfig` — vale la riga in più per non fidarsi in silenzio.
  const revalidated = ConfigSchema.safeParse(next);
  if (!revalidated.success) {
    return {
      ok: false,
      reason: `scrittura rifiutata: il risultato non è una config valida (${revalidated.error.issues.map((i) => i.message).join('; ')})`,
    };
  }

  const nextValue = knob.read(next);
  if (previous === nextValue) {
    return { ok: true, key: knob.key, previous, next: nextValue, unchanged: true };
  }
  saveConfig(next, home);
  return { ok: true, key: knob.key, previous, next: nextValue };
}

/**
 * Il testo, una volta sola: CLI, REPL e Telegram stampano esattamente questa
 * riga — non una a testa che potrebbe dire cose leggermente diverse per lo
 * stesso verdetto. `cli/config.ts` e `agent/comandi.ts` chiamano questa
 * funzione, mai `String(outcome)` scritto a mano al call site.
 */
export function formatSetOutcome(outcome: SetKnobOutcome): string {
  if (!outcome.ok) return outcome.reason;
  if (outcome.unchanged) return `${outcome.key} è già ${outcome.next}: config.json non toccata`;
  return `${outcome.key}: ${outcome.previous} → ${outcome.next}`;
}
