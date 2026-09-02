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
 *   node .claude/deleghe.mjs collega <id> <branch>   # quando il branch non si chiama come lo slug
 *   node .claude/deleghe.mjs chiudi <id> "<motivo>"  # senza branch da cui derivare la chiusura
 *   node .claude/deleghe.mjs raccogli [id…]     # default: tutte le registrate; scrive digest + brief
 *   node .claude/deleghe.mjs stato
 *   node .claude/deleghe.mjs riprendi           # il quadro con cui una sessione nuova riprende
 *
 * Direttiva owner, 2026-08-18. Il registro sapeva già dire *chi stava facendo
 * cosa*; restavano tre buchi che una sessione nuova pagava per intero, e sono i
 * tre verbi aggiunti in fondo:
 *
 *   node .claude/deleghe.mjs parcheggia <id> "<errore>" [--prossima "<azione>"]
 *   node .claude/deleghe.mjs diagnosi           # lo stato rotto che una morte lascia dietro
 *   node .claude/deleghe.mjs preventivo <n>     # quanto costa un ventaglio, misurato
 *
 * 1. **Una delega uccisa dalla quota era indistinguibile da una viva.** `riprendi`
 *    la mostrava «APERTA — riprendibile» esattamente come una che stava
 *    lavorando, e una sessione nuova non poteva sapere che il lavoro non era mai
 *    cominciato. `parcheggia` è la riga che glielo dice.
 * 2. **Lo stato rotto si scopriva lavorandoci.** `loop.md` §1 dice di leggere
 *    `git status`: è un'istruzione al modello, non un controllo. Un merge a metà
 *    o `esbuild` per l'altra piattaforma sono già costati venticinque test rossi
 *    letti come regressione.
 * 3. **Il ventaglio partiva senza preventivo.** Il costo di una delega non è un
 *    mistero: sta misurato nei transcript di quelle già fatte, e si legge prima
 *    di lanciarne quaranta invece che a metà.
 *
 * ORCHESTRATION.md#work-is-claim-oriented (un subagente che dice di aver fatto non è evidenza).
 */
import { execFileSync, execSync } from 'node:child_process';
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

/**
 * Il nome di una delega che una `registra` non ha mai nominato.
 *
 * Succede davvero, e non è un caso di scuola: quattro righe del registro hanno
 * solo una `chiudi` per id — judge lanciati e conclusi mentre la sessione veniva
 * compattata, con la `registra` che non è mai arrivata a toccare il file. È
 * precisamente lo stato parziale che questo strumento esiste per sopravvivere, e
 * fino a qui lo faceva saltare: `v.slug.padEnd()` su `undefined` uccideva
 * `stato` e `riprendi` — cioè i due comandi con cui una sessione fresca comincia.
 */
const MAI_REGISTRATA = '(mai registrata)';

function registra(id, slug, cosa) {
  mkdirSync(DIR, { recursive: true });
  const voce = { id, slug, cosa, quando: new Date().toISOString() };
  appendFileSync(REGISTRO, `${JSON.stringify(voce)}\n`);
  console.log(`registrata ${slug} (${id})`);
}

/**
 * Chiudere a mano una delega che non ha un branch da cui derivare la chiusura.
 *
 * `riprendi` deriva «chiusa» dall'integrazione del branch, e per la maggior
 * parte delle deleghe basta. Ma una delega può finire senza lasciare un branch:
 * un'estrazione read-only, una valutazione, o un agente morto prima di produrre
 * qualcosa. Senza questo verbo quelle voci restano «APERTE — riprendibili» per
 * sempre, e una sessione nuova le riprenderebbe davvero — è successo con otto
 * voci in un giorno. La chiusura resta append-only come tutto il resto: si
 * aggiunge una riga col motivo, non si riscrive la storia.
 */
function chiudi(id, motivo) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(REGISTRO, `${JSON.stringify({ id, chiuso: motivo, quando: new Date().toISOString() })}\n`);
  console.log(`chiusa ${id}: ${motivo}`);
}

/** Gli errori che uccidono una delega senza che abbia sbagliato niente. */
const MORTE_PER_QUOTA = /529|overload|rate.?limit|quota|usage limit|session limit|limite/i;

