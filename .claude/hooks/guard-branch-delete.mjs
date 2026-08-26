#!/usr/bin/env node
/**
 * PreToolUse hook: un branch remoto che regge una PR aperta non si cancella.
 *
 * Il guasto è successo due volte, con due comandi diversi e lo stesso danno.
 * La prima: `gh pr close 83 --delete-branch` ha cancellato il branch che era
 * la **base** della PR impilata #84, chiudendola a cascata — e poi reopen e
 * cambio-base si bloccano a vicenda, perché GitHub non riapre una PR il cui
 * base non esiste e non cambia base a una PR chiusa. La seconda, il
 * 26/08/2026: `git push origin --delete slice/readme-open-source-v1` scritto
 * **in catena** dopo un `gh pr merge` che era fallito (la PR era draft) — il
 * merge non è avvenuto, il delete è partito comunque, e la PR #84 aperta si è
 * chiusa. Il recupero è stato push dello SHA noto, reopen, ready, merge:
 * possibile solo perché lo SHA era ancora nel transcript.
 *
 * La lezione era già in memoria dopo la prima volta. La seconda è successa lo
 * stesso, che è la prova solita: una nota si legge prima o dopo, mai
 * nell'attimo in cui si scrive il comando. Un hook parla in quell'attimo.
 *
 * ## Cosa rifiuta, e cosa no
 *
 * Le tre forme che cancellano un branch remoto — `git push <remote> --delete
 * <branch>`, `git push <remote> :<branch>`, `gh pr close … --delete-branch` —
 * ma **solo** quando il branch è la testa o la base di una PR ancora aperta:
 * è quello lo stato in cui la cancellazione chiude qualcosa a cascata. Un
 * branch senza PR aperte passa senza una parola; la verifica è `gh pr list
 * --state open` sul momento, non una regola sul testo del comando.
 *
 * Se `gh` non risponde entro ~3s (assente, senza rete, rate-limited), il
 * comando **passa con un warning**: un guard che blocca il lavoro offline
 * insegna solo a disattivarlo.
 *
 * ## Perché il messaggio insegna invece di limitarsi a rifiutare
 *
 * Chi sta cancellando un branch di solito ha appena mergiato — o crede di
 * averlo fatto. La forma che non può sbagliare è atomica:
 * `gh pr merge N --merge --delete-branch` cancella solo se il merge riesce, e
 * su una base impilata GitHub ritarga da solo le PR figlie. E il gate prima
 * del merge legge `isDraft` e `mergeable`, non solo i check — è esattamente
 * il pezzo mancato il 26/08.
 *
 * L'override è una variabile d'ambiente e non un flag, come negli altri
 * guard: non può capitare per riflesso, e nel transcript si vede come una
 * scelta.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}

if (/\bMUFFIN_BRANCH_DELETE_OK=1\b/.test(command) || process.env['MUFFIN_BRANCH_DELETE_OK'] === '1')
  process.exit(0);

/**
 * Il testo fra virgolette è dato, non sintassi — stessa ragione degli altri
 * guard: in un repository i cui messaggi di commit raccontano pratica git,
 * `git commit -m "mai git push origin --delete x"` non deve armare (né
 * disarmare) il guard che quella frase descrive.
 */
const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** Ogni sotto-comando, separato da `;`, `&&`, `||` o pipe: la catena è la forma in cui è successo davvero. */
const segmenti = bare.split(/;|&&|\|\||\|/);

const opaco = (tok) => tok === "''" || tok === '""';
const nomeBranch = (tok) => tok.replace(/^\+/, '').replace(/^:/, '').replace(/^refs\/heads\//, '');

/** Branch che il comando cancellerebbe, dalle due forme `git push`. */
const daCancellare = [];
/** Selettori di `gh pr close … --delete-branch` (numero, URL, branch o vuoto = branch corrente), con eventuale `--repo`. */
const chiusure = [];
let opachi = false;

for (const seg of segmenti) {
  const push = /\bgit(?:\s+-\S+(?:\s+\S+)?)*\s+push\b(.*)$/.exec(seg);
  if (push) {
    const tok = (push[1] ?? '').trim().split(/\s+/).filter((t) => t !== '');
    // Flag di push che consumano il token successivo: senza questa lista
    // `git push -o ci.skip origin :x` scambierebbe il valore per il remote.
    const conValore = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
    let cancella = false;
    let prova = false;
    const posizionali = [];
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (t.startsWith('-') && t !== '-') {
        if (t === '--delete' || t === '-d') cancella = true;
        else if (t === '--dry-run' || t === '-n') prova = true;
        else if (conValore.has(t)) i++;
        continue;
      }
      posizionali.push(t);
    }
    if (prova) continue; // un dry-run non cancella niente
    if (cancella) {
      // `git push origin --delete b` → [origin, b]; `git push -d b` usa il
      // remote di default, quindi con un solo posizionale quello È il branch.
      const rami = posizionali.length > 1 ? posizionali.slice(1) : posizionali;
      for (const r of rami) (opaco(r) ? (opachi = true) : daCancellare.push(nomeBranch(r)));
    } else {
      // Il refspec a sorgente vuota è la forma storica dello stesso delete.
      // Si cerca fra tutti i posizionali: il remote può mancare, e un nome di
      // remote non comincia mai per `:`.
      for (const r of posizionali) {
        if (!/^\+?:/.test(r)) continue;
        const nome = nomeBranch(r);
        if (nome !== '') (opaco(nome) ? (opachi = true) : daCancellare.push(nome));
      }
    }
    continue;
  }

  const close = /\bgh\s+pr\s+close\b(.*)$/.exec(seg);
  if (close && /(^|\s)(--delete-branch|-d)\b/.test(close[1] ?? '')) {
    const tok = (close[1] ?? '').trim().split(/\s+/).filter((t) => t !== '');
    const conValore = new Set(['-c', '--comment', '-R', '--repo']);
    let selettore = '';
    const repo = [];
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (t.startsWith('-')) {
        if ((t === '-R' || t === '--repo') && i + 1 < tok.length) repo.push('--repo', tok[i + 1]);
        if (conValore.has(t)) i++;
        continue;
      }
      if (opaco(t)) continue;
      if (selettore === '') selettore = t;
    }
    chiusure.push({ selettore, repo });
  }
}

