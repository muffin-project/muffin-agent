#!/usr/bin/env node
/**
 * Il registro delle deleghe, e il recupero di quelle che si fermano a metà.
 *
 * Direttiva owner, 2026-08-15: *«quando usiamo questi subagenti dobbiamo
 * assicurarci che se si fermano a meta abbiamo sempre il transcript, sempre
 * sempre sempre»*. Nasce da una perdita vera: otto agenti sono morti quando il
 * processo della sessione è uscito, e la risposta data allora — «i transcript
 * sono su disco» — era inutile in pratica.
 *
 * Il transcript, infatti, **c'era**: `.../tasks/<id>.output` è un symlink verso
 * `~/.claude/projects/<progetto>/<sessione>/subagents/agent-<id>.jsonl`, che sta
 * nella home e sopravvive. Mancavano le due cose che lo rendono utilizzabile:
 *
 * 1. **Chi stava facendo cosa.** Senza registro restano N file JSONL anonimi.
 * 2. **Un modo di leggerli.** Sono decine di migliaia di righe: aprirne uno in
 *    una conversazione la satura, ed è il motivo per cui non venivano aperti.
 *
 * Quindi: `registra` scrive l'intento **quando la delega parte** (prima che
 * possa morire), e `raccogli` distilla un transcript in un digest leggibile —
 * file toccati, comandi, branch, errori, ultima parola — senza mai versare il
 * transcript intero in un contesto.
 *
 *   node .claude/deleghe.mjs registra <id> <slug> "<cosa deve fare>"
 *   node .claude/deleghe.mjs raccogli [id…]     # default: tutte le registrate
 *   node .claude/deleghe.mjs stato
 *
 * ORCHESTRATION.md §3 (un subagente che dice di aver fatto non è evidenza).
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(CLAUDE, '..');
const DIR = join(CLAUDE, 'deleghe');
const REGISTRO = join(DIR, 'registro.jsonl');

/** La cartella dei transcript: nella home, non in /tmp, quindi durevole. */
function subagentsDirs() {
  const projects = join(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return [];
  const out = [];
  for (const proj of readdirSync(projects)) {
    const p = join(projects, proj);
    if (!statSync(p).isDirectory()) continue;
    for (const sess of readdirSync(p)) {
      const s = join(p, sess, 'subagents');
      if (existsSync(s)) out.push(s);
    }
  }
  return out;
}

/** Il transcript di un agente, ovunque sia la sessione che l'ha lanciato. */
function transcriptOf(id) {
  for (const d of subagentsDirs()) {
    const f = join(d, `agent-${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Il registro, con l'ultima voce di ogni delega che vince.
 *
 * Append-only e mai riscritto — la regola di questo repo per ogni riga che
 * racconta cosa e' successo. Correggere significa quindi aggiungere, non
 * modificare: `collega` aggiunge il branch quando si scopre che non si chiama
 * come lo slug, e la storia di come ci si e' arrivati resta leggibile.
 */
function registro() {
  if (!existsSync(REGISTRO)) return [];
  const per = new Map();
  for (const l of readFileSync(REGISTRO, 'utf8').split('\n').filter(Boolean)) {
    const v = JSON.parse(l);
    per.set(v.id, { ...(per.get(v.id) ?? {}), ...v });
  }
  return [...per.values()];
}

function registra(id, slug, cosa) {
  mkdirSync(DIR, { recursive: true });
  const voce = { id, slug, cosa, quando: new Date().toISOString() };
  appendFileSync(REGISTRO, `${JSON.stringify(voce)}\n`);
  console.log(`registrata ${slug} (${id})`);
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Distilla un transcript. Ogni riga JSONL è un evento; le righe malformate si
 * saltano invece di far fallire il recupero — un transcript troncato a metà è
 * precisamente il caso per cui questo strumento esiste.
 */
function distilla(file) {
  const d = {
    turni: 0,
    strumenti: new Map(),
    scritti: new Set(),
    comandi: [],
    errori: [],
    modello: null,
    compito: null,
    ultimaParola: null,
    inizio: null,
    fine: null,
    righeRotte: 0,
  };
  for (const riga of readFileSync(file, 'utf8').split('\n')) {
    if (!riga.trim()) continue;
    let e;
    try {
      e = JSON.parse(riga);
    } catch {
      d.righeRotte++;
      continue;
    }
    if (e.timestamp) {
      d.inizio ??= e.timestamp;
      d.fine = e.timestamp;
    }
    const msg = e.message;
    if (!msg?.content) continue;
    if (e.type === 'assistant') {
      d.turni++;
      d.modello ??= msg.model ?? null;
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c.type === 'text' && c.text?.trim()) d.ultimaParola = c.text.trim();
        if (c.type !== 'tool_use') continue;
        d.strumenti.set(c.name, (d.strumenti.get(c.name) ?? 0) + 1);
        const i = c.input ?? {};
        if (i.file_path) d.scritti.add(String(i.file_path).replace(`${REPO}/`, ''));
        if (i.command) d.comandi.push(trunc(String(i.command).replace(/\s+/g, ' '), 120));
      }
    } else if (e.type === 'user') {
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c.type === 'tool_result' && c.is_error) {
          const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          d.errori.push(trunc(t.replace(/\s+/g, ' '), 160));
        }
      }
      if (!d.compito && typeof msg.content === 'string') d.compito = msg.content;
      else if (!d.compito && Array.isArray(msg.content)) {
        const t = msg.content.find((c) => c.type === 'text');
        if (t) d.compito = t.text;
      }
    }
  }
  return d;
}

function digest(id, voce) {
  const file = transcriptOf(id);
  if (!file) return `## ${id}\n\nTranscript non trovato.\n`;
  const d = distilla(file);
  const righe = [
    `## ${voce?.slug ?? id}`,
    '',
    `- **id** \`${id}\` · **modello** ${d.modello ?? '?'} · **turni** ${d.turni}`,
    `- **dal** ${d.inizio ?? '?'} **al** ${d.fine ?? '?'}`,
    `- **transcript** \`${file}\``,
  ];
  if (voce?.cosa) righe.push(`- **compito registrato**: ${voce.cosa}`);
  if (d.righeRotte) righe.push(`- ⚠️ ${d.righeRotte} righe illeggibili (transcript troncato)`);
  righe.push('');
  if (d.compito) righe.push('**Prompt**', '', '> ' + trunc(d.compito.replace(/\n/g, '\n> '), 900), '');
  const usati = [...d.strumenti.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`);
  if (usati.length) righe.push(`**Strumenti** ${usati.join(' · ')}`, '');
  if (d.scritti.size) {
    righe.push('**File toccati**', '', ...[...d.scritti].slice(0, 40).map((f) => `- \`${f}\``), '');
  }
  if (d.comandi.length) {
    const ultimi = d.comandi.slice(-15);
    righe.push('**Ultimi comandi**', '', '```bash', ...ultimi, '```', '');
  }
  if (d.errori.length) {
    righe.push(`**Errori (${d.errori.length})**`, '', ...d.errori.slice(-8).map((e) => `- ${e}`), '');
  }
  if (d.ultimaParola) righe.push('**Ultima parola**', '', trunc(d.ultimaParola, 1800), '');
  return righe.join('\n');
}

function raccogli(ids) {
  mkdirSync(DIR, { recursive: true });
  const reg = new Map(registro().map((v) => [v.id, v]));
  const target = ids.length ? ids : [...reg.keys()];
  if (!target.length) {
    console.error('niente da raccogliere: registro vuoto e nessun id passato');
    process.exit(1);
  }
  for (const id of target) {
    const md = digest(id, reg.get(id));
    const nome = `${reg.get(id)?.slug ?? id}.md`;
    writeFileSync(join(DIR, nome), `${md}\n`);
    console.log(`${nome} (${md.length} caratteri)`);
  }
}

function stato() {
  const reg = registro();
  if (!reg.length) return console.log('registro vuoto');
  for (const v of reg) {
    const f = transcriptOf(v.id);
    const kb = f ? (statSync(f).size / 1024).toFixed(0) : '—';
    console.log(`${f ? '✓' : '✗'} ${v.slug.padEnd(24)} ${v.id}  ${kb.padStart(6)} KB  ${v.cosa ?? ''}`);
  }
}

const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

/**
 * Il quadro con cui una sessione NUOVA riprende senza rifare niente.
 *
 * Direttiva owner: *«quando lavoriamo con cosi tanti agenti potremo finire i
 * token delle 5 ore di sessione in qualsiasi momento, dobbiamo SEMPRE essere
 * pronti a poter riprendere senza rifare tutto e senza perdere a cosa stava
 * lavorando chi e cosa e quanto e se manca cosa ancora»*.
 *
 * La forma segue la stessa regola del resto del repo: **si registra solo
 * l'intento, tutto il resto si deriva**. Un registro che dichiara anche lo
 * stato invecchia fra un comando e il successivo e comincia a mentire; branch,
 * PR e righe dell'inventario sono verità che stanno già altrove e si leggono
 * al momento della domanda.
 */
function riprendi() {
  const reg = registro();
  const prs = new Map();
  try {
    for (const p of JSON.parse(sh('gh pr list --state all --limit 60 --json number,title,headRefName,state,mergedAt') || '[]')) {
      prs.set(p.headRefName, p);
    }
  } catch {
    /* senza gh si lavora lo stesso, solo con meno contesto */
  }
  const branches = new Set(
    sh("git branch -r --format='%(refname:short)'")
      .split('\n')
      .map((b) => b.replace(/^origin\//, '').trim())
      .filter(Boolean),
  );

  const righe = [];
  for (const v of reg) {
    const t = transcriptOf(v.id);
    const branch = v.branch ?? (branches.has(`slice/${v.slug}`) ? `slice/${v.slug}` : null);
    const pr = branch ? prs.get(branch) : undefined;
    let dove;
    if (pr?.state === 'MERGED') dove = `mergiata #${pr.number}`;
    else if (pr?.state === 'OPEN') dove = `PR #${pr.number} aperta`;
    else if (branch) dove = `branch ${branch}, nessuna PR`;
    else dove = 'nessun branch';
    const ultimo = t ? statSync(t).mtime.toISOString().slice(5, 16).replace('T', ' ') : '—';
    righe.push({ slug: v.slug, id: v.id, dove, ultimo, cosa: v.cosa ?? '', vivo: !!t, chiuso: pr?.state === 'MERGED' });
  }

  const aperte = righe.filter((r) => !r.chiuso);
  const chiuse = righe.filter((r) => r.chiuso);

  console.log(`\n═══ APERTE (${aperte.length}) — riprendibili con SendMessage all'id ═══`);
  for (const r of aperte) {
    console.log(`  ${r.slug.padEnd(22)} ${r.dove.padEnd(24)} ultimo ${r.ultimo}`);
    console.log(`  ${' '.repeat(22)} ${r.cosa}`);
    console.log(`  ${' '.repeat(22)} id ${r.id}${r.vivo ? '' : '  ⚠ transcript assente'}`);
  }
  console.log(`\n═══ CHIUSE (${chiuse.length}) ═══`);
  for (const r of chiuse) console.log(`  ${r.slug.padEnd(22)} ${r.dove}`);

  // Cosa manca: le righe bloccanti dell'inventario che nessuna delega nomina.
  // È la domanda a cui una sessione morta non saprebbe più rispondere.
  let inventario = '';
  try {
    inventario = readFileSync(join(REPO, 'docs', 'blueprint', 'M5-BIS.md'), 'utf8');
  } catch {
    /* niente inventario, niente scoperto */
  }
  const bloccanti = [...inventario.matchAll(/^\|\s*([A-E]\d+)\s*\|([^|]*)\|([^|]*)\|\s*(BLOCKER[^|]*)\|/gm)].map((m) => ({
    id: m[1],
    area: m[2].trim(),
    stato: m[4].trim(),
  }));
  const testoDeleghe = reg.map((v) => `${v.slug} ${v.cosa ?? ''}`).join(' ');
  const scoperte = bloccanti.filter((b) => !new RegExp(`\\b${b.id}\\b`).test(testoDeleghe));
  console.log(`\n═══ BLOCCANTI SENZA DELEGA (${scoperte.length} su ${bloccanti.length}) ═══`);
  for (const b of scoperte) console.log(`  ${b.id.padEnd(4)} ${b.area.padEnd(16)} ${b.stato}`);
  console.log('\nStato del lavoro: docs/blueprint/LAVORO.md · Inventario: docs/blueprint/M5-BIS.md');
  console.log('Recupero di una delega morta: node .claude/deleghe.mjs raccogli <id>\n');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'registra') {
  if (args.length < 2) {
    console.error('uso: deleghe.mjs registra <id> <slug> "<cosa deve fare>"');
    process.exit(1);
  }
  registra(args[0], args[1], args.slice(2).join(' '));
} else if (cmd === 'raccogli') {
  raccogli(args);
} else if (cmd === 'stato') {
  stato();
} else if (cmd === 'collega') {
  if (args.length < 2) {
    console.error('uso: deleghe.mjs collega <id> <branch>');
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true });
  appendFileSync(REGISTRO, `${JSON.stringify({ id: args[0], branch: args[1], quando: new Date().toISOString() })}\n`);
  console.log(`${args[0]} → ${args[1]}`);
} else if (cmd === 'riprendi') {
  riprendi();
} else {
  console.error('uso: deleghe.mjs registra|collega|raccogli|stato|riprendi');
  process.exit(1);
}