/**
 * Una delega uccisa dalla quota non ha fallito: è da rilanciare.
 *
 * È la distinzione che mancava. `riprendi` deriva «chiusa» dall'integrazione e
 * chiama aperto tutto il resto, quindi una delega morta su un 529 compariva fra
 * le riprendibili **identica a una che stava lavorando**: la sessione nuova non
 * aveva modo di sapere se il lavoro era in corso o non era mai cominciato, e la
 * differenza fra le due è se rilanciarla adesso o aspettarla.
 *
 * Si registrano soltanto le due cose che non si derivano da nessuna parte:
 * **perché è morta** e, se si sa, **da dove ripartire**. Tutto il resto — branch,
 * PR, file toccati, comandi, ultima parola — sta già nel transcript e lo tira
 * fuori `raccogli`, che è il verbo scritto apposta per non versare
 * diecimila righe di JSONL dentro una conversazione.
 */
function parcheggia(id, errore, prossima) {
  mkdirSync(DIR, { recursive: true });
  const voce = { id, parcheggiata: errore, quando: new Date().toISOString() };
  if (prossima) voce.prossima = prossima;
  appendFileSync(REGISTRO, `${JSON.stringify(voce)}\n`);

  const v = registro().find((r) => r.id === id) ?? {};
  const nome = v.slug ?? id;
  console.log(`parcheggiata ${nome} (${id}): ${errore}`);
  if (!MORTE_PER_QUOTA.test(errore)) {
    console.log('⚠ non sembra una morte per quota. Se la delega ha sbagliato si chiude,');
    console.log('  non si parcheggia: node .claude/deleghe.mjs chiudi ' + id + ' "<motivo>"');
  }
  console.log('\nPer rilanciarla, il mandato intero è su disco — non riscriverlo a memoria:');
  console.log(`  node .claude/deleghe.mjs raccogli ${id}`);
  console.log(`  .claude/deleghe/${nome}.brief.md`);
  console.log('\nQuando riparte con un id nuovo, chiudi questa riga:');
  console.log(`  node .claude/deleghe.mjs chiudi ${id} "rilanciata come <id nuovo>"`);
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

/**
 * Il mandato originale, intero. Il digest lo tronca a 900 caratteri per restare
 * leggibile in un contesto; ma chi riprende una delega morta deve ricevere il
 * brief com'era stato scritto — è la parte del lavoro già fatta con più cura, e
 * riscriverlo a memoria è il modo di perderne un vincolo. Si scrive accanto al
 * digest, con lo stesso nome più `.brief`.
 */
function brief(file) {
  for (const riga of readFileSync(file, 'utf8').split('\n')) {
    if (!riga.trim()) continue;
    let e;
    try {
      e = JSON.parse(riga);
    } catch {
      continue;
    }
    if (e.type !== 'user') continue;
    const c = e.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.find((x) => x.type === 'text');
      if (t) return t.text;
    }
  }
  return null;
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
    const base = reg.get(id)?.slug ?? id;
    writeFileSync(join(DIR, `${base}.md`), `${md}\n`);
    console.log(`${base}.md (${md.length} caratteri)`);
    const file = transcriptOf(id);
    const mandato = file ? brief(file) : null;
    if (mandato) {
      writeFileSync(join(DIR, `${base}.brief.md`), `${mandato}\n`);
      console.log(`${base}.brief.md (${mandato.length} caratteri)`);
    }
  }
}

function stato() {
  const reg = registro();
  if (!reg.length) return console.log('registro vuoto');
  for (const v of reg) {
    const f = transcriptOf(v.id);
    const kb = f ? (statSync(f).size / 1024).toFixed(0) : '—';
    console.log(`${f ? '✓' : '✗'} ${(v.slug ?? MAI_REGISTRATA).padEnd(24)} ${v.id}  ${kb.padStart(6)} KB  ${v.cosa ?? ''}`);
  }
}

const sh = (cmd) => {
  try {
    return {
      ok: true,
      output: execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    };
  } catch {
    return { ok: false, output: '' };
  }
};

