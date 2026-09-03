import { loadConfig, saveConfig, writeSecret, locateSecret } from '../core/config/config.js';
import { SEARCH_PROVIDERS, SEARCH_PROVIDER_IDS, type SearchProviderId } from '../core/config/providers.js';

/**
 * `muffin search` — accendere la ricerca web senza editare un JSON.
 *
 * Accenderla erano **due passi scollegati** che nessuno mette in fila da solo:
 * aprire `config.json` e scriverci a mano un oggetto `search` con la forma
 * giusta, poi ricordarsi che `apiKeyRef` non è la chiave ma un `secret://`, e
 * scrivere la chiave con `muffin secret set`. Fra i due passi il runtime si
 * degrada — `! web_search spento` — e la ragione non è nel messaggio.
 *
 * **La chiave non passa mai da argv.** Si legge da stdin, come `muffin secret
 * set` fa da sempre e per la stessa ragione scritta lì: una chiave in un
 * argomento di shell è una chiave nella history e in ogni `ps` della macchina.
 *
 * E fino al 03/09/2026 il rimedio stampato quando stdin era vuoto era
 * `echo -n "LA_CHIAVE" | muffin search tavily`, cioè **la chiave sulla riga di
 * comando**: la cosa che la riga sopra dice di non fare, suggerita dal comando
 * che la dice. L'owner ci è passato e l'ha nominato. Da un terminale la chiave
 * si chiede adesso lì, senza eco, con lo stesso `promptSecret` che `muffin
 * init` usa già (`cli/prompt.ts`) — un meccanismo, non un secondo. Da uno
 * script resta la pipe, e la riga stampata è una redirezione da file: nessuna
 * delle due forme lascia il segreto nella history o in un `ps`.
 *
 * Il motore si sceglie dal catalogo (`core/config/providers.ts`): Tavily è una
 * voce, non un letterale, ed è tutto ciò che serviva perché non fosse più
 * cablato — l'interfaccia `SearchBackend` a valle esisteva già.
 */

export type SearchDeps = {
  out: (line: string) => void;
  /** La chiave, se qualcuno l'ha messa in pipe. Iniettabile: un test non ha uno stdin. */
  readKey?: () => string;
  /**
   * Chiede la chiave al terminale, senza eco. Assente = non c'è un terminale a
   * cui chiederla (uno script, la CI, un test), ed è l'unico caso in cui il
   * comando stampa un rimedio invece di risolvere la cosa da sé.
   */
  chiediChiave?: () => Promise<string | undefined>;
};

function stato(home: string, out: (l: string) => void): number {
  const config = loadConfig(home);
  if (config.search === undefined) {
    out('ricerca web: spenta.');
    out(`motori disponibili: ${SEARCH_PROVIDER_IDS.join(', ')}`);
    out('accendila con `muffin search <motore>` (la chiave in pipe).');
    return 0;
  }
  const entry = SEARCH_PROVIDERS[config.search.provider];
  const dove = locateSecret(config.search.apiKeyRef, home);
  out(`ricerca web: ${entry.label} · chiave ${config.search.apiKeyRef}`);
  // Una `apiKeyRef` che punta a un segreto che non c'e' e' esattamente lo stato
  // in cui il runtime si degrada in silenzio con un `! web_search spento` che
  // non dice perche'. Dirlo qui, dove si sta guardando la ricerca.
  out(
    dove === null
      ? `⚠ quel segreto non esiste: la ricerca è configurata e spenta. Riscrivi la chiave con \`muffin search ${entry.id}\`.`
      : `chiave trovata in ${dove.path}`,
  );
  return 0;
}

export async function cmdSearch(home: string, argv: string[], deps: SearchDeps): Promise<number> {
  const { out } = deps;
  const [primo] = argv;

  if (primo === undefined) return stato(home, out);

  if (primo === 'off') {
    const config = loadConfig(home);
    if (config.search === undefined) {
      out('era già spenta.');
      return 0;
    }
    const { search: _tolta, ...senza } = config;
    saveConfig(senza, home);
    // Il segreto resta dov'e': spegnere la ricerca non e' ruotare una chiave, e
    // cancellarne una per un effetto collaterale e' il tipo di cosa che si
    // scopre il giorno che serviva.
    out(`ricerca web spenta. La chiave resta dov'era: \`muffin secret\` per gestirla.`);
    return 0;
  }

  if (!(SEARCH_PROVIDER_IDS as readonly string[]).includes(primo)) {
    out(`«${primo}» non è un motore conosciuto. Disponibili: ${SEARCH_PROVIDER_IDS.join(', ')}, oppure \`off\`.`);
    return 2;
  }
  const entry = SEARCH_PROVIDERS[primo as SearchProviderId];

  // La pipe per prima: uno script che la usa non deve trovarsi una domanda.
  let chiave = (deps.readKey?.() ?? '').trim();
  if (chiave === '') {
    // Poi il terminale, che è il caso dell'owner. Senza eco, e il valore non
    // passa mai da una riga di comando: né history, né `ps`.
    out(`serve la chiave di ${entry.label} — prendila da ${entry.keysUrl}.`);
    if (deps.chiediChiave !== undefined) {
      /**
       * L'invito sta qui, in una riga già stampata, e non dentro il prompt.
       *
       * `promptSecret` scrive la domanda e poi lascia parlare readline, che per
       * disegnare la riga fa `cursorTo(0)` + `clearScreenDown` **fuori** dal
       * `_writeToOutput` che quella funzione intercetta: la domanda viene
       * cancellata un istante dopo essere comparsa. Misurato in `tmux
       * capture-pane` il 03/09/2026 — sotto la riga qui sopra restava una riga
       * vuota, e un terminale che aspetta senza dirlo sembra piantato.
       */
      out(`Incollala qui: non si vede mentre la scrivi, e invio a vuoto lascia tutto com'è.`);
      chiave = ((await deps.chiediChiave()) ?? '').trim();
    }
  }
  if (chiave === '') {
    // Rimasti senza: qui non c'è un terminale (o l'owner ha premuto invio). Il
    // rimedio stampato **non** mette il segreto sulla riga di comando — era
    // esattamente il difetto: una redirezione da file, o una pipe da un
    // programma che la tira fuori lui.
    out(`niente chiave, niente ricerca. Da uno script, senza lasciarla nella history:`);
    out(`  muffin search ${entry.id} < il-file-con-la-chiave`);
    out(`  pass show tavily | muffin search ${entry.id}`);
    return 78;
  }

  const at = writeSecret(entry.secretName, chiave, home, 'home');
  const config = loadConfig(home);
  saveConfig({ ...config, search: { provider: entry.id, apiKeyRef: `secret://${entry.secretName}` } }, home);
  out(`ricerca web: ${entry.label} · chiave (${chiave.length} caratteri, 0600) → ${at}`);
  out('Vale dal prossimo avvio: il tool `web_search` si registra al boot del runtime.');
  return 0;
}
