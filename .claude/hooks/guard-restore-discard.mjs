#!/usr/bin/env node
/**
 * PreToolUse hook: un ripristino non butta via lavoro non committato.
 *
 * Il guasto è successo due volte, a distanza di una sessione, allo stesso
 * modo. Durante un mutation test — muta la cucitura portante, guarda quale
 * prova diventa rossa, ripristina — il ripristino è stato scritto
 * `git checkout -- <file>`. Ma quel comando non riporta il file a "com'era un
 * minuto fa": lo riporta all'indice, o a HEAD. E in un mutation test le
 * riparazioni sono quasi sempre **non committate**, perché il commit arriva
 * dopo che la prova è finita. Così il ripristino ha cancellato le riparazioni
 * e ha lasciato al loro posto la versione col difetto — che poi passa i test
 * *sbagliati*, o li fallisce per la ragione sbagliata, e in entrambi i casi la
 * conclusione che se ne trae è falsa.
 *
 * La prima volta è costata mezz'ora e una riparazione riscritta. La seconda è
 * successa **dopo** che il difetto era stato annotato in memoria, il che è la
 * prova che una nota non basta: la nota si legge prima o dopo, mai nell'attimo
 * in cui si scrive il comando. Un hook parla esattamente in quell'attimo.
 *
 * ## Cosa rifiuta, e cosa no
 *
 * Solo la forma che **scarta modifiche presenti nel working tree**:
 * `git checkout -- <path>` e `git restore <path>` su un file che ha modifiche
 * non committate. Se il file non ha modifiche, il comando non distrugge
 * niente e passa senza dire una parola.
 *
 * Passano sempre, perché nominano una sorgente deliberata invece di
 * "qualunque cosa ci fosse prima": `git checkout <ref> -- <path>`,
 * `git restore --source=<ref>`, `git restore --staged` (che tocca l'indice,
 * non il file). È così che si recupera da questo stesso errore — ed è quello
 * che ho usato per recuperare, la seconda volta.
 *
 * ## Perché il messaggio insegna invece di limitarsi a rifiutare
 *
 * Chi sta facendo un mutation test ha bisogno di *un modo*, non di un divieto.
 * Il messaggio nomina quello giusto — copiare il file prima di mutarlo e
 * ripristinarlo con `cp`, che non passa da git e quindi non può leggere
 * l'indice per sbaglio — perché il momento in cui serve quella conoscenza è
 * esattamente questo, e nessun documento la consegnerà mai altrettanto in
 * tempo. Vale per me, per i judge, e per qualunque agente lavori qui.
 *
 * L'override è una variabile d'ambiente e non un flag, per la stessa ragione
 * degli altri guard: non può capitare per riflesso, e si vede nel transcript
 * come qualcosa che qualcuno ha scelto.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}

if (/\bMUFFIN_DISCARD_OK=1\b/.test(command) || process.env['MUFFIN_DISCARD_OK'] === '1') process.exit(0);

/**
 * Il testo fra virgolette è dato, non sintassi — stessa ragione per cui
 * `guard-review-branch.mjs` lo rimuove: in un repository i cui messaggi di
 * commit parlano di pratica git, `git commit -m "mai usare git checkout --"`
 * non deve disarmare il guard che quella frase descrive.
 */
const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** Ogni sotto-comando, separato da `;`, `&&`, `||` o pipe: una catena ne può contenere uno solo. */
const segmenti = bare.split(/;|&&|\|\||\|/);

const percorsi = [];
for (const seg of segmenti) {
  const m = /\bgit(?:\s+-\S+(?:\s+\S+)?)*\s+(checkout|restore)\b(.*)$/.exec(seg);
  if (!m) continue;
  const resto = (m[2] ?? '').trim();

  // `--source=<ref>` e `--staged` nominano deliberatamente cosa ripristinare,
  // o toccano l'indice invece del file: nessuno dei due può sorprendere.
  if (/--source(=|\s)|--staged\b|-S\b|--worktree\s+--staged/.test(resto)) continue;

  const dopoSeparatore = resto.includes('--') ? resto.slice(resto.indexOf('--') + 2) : resto;
  // `git checkout <ref> -- <path>`: c'è una revisione prima del `--`, quindi la
  // sorgente è dichiarata. È anche il comando con cui si recupera da questo
  // errore, e rifiutarlo sarebbe crudele.
  const primaDelSeparatore = resto.includes('--') ? resto.slice(0, resto.indexOf('--')).trim() : '';
  if (m[1] === 'checkout' && primaDelSeparatore !== '' && !primaDelSeparatore.startsWith('-')) continue;

  for (const tok of dopoSeparatore.split(/\s+/)) {
    if (tok === '' || tok.startsWith('-')) continue;
    percorsi.push(tok);
  }
}

if (percorsi.length === 0) process.exit(0);

/** Quali di quei percorsi hanno davvero modifiche da perdere. */
let aRischio = [];
try {
  const out = execFileSync('git', ['diff', '--name-only', '--', ...percorsi], { encoding: 'utf8' });
  aRischio = out.split('\n').filter((l) => l.trim() !== '');
} catch {
  process.exit(0); // non un repo, o percorsi che git non riconosce: non è la giornata di questo hook
}

if (aRischio.length === 0) process.exit(0);

process.stderr.write(
  `questo ripristino butterebbe via modifiche non committate:\n` +
    aRischio.map((f) => `  ${f}`).join('\n') +
    `\n\n` +
    `\`git checkout --\` e \`git restore\` riportano il file all'INDICE o a HEAD,\n` +
    `non a "com'era un minuto fa". In un mutation test le riparazioni sono quasi\n` +
    `sempre non committate, quindi il ripristino cancella proprio quelle e rimette\n` +
    `la versione col difetto — che poi supera i test sbagliati.\n\n` +
    `Per un mutation test, la forma che non può sbagliare:\n` +
    `  cp <file> /tmp/base            # prima di mutare\n` +
    `  ...muta, esegui i test...\n` +
    `  cp /tmp/base <file>            # ripristina senza passare da git\n\n` +
    `Oppure committa le riparazioni prima di mutare, così l'indice È la base.\n` +
    `Per recuperare da un ripristino già andato male: git checkout stash@{0} -- <file>\n` +
    `Se è voluto: MUFFIN_DISCARD_OK=1 <comando>\n`,
);
process.exit(2);
