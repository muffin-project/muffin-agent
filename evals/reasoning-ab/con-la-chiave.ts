/**
 * Lancia `run.ts` con la chiave dell'installazione, senza che passi mai da
 * argv o da un file: letta qui, messa nell'ambiente del figlio e basta.
 * Stesso patto di `evals/character/con-la-chiave.ts`.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, muffinHome, readSecret } from '../../core/config/config.js';

const home = muffinHome();
const cfg = loadConfig(home);
const chiave = readSecret(cfg.provider.apiKeyRef, home);
if (!chiave) {
  process.stderr.write('chiave provider vuota o assente\n');
  process.exit(78);
}

const qui = dirname(fileURLToPath(import.meta.url));
const figlio = spawn('npx', [join('tsx'), join(qui, 'run.ts'), ...process.argv.slice(2)], {
  cwd: join(qui, '..', '..'),
  stdio: 'inherit',
  env: { ...process.env, MUFFIN_AB_KEY: chiave },
});
figlio.on('exit', (code) => process.exit(code ?? 1));
