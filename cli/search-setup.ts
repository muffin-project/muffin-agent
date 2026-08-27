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
 * Quando stdin non ha niente, il comando non chiede — **stampa la pipe esatta**,
 * che è la stessa cosa in una riga sola invece che in un dialogo che poi
 * qualcuno incolla al posto sbagliato.
 *
 * Il motore si sceglie dal catalogo (`core/config/providers.ts`): Tavily è una
 * voce, non un letterale, ed è tutto ciò che serviva perché non fosse più
 * cablato — l'interfaccia `SearchBackend` a valle esisteva già.
 */

export type SearchDeps = {
  out: (line: string) => void;
  /** La chiave, se qualcuno l'ha messa in pipe. Iniettabile: un test non ha uno stdin. */
  readKey?: () => string;
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

export function cmdSearch(home: string, argv: string[], deps: SearchDeps): number {
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

  const chiave = (deps.readKey?.() ?? '').trim();
  if (chiave === '') {
    // Non un prompt: la riga esatta da eseguire. Chi non ha ancora la chiave sa
    // anche dove prenderla, senza cercarla.
    out(`serve la chiave di ${entry.label} — prendila da ${entry.keysUrl}, poi:`);
    out(`  echo -n "LA_CHIAVE" | muffin search ${entry.id}`);
    return 78;
  }

  const at = writeSecret(entry.secretName, chiave, home, 'home');
  const config = loadConfig(home);
  saveConfig({ ...config, search: { provider: entry.id, apiKeyRef: `secret://${entry.secretName}` } }, home);
  out(`ricerca web: ${entry.label} · chiave (${chiave.length} caratteri, 0600) → ${at}`);
  out('Vale dal prossimo avvio: il tool `web_search` si registra al boot del runtime.');
  return 0;
}
