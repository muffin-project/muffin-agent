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
 * `git checkout -- <path>`, `git restore <path>` e `git reset --hard` su un
 * albero che ha modifiche non committate. Se non c'è niente da perdere, il
 * comando non distrugge niente e passa senza dire una parola.
 *
 * `git reset --hard` è arrivato qui il 07/09/2026, dopo che il guasto è
 * successo una terza volta e in una forma che le prime due non coprivano.
 * Non durante un mutation test: a fetta **integrata**, riallineando il
 * worktree a `origin/dev` con `git reset --hard origin/dev`. Nel working tree
 * c'era una riga non committata di `.claude/deleghe/registro.jsonl` — la
 * chiusura della delega del giudice, scritta dieci minuti prima — e il reset
 * l'ha cancellata in silenzio: `riprendi` è tornato a offrire una delega che
 * era stata conclusa. Costo basso, ma la classe è la stessa delle prime due,
 * e `reset --hard` è **peggiore** di `checkout --`: non nomina un percorso,
 * quindi prende tutto ciò che nessuno ha ancora committato, e chi lo scrive
 * sta pensando a dove va HEAD, non a cosa c'è nel working tree.
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
 *
 * **E il corpo di un heredoc è dato quanto una stringa fra virgolette.**
 * Trovato nell'ora stessa in cui il ramo `reset` è stato scritto: scrivere la
 * *documentazione* di questo guard — un `cat > memoria.md <<'EOF'` il cui
 * testo spiega perché quel comando è pericoloso — lo faceva scattare su sé
 * stesso, e nessun file veniva toccato da git. La simmetria è la regola:
 * nominare il comando in prosa non deve né disarmare il guard né armarlo.
 */
const bare = command
  // Prima gli heredoc, che possono contenere virgolette spaiate: `<<EOF`,
  // `<<-EOF`, `<<'EOF'`, `<<"EOF"`, fino a una riga che è solo il marcatore.
  .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, '<<HEREDOC')
  .replace(/'[^']*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** Ogni sotto-comando, separato da `;`, `&&`, `||` o pipe: una catena ne può contenere uno solo. */
const segmenti = bare.split(/;|&&|\|\||\|/);

/**
 * `git reset --hard` (con o senza una ref): non nomina percorsi, quindi
 * riguarda **tutto** il working tree. Trattato a parte perché la domanda che
 * il guard deve farsi cambia — non «questo file ha modifiche» ma «c'è
 * qualcosa da perdere, ovunque».
 *
 * `--soft` e `--mixed` non toccano i file nel working tree e passano.
 */
const resetHard = segmenti.some((seg) => /\bgit(?:\s+-\S+(?:\s+\S+)?)*\s+reset\b[^;&|]*\s--hard\b/.test(seg));

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

if (percorsi.length === 0 && !resetHard) process.exit(0);

/** Cosa si perderebbe davvero: quei percorsi, o — per un `reset --hard` — tutto. */
let aRischio = [];
try {
  // `--hard` scarta anche ciò che è **staged**, quindi il confronto è con HEAD
  // e non con l'indice: `git diff` da solo direbbe «niente da perdere» per un
  // file aggiunto con `git add` e mai committato.
  const args = resetHard
    ? ['diff', '--name-only', 'HEAD']
    : ['diff', '--name-only', 'HEAD', '--', ...percorsi];
  const out = execFileSync('git', args, { encoding: 'utf8' });
  aRischio = out.split('\n').filter((l) => l.trim() !== '');
} catch {
  process.exit(0); // non un repo, o percorsi che git non riconosce: non è la giornata di questo hook
}

if (aRischio.length === 0) process.exit(0);

process.stderr.write(
  `questo ripristino butterebbe via modifiche non committate:\n` +
    aRischio.map((f) => `  ${f}`).join('\n') +
    `\n\n` +
    (resetHard
      ? `\`git reset --hard\` non nomina un percorso: prende TUTTO il working tree,\n` +
        `compreso quello che è stato solo messo in stage. Il 07/09/2026 ha cancellato\n` +
        `così una riga del registro delle deleghe scritta dieci minuti prima, mentre\n` +
        `chi lo scriveva stava pensando a dove andava HEAD.\n\n` +
        `Se serve solo spostare HEAD lasciando i file: \`git reset --mixed <ref>\`.\n` +
        `Se serve un worktree pulito: committa prima, o \`cp\` ciò che vuoi tenere.\n\n`
      : '') +
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