if (daCancellare.length === 0 && chiusure.length === 0) {
  if (opachi)
    process.stderr.write(
      'guard-branch-delete: il branch da cancellare è fra virgolette e non lo posso leggere — verifica tu che non regga una PR aperta.\n',
    );
  process.exit(0);
}

/** `gh` con timeout corto: null se assente, lento o in errore. */
const TIMEOUT_MS = Number(process.env['MUFFIN_GH_TIMEOUT_MS'] ?? 3000);
let ghGiu = false;
function gh(args) {
  try {
    return JSON.parse(
      execFileSync('gh', args, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch {
    ghGiu = true;
    return null;
  }
}

const motivi = [];

for (const branch of [...new Set(daCancellare)]) {
  const teste = gh(['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,title']);
  for (const pr of teste ?? []) motivi.push(`  ${branch} — testa della PR aperta #${pr.number} (${pr.title})`);
  const basi = gh(['pr', 'list', '--state', 'open', '--base', branch, '--json', 'number,title']);
  for (const pr of basi ?? []) motivi.push(`  ${branch} — base della PR aperta #${pr.number} (${pr.title})`);
}

for (const { selettore, repo } of chiusure) {
  // Il branch cancellato da `gh pr close -d` è la testa della PR chiusa: la
  // chiusura è voluta, il danno è alle ALTRE PR aperte che poggiano lì sopra.
  const vista = gh(['pr', 'view', ...(selettore === '' ? [] : [selettore]), ...repo, '--json', 'number,headRefName']);
  if (!vista?.headRefName) continue;
  const basi = gh(['pr', 'list', '--state', 'open', '--base', vista.headRefName, ...repo, '--json', 'number,title']);
  for (const pr of basi ?? [])
    motivi.push(`  ${vista.headRefName} (testa della PR ${selettore || 'corrente'}) — base della PR aperta #${pr.number} (${pr.title})`);
  const teste = gh(['pr', 'list', '--state', 'open', '--head', vista.headRefName, ...repo, '--json', 'number,title']);
  for (const pr of (teste ?? []).filter((p) => p.number !== vista.number))
    motivi.push(`  ${vista.headRefName} — testa anche della PR aperta #${pr.number} (${pr.title})`);
}

if (motivi.length === 0) {
  if (ghGiu)
    process.stderr.write(
      'guard-branch-delete: `gh` non risponde (assente, offline o oltre il timeout) — non posso verificare le PR aperte, il comando passa. Prima di cancellare un branch remoto controlla a mano: gh pr list --state open --head <branch> (e --base).\n',
    );
  process.exit(0);
}

process.stderr.write(
  `questo comando cancella un branch remoto che regge una PR aperta:\n` +
    [...new Set(motivi)].join('\n') +
    `\n\n` +
    `Cancellare la testa di una PR aperta la chiude; cancellare la base di una\n` +
    `PR impilata la chiude a cascata — e poi reopen e cambio-base si bloccano a\n` +
    `vicenda. Successo due volte: #83→#84, e il 26/08 con un delete in catena\n` +
    `dopo un \`gh pr merge\` fallito perché la PR era ancora draft.\n\n` +
    `La forma atomica cancella solo se il merge riesce (e su una base impilata\n` +
    `GitHub ritarga da solo le PR figlie):\n` +
    `  gh pr merge <N> --merge --delete-branch\n\n` +
    `E il gate prima del merge legge lo stato della PR, non solo i check:\n` +
    `  gh pr view <N> --json isDraft,mergeable,statusCheckRollup\n` +
    `  # isDraft: false e mergeable: MERGEABLE — poi il merge, mai in catena cieca\n\n` +
    `Se è voluto: MUFFIN_BRANCH_DELETE_OK=1 <comando>\n`,
);
process.exit(2);
