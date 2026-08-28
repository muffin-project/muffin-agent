import { loadConfig, saveConfig, type Config } from '../core/config/config.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';

/**
 * I comandi che una persona può dare a Muffin, in un posto solo.
 *
 * Vivevano dentro il ciclo del REPL, intrecciati con le sue variabili locali,
 * quindi non erano richiamabili da nessun'altra parte. Il 28/08/2026 l'owner
 * ha acceso Telegram e la conseguenza si è vista subito: `/new`, `/session`,
 * `/spend`, `/think`, `/model` e `/debug` esistevano solo nel terminale, e dal
 * telefono non c'era modo di sapere quanto si stava spendendo né di ricominciare
 * una conversazione. La sua richiesta è stata «tutti i / commands che abbiamo
 * nella CLI dobbiamo riportarli su telegram, SEMPRE».
 *
 * **Il modo di mantenere quel "sempre" non è copiarli.** Due elenchi divergono,
 * e il primo a divergere è quello che nessuno legge: un comando aggiunto di là
 * e non di qua semplicemente non esisterebbe, in silenzio. Questo modulo è la
 * cosa che si aggiunge, e le due superfici la leggono.
 *
 * **Cosa resta della superficie.** Un comando qui dentro dice *cosa è successo*
 * e *cosa dire*; non tocca lo stato di chi lo ha chiamato. `/new` non apre una
 * sessione — dichiara che quella di prima è chiusa, e il terminale apre un id
 * nuovo mentre Telegram, che l'id lo deriva dalla chat, archivia il file. Stesso
 * significato per chi legge, meccanismo diverso dove deve esserlo.
 */

export type Verbosity = 'normale' | 'debug';

export type EsitoComando = {
  /** Cosa dire a chi ha chiesto. Sempre presente: un comando muto è un comando rotto. */
  testo: string;
  /** `/new`: la conversazione di prima è chiusa. Ogni superficie sa come farlo sul serio. */
  nuovaSessione?: boolean;
  /** `/debug`: il livello di dettaglio è cambiato. */
  verbosity?: Verbosity;
  /** `/exit`: solo dove esiste un processo da chiudere. */
  esci?: boolean;
  /** Nessun comando con questo nome. La superficie decide se mostrare l'aiuto. */
  sconosciuto?: boolean;
};

export type ContestoComandi = {
  home: string;
  /** Letta e riscritta: `/model` e `/think` la cambiano davvero. */
  config: Config;
  /** Riletta dopo una scrittura, così il chiamante vede cosa è cambiato. */
  onConfig?: (next: Config) => void;
  profilo: { name: string; thinking: 'adaptive' | 'off' | 'unset' };
  onThinking?: (t: 'adaptive' | 'off' | 'unset') => void;
  budget: { status: () => { monthUsd: number; monthlyCapUsd: number; exhausted: boolean }; tenantTodayUsd: (t: string) => number };
  sessionId: string;
  verbosity: Verbosity;
  /**
   * Dove esiste un processo da chiudere. Il terminale sì; Telegram no, e
   * `/exit` lì non viene nemmeno elencato — un comando che non fa niente è
   * peggio di un comando che manca.
   */
  puoiUscire: boolean;
  /**
   * `muffin model`, iniettato invece che importato.
   *
   * Vive in `cli/model.ts` perché è anche un comando della CLI, e un modulo di
   * `agent/` che importa da `cli/` è la stessa direzione sbagliata che questo
   * file esiste per non prendere: sarebbe un connettore che ha bisogno del
   * terminale per cambiare modello. La superficie lo passa; qui si sa solo che
   * qualcuno scrive righe.
   */
  model: (argv: string[], out: (riga: string) => void) => Promise<unknown>;
};

/** Una riga per comando: nome, e cosa fa. L'aiuto e l'elenco per il menu di Telegram nascono da qui. */
export const COMANDI: readonly { nome: string; aiuto: string; soloTerminale?: boolean }[] = [
  { nome: 'new', aiuto: 'inizia una conversazione nuova' },
  { nome: 'session', aiuto: 'mostra l\'id della conversazione' },
  { nome: 'spend', aiuto: 'quanto hai speso questo mese e oggi' },
  { nome: 'think', aiuto: 'ragionamento: on | off | reset (senza argomenti lo mostra)' },
  { nome: 'model', aiuto: 'modello: [main|light|embed] <slug>, --list, o niente per vederli' },
  { nome: 'debug', aiuto: 'giri, token e millisecondi: on | off (da solo, inverte)' },
  { nome: 'help', aiuto: 'questo elenco' },
  { nome: 'exit', aiuto: 'esci (o Ctrl+D)', soloTerminale: true },
];

