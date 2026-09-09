/**
 * Lancia `run.ts` con la chiave del modello **dell'installazione**, senza che
 * la chiave passi mai da argv o da un file.
 *
 * `run.ts` non legge e non scrive `~/.muffin` per scelta (vedi il suo
 * `--help`): ha bisogno della chiave in una variabile d'ambiente, e l'owner
 * non ha una chiave nell'ambiente — ce l'ha nel backend dei segreti, dietro
 * `provider.apiKeyRef`. Il 04/09 l'e2e Telegram ha risolto la stessa cosa
 * nello stesso modo (`evals/e2e/telegram.ts`): si legge il segreto qui, si
 * mette **nell'ambiente del figlio** e basta. Mai in argv (comparirebbe in
 * `ps`), mai su disco, mai stampato.
 *
 * I modelli sono quelli **dell'installazione** (`models.main`, `models.light`)
 * e il giudice e' `models.main`: la domanda di A2/A3 e' «sui modelli DAY-1»,
 * non su un modello a scelta. Lo stesso modello che giudica se stesso e' una
 * debolezza nota e viene scritta nell'evidenza, non nascosta.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, muffinHome, readSecret } from '../../core/config/config.js';

const home = muffinHome();
const cfg = loadConfig(home);
const ref = cfg.provider.apiKeyRef;
if (ref === undefined || ref === '') {
  process.stderr.write('nessun provider.apiKeyRef nella config: niente da lanciare\n');
  process.exit(78);
}
const chiave = readSecret(ref, home);
if (chiave === undefined || chiave === '') {
  process.stderr.write(`il segreto ${ref} e' vuoto o assente\n`);
  process.exit(78);
}

const qui = dirname(fileURLToPath(import.meta.url));
const argv = [
  join(qui, 'run.ts'),
  '--provider',
  cfg.provider.kind,
  ...(cfg.provider.baseUrl ? ['--base-url', cfg.provider.baseUrl] : []),
  '--models',
  [cfg.models.main, cfg.models.light].join(','),
  '--judge-model',
  cfg.models.main,
  '--api-key-env',
  'MUFFIN_CHARACTER_KEY',
  ...process.argv.slice(2),
];

const figlio = spawn('npx', ['tsx', ...argv], {
  stdio: 'inherit',
  env: { ...process.env, MUFFIN_CHARACTER_KEY: chiave },
});
figlio.on('exit', (code) => process.exit(code ?? 1));