/**
 * Il danno che una sessione morta lascia dietro, cercato **prima** di lavorarci.
 *
 * `loop.md` §1 chiede già di leggere lo stato osservato, ma leggere `git status`
 * è un'istruzione al modello, e questo repo ha una famiglia di difetti fatta di
 * regole che vivono solo in prosa (`ORCHESTRATION.md` §13.2). Qui la stessa
 * domanda è un controllo: esce con l'elenco, non con una buona intenzione.
 *
 * Ogni voce è già costata qualcosa. `esbuild` per l'altra piattaforma ha
 * prodotto venticinque test rossi letti come regressione del codice; un merge
 * interrotto ha fatto ripartire una sessione su un albero che non era né il
 * vecchio né il nuovo.
 */
function diagnosi() {
  const guai = [];
  const gitDir = sh('git rev-parse --absolute-git-dir');

  if (gitDir.ok) {
    const dir = gitDir.output.trim();
    const aMeta = [
      ['MERGE_HEAD', 'merge a metà', 'git merge --abort'],
      ['CHERRY_PICK_HEAD', 'cherry-pick a metà', 'git cherry-pick --abort'],
      ['REVERT_HEAD', 'revert a metà', 'git revert --abort'],
      ['rebase-merge', 'rebase a metà', 'git rebase --abort'],
      ['rebase-apply', 'rebase a metà', 'git rebase --abort'],
    ];
    for (const [f, cosa, rimedio] of aMeta) {
      if (existsSync(join(dir, f))) guai.push({ classe: 'git', cosa, rimedio, aMano: true });
    }
  }

  const nonRisolti = sh('git ls-files -u');
  if (nonRisolti.ok && nonRisolti.output.trim()) {
    const n = new Set(nonRisolti.output.trim().split('\n').map((r) => r.split('\t').pop())).size;
    guai.push({ classe: 'git', cosa: `${n} file con conflitto non risolto`, rimedio: 'git status', aMano: true });
  }

  // Un marcatore vero apre **e** chiude. Cercare `=======` da solo trova ogni
  // titolo Markdown sottolineato, e in un repo che tocca più Markdown che
  // TypeScript un controllo del genere diventa rumore che qualcuno disattiva.
  const apre = sh("git grep -lE '^<<<<<<< ' -- .");
  if (apre.ok && apre.output.trim()) {
    const veri = apre.output
      .trim()
      .split('\n')
      .filter((f) => sh(`git grep -qE '^>>>>>>> ' -- '${f}'`).ok);
    if (veri.length) {
      guai.push({
        classe: 'git',
        cosa: `marcatori di conflitto in ${veri.length} file: ${veri.slice(0, 3).join(', ')}`,
        rimedio: 'risolvi a mano prima di committare',
        aMano: true,
      });
    }
  }

  // Commit che esistono solo qui: un worktree abbandonato da una sessione morta
  // è il posto dove il lavoro sparisce senza che nessuno se ne accorga.
  const rami = sh("git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads");
  if (rami.ok) {
    for (const riga of rami.output.trim().split('\n').filter(Boolean)) {
      const m = /^(\S+)\s+\[ahead (\d+)/.exec(riga.trim());
      if (m) {
        guai.push({
          classe: 'lavoro',
          cosa: `${m[1]} ha ${m[2]} commit non pushati`,
          rimedio: `git push -u origin ${m[1]}`,
          aMano: false,
        });
      }
    }
  }

  if (!existsSync(join(REPO, 'node_modules'))) {
    guai.push({ classe: 'toolchain', cosa: 'node_modules assente', rimedio: 'npm ci', aMano: false });
  } else {
    const eb = join(REPO, 'node_modules', '.bin', 'esbuild');
    let rotto = !existsSync(eb);
    if (!rotto) {
      try {
        execFileSync(eb, ['--version'], { cwd: REPO, stdio: 'ignore' });
      } catch {
        rotto = true;
      }
    }
    if (rotto) {
      guai.push({
        classe: 'toolchain',
        cosa: 'esbuild non eseguibile (worktree copiato, o piattaforma diversa)',
        rimedio: 'npm ci',
        aMano: false,
      });
    }
  }

  const sporco = sh('git status --porcelain');
  if (sporco.ok && sporco.output.trim()) {
    const n = sporco.output.trim().split('\n').length;
    guai.push({ classe: 'lavoro', cosa: `${n} file non committati`, rimedio: 'commit sulla slice', aMano: false });
  }

  return guai;
}

function stampaDiagnosi(guai) {
  if (!guai.length) {
    console.log('\n═══ DIAGNOSI ═══\n  nessun danno rilevato.');
    return;
  }
  console.log(`\n═══ DIAGNOSI (${guai.length}) — prima di nuovo lavoro ═══`);
  for (const g of guai) {
    console.log(`  [${g.classe}] ${g.cosa}`);
    console.log(`  ${' '.repeat(g.classe.length + 2)} → ${g.rimedio}${g.aMano ? '   (a mano: può distruggere lavoro)' : ''}`);
  }
}

/**
 * Quanto è costata davvero una delega, letto invece che stimato.
 *
 * Si sommano `output_tokens` e l'input **non cachato**: la lettura di cache è di
 * un ordine di grandezza più economica e includerla gonfia il preventivo fino a
 * renderlo inutile. Nessun prezzo in valuta: i prezzi cambiano fuori da questo
 * repo, e un numero che invecchia da solo è ciò che §13 vieta di scrivere.
 */
function usoMisurato(filtroModello, filtroTipo) {
  // Judge e worker costano in modo diverso — il primo legge molto e scrive
  // poco, il secondo scrive — e mediarli produce una banda che non descrive
  // nessuno dei due. La distinzione **non si inferisce** dal comportamento: si
  // legge dallo slug che l'orchestratore ha dichiarato quando ha registrato la
  // delega. È intenzione scritta, non una firma indovinata a posteriori — e per
  // le deleghe che non seguono la convenzione l'onesto è dire «non classificata»
  // invece di attribuirle a una delle due popolazioni.
  const tipoDi = new Map();
  for (const v of registro()) {
    if (!v.slug) continue;
    if (/^judge-/.test(v.slug)) tipoDi.set(v.id, 'judge');
    else if (/^slice-/.test(v.slug)) tipoDi.set(v.id, 'worker');
  }

  const file = [];
  for (const d of subagentsDirs()) {
    for (const f of readdirSync(d)) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      try {
        file.push({
          p: join(d, f),
          id: f.slice('agent-'.length, -'.jsonl'.length),
          m: statSync(join(d, f)).mtimeMs,
        });
      } catch {
        /* sparito fra readdir e stat */
      }
    }
  }
  // La storia recente stima meglio di quella vecchia, e leggerla tutta costa.
  file.sort((a, b) => b.m - a.m);

  const campione = [];
  for (const { p, id } of file.slice(0, 120)) {
    const tipo = tipoDi.get(id) ?? null;
    if (filtroTipo && tipo !== filtroTipo) continue;
    let testo;
    try {
      testo = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    let modello = null;
    let token = 0;
    let chiamate = 0;
    for (const riga of testo.split('\n')) {
      // Pre-filtro a stringa: parsare ogni riga renderebbe il preventivo più
      // lento del ventaglio che deve prevenire.
      if (!riga.includes('"usage"')) continue;
      let e;
      try {
        e = JSON.parse(riga);
      } catch {
        continue;
      }
      const u = e.message?.usage;
      if (!u) continue;
      modello ??= e.message?.model ?? null;
      token += (u.output_tokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      // Le tool call sono il predittore vero del costo: ogni chiamata rilegge il
      // contesto accumulato, quindi la lettura di cache cresce con il quadrato
      // delle chiamate, non con il numero di worker. Un ventaglio di agenti
      // silenziosi costa meno di metà ventaglio che frughi il repo.
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (c.type === 'tool_use') chiamate++;
      }
    }
    if (!token) continue;
    if (filtroModello && !(modello ?? '').includes(filtroModello)) continue;
    campione.push({ token, chiamate, tipo });
  }
  return campione;
}

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const migliaia = (n) => `${Math.round(n / 1000)}k`;

/**
 * Il preventivo prima del ventaglio.
 *
 * Non impone un tetto: **il numero è il punto**, non una soglia inventata qui.
 * Un ventaglio materialmente costoso è una decisione dell'owner
 * (`ORCHESTRATION.md` §2, classe «costo»), e questo comando serve a portargliela
 * istruita invece che a scoprirla a metà — come è successo con quaranta sonde
 * fermate in corsa. Un tetto si passa quando c'è (`--tetto`), e allora vale
 * come cancello.
 */
function preventivo(n, { modello, tetto, tipo }) {
  const campione = usoMisurato(modello, tipo);
  if (campione.length < 5) {
    const per = [modello && `«${modello}»`, tipo && `tipo ${tipo}`].filter(Boolean).join(', ');
    console.error(`campione insufficiente: ${campione.length} deleghe misurate${per ? ` per ${per}` : ''}.`);
    console.error('Senza storia non c\'è preventivo: lancia una delega alla volta finché non ce n\'è.');
    process.exit(1);
  }

  const token = campione.map((c) => c.token);
  const p50 = quantile(token, 0.5);
  const p80 = quantile(token, 0.8);
  const chiamate = campione.map((c) => c.chiamate);
  const stima = n * p80;

  console.log(`\n═══ PREVENTIVO — ${n} ${n === 1 ? 'delega' : 'deleghe'} ═══\n`);
  console.log(`  campione   ${campione.length} deleghe misurate${modello ? ` (${modello})` : ''}`);
  console.log(`  per delega p50 ${migliaia(p50)} · p80 ${migliaia(p80)} token`);
  console.log(`  chiamate   p50 ${quantile(chiamate, 0.5)} · p80 ${quantile(chiamate, 0.8)} tool call per delega`);
  console.log(`  ventaglio  ~${migliaia(stima)} token (${n} × p80)`);
  if (tetto) console.log(`  tetto      ${migliaia(tetto)} token`);

  // La composizione si dichiara sempre. Un p80 su popolazioni diverse è una
  // banda, non una previsione, e la differenza fra le due si vede solo se
  // qualcuno scrive quante deleghe non erano classificabili.
  if (!tipo) {
    const conta = (t) => campione.filter((c) => c.tipo === t).length;
    const ignote = campione.filter((c) => c.tipo === null).length;
    console.log(`  composto   ${conta('judge')} judge · ${conta('worker')} worker · ${ignote} non classificate`);
    console.log('');
    console.log('  ⓘ banda osservata, non previsione. Le tool call predicono meglio dei token.');
    if (ignote) console.log('    Per una banda omogenea: --tipo judge oppure --tipo worker.\n');
    else console.log('');
  } else {
    console.log(`  tipo       solo ${tipo} (dallo slug dichiarato nel registro)\n`);
  }

  if (n === 1) {
    console.log('Una delega sola: se la task è piccola e locale, falla direttamente.');
    console.log('Delegare non è il default — costa un contesto intero per ricostruire ciò che qui è già noto.\n');
    return;
  }

  // L'alternativa si stampa solo quando è davvero un'alternativa. Senza tetto
  // «6 per giro × 1 giro» è il ventaglio che è stato appena chiesto, e un
  // consiglio che ripete la domanda insegna a saltare l'output.
  const stanno = tetto ? Math.max(1, Math.floor(tetto / p80)) : n;
  if (stanno < n) {
    const giri = Math.ceil(n / stanno);
    console.log(`Alternativa sequenziale: ${stanno} per giro × ${giri} ${giri === 1 ? 'giro' : 'giri'}.`);
  }
  console.log('Se una sequenza più economica produce la stessa informazione, preferiscila.');
  console.log('Prima di lanciare, dì cosa compra il parallelismo qui: se la risposta è');
  console.log('«finisce prima», non è una ragione — le deleghe non sono gratis.\n');

  if (tetto && stima > tetto) {
    console.error(`OLTRE IL TETTO: ${migliaia(stima)} > ${migliaia(tetto)} token. Chiedi all'owner o riduci.`);
    process.exit(1);
  }
  console.log('Registra ogni delega prima che parta: node .claude/deleghe.mjs registra <id> <slug> "<cosa>"\n');
}

const INVENTARIO_DAY1 = 'docs/work/day1/requirements-status.md';

/**
 * Le righe BLOCKER dell'inventario DAY-1, oppure il motivo per cui non si sa.
 *
 * Tre esiti, e i primi due non si confondono col terzo: `{ bloccanti: [...] }`
 * (ce ne sono), `{ bloccanti: [] }` (l'inventario c'è e non ne ha), oppure
 * `{ errore }` — file assente, illeggibile, o senza la tabella a quattro
 * colonne che questo parser sa leggere. Quest'ultimo caso è la deriva gemella
 * del path sbagliato: se qualcuno cambia le colonne, la regex sotto prende
 * zero righe da un file valido, e senza il controllo dell'header quello zero
 * sarebbe di nuovo indistinguibile da «nessun bloccante».
 */
function inventarioDay1() {
  let testo;
  try {
    testo = readFileSync(join(REPO, INVENTARIO_DAY1), 'utf8');
  } catch (e) {
    return { errore: e.code ?? String(e) };
  }
  if (!/^\|\s*#\s*\|\s*Area\s*\|[^|]*\|\s*Stato\s*\|\s*$/m.test(testo)) {
    return { errore: 'tabella `| # | Area | … | Stato |` non riconosciuta: il parser è più vecchio del file' };
  }
  // Una riga con uno stato DAY-1 ma un id che il parser non sa leggere (`F1`,
  // `a1`) è la terza porta: cadrebbe fuori dalla regex sotto e il conteggio
  // scenderebbe in silenzio, fino a un `0 su 0` credibile.
  const nonLette = [...testo.matchAll(/^\|\s*([^|]*?)\s*\|[^|]*\|[^|]*\|\s*(?:READY|OUT|BLOCKER|INVALIDATED)\b[^|]*\|/gm)]
    .map((m) => m[1])
    .filter((id) => !/^[A-E]\d+$/.test(id));
  if (nonLette.length) {
    return { errore: `${nonLette.length} righe con id non riconosciuto (${nonLette.slice(0, 3).join(', ')}): il parser è più vecchio del file` };
  }
  const bloccanti = [...testo.matchAll(/^\|\s*([A-E]\d+)\s*\|([^|]*)\|([^|]*)\|\s*(BLOCKER[^|]*)\|/gm)].map((m) => ({
    id: m[1],
    area: m[2].trim(),
    stato: m[4].trim(),
  }));
  return { bloccanti };
}

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
  let githubAvailable = true;
  const gh = sh('gh pr list --state all --limit 60 --json number,title,headRefName,state,mergedAt');
  try {
    if (!gh.ok) throw new Error('gh non disponibile');
    for (const p of JSON.parse(gh.output)) {
      prs.set(p.headRefName, p);
    }
  } catch {
    githubAvailable = false;
  }
  const remote = sh("git branch -r --format='%(refname:short)'");
  const branches = new Set(
    remote.output
      .split('\n')
      .map((b) => b.replace(/^origin\//, '').trim())
      .filter(Boolean),
  );

  // Git answers integration before GitHub enriches it. This remains available
  // during a gh outage and prevents a merged branch from becoming actionable
  // again merely because an API call failed.
  const mergedBranches = new Set();
  for (const target of ['dev', 'main']) {
    const merged = sh(
      `git for-each-ref --merged=refs/remotes/origin/${target} --format='%(refname:short)' refs/remotes/origin`,
    );
    if (!merged.ok) continue;
    for (const ref of merged.output.split('\n').filter(Boolean)) {
      mergedBranches.add(ref.replace(/^origin\//, '').trim());
    }
  }
  // Merged slice refs are normally deleted. The merge commit subject keeps the
  // branch name after that deletion, so local ancestry still has a durable
  // witness without asking GitHub.
  const mergedSubjects = new Set();
  const log = sh("git log refs/remotes/origin/dev refs/remotes/origin/main --merges --format='%s'");
  if (log.ok) {
    for (const line of log.output.split('\n')) {
      const match = /^Merge pull request #\d+ from [^/]+\/(.+)$/.exec(line.trim());
      if (match) mergedSubjects.add(match[1]);
    }
  }

  const righe = [];
  for (const v of reg) {
    const t = transcriptOf(v.id);
    const branch = v.branch ?? (branches.has(`slice/${v.slug}`) ? `slice/${v.slug}` : null);
    const pr = branch ? prs.get(branch) : undefined;
    const locallyMerged = branch !== null && (mergedBranches.has(branch) || mergedSubjects.has(branch));
    // A hand closure (`chiudi`) wins over everything else: it is the one fact
    // about a delegation that git and GitHub cannot derive.
    // Una delega parcheggiata è morta per quota: non è «aperta» (nessuno ci sta
    // lavorando) e non è «chiusa» (il lavoro non c'è). Sta prima del ramo che
    // guarda GitHub perché è un fatto che nessuna API può smentire — e resta
    // vera anche durante un'indisponibilità di `gh`.
    const stato = v.chiuso || pr?.state === 'MERGED' || locallyMerged
      ? 'closed'
      : v.parcheggiata
        ? 'parked'
        : githubAvailable
          ? 'open'
          : 'unknown';
    let dove;
    if (v.chiuso) dove = `chiusa: ${v.chiuso}`;
    else if (pr?.state === 'MERGED') dove = `mergiata #${pr.number}`;
    else if (locallyMerged) dove = 'integrata (ancestry Git locale)';
    else if (v.parcheggiata) dove = `parcheggiata: ${v.parcheggiata}`;
    else if (pr?.state === 'OPEN') dove = `PR #${pr.number} aperta`;
    else if (!githubAvailable && branch) dove = `branch ${branch}, stato PR sconosciuto`;
    else if (!githubAvailable) dove = 'stato sconosciuto: GitHub non disponibile';
    else if (branch) dove = `branch ${branch}, nessuna PR`;
    else dove = 'nessun branch';
    const ultimo = t ? statSync(t).mtime.toISOString().slice(5, 16).replace('T', ' ') : '—';
    righe.push({
      slug: v.slug ?? MAI_REGISTRATA,
      mai: !v.slug,
      id: v.id,
      dove,
      ultimo,
      cosa: v.cosa ?? '',
      prossima: v.prossima ?? '',
      vivo: !!t,
      stato,
    });
  }

  const aperte = righe.filter((r) => r.stato === 'open');
  const chiuse = righe.filter((r) => r.stato === 'closed');
  const sconosciute = righe.filter((r) => r.stato === 'unknown');
  const parcheggiate = righe.filter((r) => r.stato === 'parked');

  // Lo stato rotto si legge prima delle deleghe: se il worktree è a metà di un
  // merge, quale delega riprendere è la seconda domanda.
  stampaDiagnosi(diagnosi());

  if (!githubAvailable) {
    console.log('\n⚠ GitHub non disponibile: nessuna delega incerta viene dichiarata aperta o riprendibile.');
  }

  console.log(`\n═══ PARCHEGGIATE (${parcheggiate.length}) — uccise dalla quota: rilanciare, non ricostruire ═══`);
  for (const r of parcheggiate) {
    console.log(`  ${r.slug.padEnd(22)} ${r.dove}`);
    console.log(`  ${' '.repeat(22)} ${r.cosa}`);
    if (r.prossima) console.log(`  ${' '.repeat(22)} riparti da: ${r.prossima}`);
    console.log(`  ${' '.repeat(22)} node .claude/deleghe.mjs raccogli ${r.id}`);
  }

  console.log(`\n═══ APERTE (${aperte.length}) — riprendibili con SendMessage all'id ═══`);
  for (const r of aperte) {
    console.log(`  ${r.slug.padEnd(22)} ${r.dove.padEnd(24)} ultimo ${r.ultimo}`);
    console.log(`  ${' '.repeat(22)} ${r.cosa}`);
    console.log(`  ${' '.repeat(22)} id ${r.id}${r.vivo ? '' : '  ⚠ transcript assente'}`);
  }
  console.log(`\n═══ CHIUSE (${chiuse.length}) ═══`);
  for (const r of chiuse) console.log(`  ${r.slug.padEnd(22)} ${r.dove}`);

  // Una chiusura senza registrazione non è un difetto di formato: è la prova che
  // la `registra` non è mai atterrata, quindi per quelle deleghe non esistono né
  // il mandato né il brief. Vale la pena dirlo una volta, non nasconderlo dentro
  // una riga che sembra normale.
  const mai = righe.filter((r) => r.mai);
  if (mai.length) {
    console.log(`\n⚠ ${mai.length} chiuse senza registrazione: la riga \`registra\` non è mai arrivata,`);
    console.log('  quindi mandato e brief non sono recuperabili. Registra prima di lanciare, non dopo.');
  }

  console.log(`\n═══ SCONOSCIUTE (${sconosciute.length}) — non riprendere senza verifica ═══`);
  for (const r of sconosciute) {
    console.log(`  ${r.slug.padEnd(22)} ${r.dove.padEnd(36)} ultimo ${r.ultimo}`);
    console.log(`  ${' '.repeat(22)} id ${r.id}`);
  }

  // Cosa manca: le righe bloccanti dell'inventario che nessuna delega nomina.
  // È la domanda a cui una sessione morta non saprebbe più rispondere.
  const inv = inventarioDay1();
  if (inv.errore) {
    // Un inventario che non si legge non è un inventario vuoto. Fino al
    // 2026-09-01 il read failure diventava `''`, quindi `[]`, quindi
    // `0 su 0`: la stessa riga che un inventario davvero senza bloccanti
    // avrebbe stampato — mentre quello vero ne aveva 31, 14 senza delega.
    // Come `diagnosi`, esce ≠ 0 senza troncare il briefing: il file è del
    // repo, il guasto non si risolve da solo, e un cancello deve poterlo
    // leggere senza interpretare la prosa.
    console.log(`\n═══ INVENTARIO DAY-1 NON DISPONIBILE — i bloccanti senza delega sono sconosciuti ═══`);
    console.log(`  ${INVENTARIO_DAY1}: ${inv.errore}`);
    process.exitCode = 1;
  } else {
    const testoDeleghe = reg.map((v) => `${v.slug} ${v.cosa ?? ''}`).join(' ');
    const scoperte = inv.bloccanti.filter((b) => !new RegExp(`\\b${b.id}\\b`).test(testoDeleghe));
    console.log(`\n═══ BLOCCANTI SENZA DELEGA (${scoperte.length} su ${inv.bloccanti.length}) ═══`);
    for (const b of scoperte) console.log(`  ${b.id.padEnd(4)} ${b.area.padEnd(16)} ${b.stato}`);
  }
  console.log(`\nHandoff: docs/work/handoff.md · Requisiti DAY-1: ${INVENTARIO_DAY1}`);
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
} else if (cmd === 'chiudi') {
  if (args.length < 2) {
    console.error('uso: deleghe.mjs chiudi <id> "<motivo>"');
    process.exit(1);
  }
  chiudi(args[0], args.slice(1).join(' '));
} else if (cmd === 'riprendi') {
  riprendi();
} else if (cmd === 'parcheggia') {
  const i = args.indexOf('--prossima');
  const prossima = i === -1 ? undefined : args.slice(i + 1).join(' ');
  const resto = i === -1 ? args : args.slice(0, i);
  if (resto.length < 2) {
    console.error('uso: deleghe.mjs parcheggia <id> "<errore>" [--prossima "<azione>"]');
    process.exit(1);
  }
  parcheggia(resto[0], resto.slice(1).join(' '), prossima);
} else if (cmd === 'diagnosi') {
  const guai = diagnosi();
  stampaDiagnosi(guai);
  // Esce ≠ 0 quando c'è qualcosa da sistemare, così vale come cancello in un
  // hook o in uno script e non solo come stampa che qualcuno legge.
  process.exit(guai.length ? 1 : 0);
} else if (cmd === 'preventivo') {
  const n = Number(args[0]);
  if (!Number.isFinite(n) || n <= 0) {
    console.error('uso: deleghe.mjs preventivo <n> [--modello <nome>] [--tetto <token>] [--tipo judge|worker]');
    process.exit(1);
  }
  const val = (nome) => {
    const i = args.indexOf(`--${nome}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const tipo = val('tipo');
  if (tipo && tipo !== 'judge' && tipo !== 'worker') {
    console.error(`--tipo accetta judge o worker, non «${tipo}»`);
    process.exit(1);
  }
  const tetto = val('tetto');
  preventivo(n, { modello: val('modello'), tetto: tetto ? Number(tetto) : undefined, tipo });
} else {
  console.error('uso: deleghe.mjs registra|collega|chiudi|parcheggia|raccogli|stato|riprendi|diagnosi|preventivo');
  process.exit(1);
}