/** L'aiuto, generato — mai un secondo elenco scritto a mano accanto al primo. */
export function aiuto(puoiUscire: boolean): string {
  const usabili = COMANDI.filter((c) => puoiUscire || c.soloTerminale !== true);
  const largo = Math.max(...usabili.map((c) => c.nome.length));
  return usabili.map((c) => `/${c.nome.padEnd(largo)} ${c.aiuto}`).join('\n');
}

/** Il testo è un comando? Il `/` da solo non basta: `/` seguito da niente è testo. */
export function sembraComando(testo: string): boolean {
  return /^\/[a-z]+/i.test(testo.trim());
}

export async function eseguiComando(riga: string, ctx: ContestoComandi): Promise<EsitoComando> {
  const testo = riga.trim();
  const nome = /^\/([a-z]+)/i.exec(testo)?.[1]?.toLowerCase() ?? '';
  const arg = testo.slice(nome.length + 1).trim();

  switch (nome) {
    case 'exit':
      // Su una superficie senza processo da chiudere non è un comando muto: è
      // uno sconosciuto, e viene trattato come tale.
      return ctx.puoiUscire ? { testo: '', esci: true } : { testo: '', sconosciuto: true };

    case 'help':
      return { testo: aiuto(ctx.puoiUscire) };

    case 'new':
      return { testo: 'conversazione nuova: quella di prima non la ricordo più.', nuovaSessione: true };

    case 'session':
      return { testo: ctx.sessionId };

    case 'spend': {
      const s = ctx.budget.status();
      const oggi = ctx.budget.tenantTodayUsd('host');
      return {
        testo:
          `$${s.monthUsd.toFixed(4)} / $${String(s.monthlyCapUsd)} questo mese${s.exhausted ? ' — esaurito' : ''}\n` +
          `oggi: $${oggi.toFixed(4)}`,
      };
    }

    case 'debug': {
      const out = debugCommand(arg, ctx.verbosity);
      return { testo: out.line, ...(out.set === undefined ? {} : { verbosity: out.set }) };
    }

    case 'think': {
      const out = thinkingCommand(arg, ctx.profilo.thinking, ctx.config.thinking, ctx.profilo.name);
      if (out.set !== undefined) {
        const { thinking: _tolto, ...senza } = ctx.config;
        const next = out.set === null ? senza : { ...ctx.config, thinking: out.set };
        saveConfig(next, ctx.home);
        ctx.onConfig?.(next);
        // La corsia principale ha un `Profile` tutto suo (`withThinking` copia
        // sempre), quindi girare la manopola qui non tocca la corsia della
        // memoria — che il ragionamento se lo spegne da sé comunque.
        ctx.onThinking?.(out.set ?? selectProfile(next.models.main, loadProfiles()).thinking);
      }
      return { testo: out.line };
    }

    case 'model': {
      const righe: string[] = [];
      await ctx.model(arg === '' ? [] : arg.split(/\s+/), (l) => righe.push(l));
      ctx.onConfig?.(loadConfig(ctx.home));
      return { testo: `${righe.join('\n')}\n(il modello nuovo vale dal prossimo avvio)`.trim() };
    }

    default:
      return { testo: '', sconosciuto: true };
  }
}

export function debugCommand(arg: string, current: Verbosity): { line: string; set?: Verbosity } {
  const dillo = (v: Verbosity): string =>
    v === 'debug' ? 'debug: on — giro, token, millisecondi, stop reason' : 'debug: off';
  if (arg === '') {
    const next: Verbosity = current === 'debug' ? 'normale' : 'debug';
    return { line: dillo(next), set: next };
  }
  if (arg === 'on') return { line: dillo('debug'), set: 'debug' };
  if (arg === 'off') return { line: dillo('normale'), set: 'normale' };
  return { line: `/debug on | off, oppure /debug da solo per invertirlo — «${arg}» non è nessuno dei due` };
}

export function thinkingCommand(
  arg: string,
  current: 'adaptive' | 'off' | 'unset',
  override: 'adaptive' | 'off' | 'unset' | undefined,
  profileName: string,
): { line: string; set?: 'adaptive' | 'off' | 'unset' | null } {
  const stato = (t: string, da: string): string => `ragionamento: ${t === 'off' ? 'off' : 'on'} (${da})`;
  const da = override === undefined ? `profilo ${profileName}` : 'config.json';
  if (arg === '') return { line: stato(current, da) };
  if (arg === 'on') return { line: `${stato('adaptive', 'config.json')} — vale anche ai prossimi avvii`, set: 'adaptive' };
  if (arg === 'off') return { line: `${stato('off', 'config.json')} — vale anche ai prossimi avvii`, set: 'off' };
  if (arg === 'reset') return { line: `ragionamento: torna a valere il profilo ${profileName}`, set: null };
  return { line: `/think on | off | reset — «${arg}» non è nessuno dei tre` };
}
