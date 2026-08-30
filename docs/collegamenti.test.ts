import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * I riferimenti fra documenti non hanno un compilatore, e questo repo ha già
 * pagato la loro assenza due volte.
 *
 * Il refactor documentale del 2026-08-19 ha rinumerato le sezioni di
 * `ORCHESTRATION.md` e `PRACTICES.md`. Le citazioni `§N` sparse nel codice non
 * sono state aggiornate, e nessuno se n'è accorto — perché un `§15` che non
 * esiste non rompe niente: si legge come una promessa, si segue, e non porta
 * da nessuna parte.
 *
 * Non è nemmeno che nessuno l'avesse visto: due ricerche del corpus evidence —
 * `turno-sospendibile.md` e `piano-eventi-workspace.md` — hanno registrato per
 * iscritto che una sezione citata non esisteva, ciascuna nel proprio dominio, e
 * nessun meccanismo l'ha fermato. Questo file è quel meccanismo: è il controllo
 * che l'audit dell'architettura informativa del 19/08 elencava per ultimo e che
 * non è mai stato scritto.
 *
 * Due proprietà, e la seconda è la ragione per cui la prima non basta:
 *
 *   1. un `§N` citato deve **risolvere** a una sezione che esiste;
 *   2. un documento **vivo** — che si edita, e quindi si rinumera — non si cita
 *      per posizione ma per titolo.
 *
 * La (1) da sola lascerebbe verde il repo il giorno prima di ogni rinumerazione
 * e rosso il giorno dopo, sparso su file che non c'entrano con la modifica. La
 * (2) toglie la classe di guasto invece di inseguirla: un'ancora si rompe forte,
 * un numero si rompe in silenzio.
 *
 * ## Cosa NON è sorvegliato, e perché non è un'eccezione
 *
 * ADR, research/evidence e history sono **append-only e datati**: non si
 * riscrivono per farli tornare. Un ADR con un `§N` scaduto è un documento
 * storico che cita com'era il mondo allora, e correggerlo sarebbe riscrivere
 * la storia — la cosa che `docs/README.md` vieta esplicitamente.
 *
 * Il confine non è fra «file importanti» e «file meno importanti»: è fra ciò
 * che **governa HEAD** e ciò che è **archiviato**.
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(QUI, '..');

const IGNORA = new Set(['node_modules', 'dist', '.git', '.releases', '.codex']);

/**
 * I worktree degli agenti sono copie del repo: analizzarli conterebbe ogni
 * difetto una volta per worktree vivo, e il conto cambierebbe da macchina a
 * macchina.
 *
 * L'esclusione è **relativa a REPO**, e la prima versione non lo era. Con un
 * `p.includes('.claude/worktrees')` su path assoluto questo checker saltava
 * l'intero repository — perché il repository stesso vive dentro
 * `.claude/worktrees/<nome>` quando ci si lavora da un worktree — e passava
 * verde su zero file. Un controllo che non guarda niente non fallisce mai.
 */
function esclusa(rel: string): boolean {
  return rel === '.claude/worktrees' || rel.startsWith('.claude/worktrees/');
}

function tuttiIFile(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORA.has(e.name) || e.name.startsWith('.DS')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (esclusa(relative(REPO, p))) continue;
      tuttiIFile(p, acc);
    } else acc.push(p);
  }
  return acc;
}

/**
 * Archiviato = append-only o datato. Non governa HEAD, non si riscrive.
 *
 * L'elenco nomina sia i path attuali sia quelli verso cui la migrazione li
 * sposta, così una slice che fa `git mv` non deve anche modificare il checker
 * che la sorveglia — che è il modo in cui un controllo si ammorbidisce da solo
 * proprio nel commit in cui servirebbe.
 */
const ARCHIVIATO = [
  /^docs\/history\//,
  /^docs\/foundations\//,
  /^docs\/blueprint\/(adr|research|critique|proposals)\//,
  /^docs\/(decisions|evidence)\//,
  /^docs\/blueprint\/(\d\d-|BRIEF|validazione-contratti|STATE|README)/,
];

/** Materiale vivo: prosa che governa HEAD, codice, tooling e CI. */
const VIVO = [
  /^(AGENTS|CLAUDE|README)\.md$/,
  /^docs\//,
  /^\.claude\//,
  /^\.github\/workflows\//,
  /^(agent|cli|core|connectors|evals|scripts|defaults)\//,
];

const LEGGIBILE = /\.(md|ts|tsx|mjs|js|yml|yaml|json)$/;

function classifica(rel: string): 'vivo' | 'archiviato' | 'fuori' {
  if (!LEGGIBILE.test(rel)) return 'fuori';
  if (!VIVO.some((r) => r.test(rel))) return 'fuori';
  if (ARCHIVIATO.some((r) => r.test(rel))) return 'archiviato';
  return 'vivo';
}

const file = tuttiIFile(REPO)
  .map((p) => relative(REPO, p))
  .filter((p) => classifica(p) === 'vivo')
  // Il digest delle deleghe è rigenerato da `deleghe.mjs`: citarne il contenuto
  // sorveglierebbe l'output di uno script, non una scelta editoriale.
  .filter((p) => !p.startsWith('.claude/deleghe/'))
  .sort();

/**
 * Gli alias con cui i commenti nominano un documento. Sono la forma reale
 * trovata nel repo, non una convenzione desiderata: `PC` e `DAY-1` compaiono
 * decine di volte e ignorarli renderebbe il checker cieco proprio dove il
 * drift è più fitto.
 */
const ALIAS: Record<string, string> = {
  ORCHESTRATION: 'docs/ORCHESTRATION.md',
  PRACTICES: 'docs/PRACTICES.md',
  Practice: 'docs/PRACTICES.md',
  RESEARCH: 'docs/RESEARCH.md',
  JUDGE: 'docs/JUDGE.md',
  BRANCHING: 'docs/BRANCHING.md',
  ROADMAP: 'docs/ROADMAP.md',
  SECURITY: 'docs/SECURITY.md',
  ARCHITECTURE: 'docs/ARCHITECTURE.md',
  'M5-BIS': 'docs/blueprint/M5-BIS.md',
  'DAY-1': 'docs/blueprint/gate1/MANDATO-DAY-1.md',
  MANDATO: 'docs/blueprint/gate1/MANDATO-DAY-1.md',
  PERCORSO: 'docs/blueprint/gate1/PERCORSO-CRITICO.md',
  PC: 'docs/blueprint/gate1/PERCORSO-CRITICO.md',
  LAVORO: 'docs/blueprint/LAVORO.md',
};

/** Un documento vivo cercato per nome file, quando non è fra gli alias. */
function trovaPerNome(nomeFile: string): string | null {
  return file.find((f) => f.endsWith(`/${nomeFile}`) || f === nomeFile) ?? null;
}

function risolviDocumento(nome: string): string | null {
  const pulito = nome.replace(/\.md$/, '');
  if (ALIAS[pulito]) return ALIAS[pulito];
  const adr = /^ADR-(\d{4})$/.exec(pulito);
  if (adr) {
    const dir = ['docs/decisions', 'docs/blueprint/adr'].find((d) => existsSync(join(REPO, d)));
    if (!dir) return null;
    const f = readdirSync(join(REPO, dir)).find((x) => x.startsWith(adr[1]!));
    return f ? `${dir}/${f}` : null;
  }
  return null;
}

/**
 * Le sezioni numerate di un documento: `## 6. Verification profiles`,
 * `## §2 · wait e todo`, `### 4.9 …`. Solo il numero di primo livello, perché
 * è quello che una rinumerazione sposta.
 */
function sezioniNumerate(relPath: string): Set<string> | null {
  const abs = join(REPO, relPath);
  if (!existsSync(abs)) return null;
  const testo = readFileSync(abs, 'utf8');
  return new Set([...testo.matchAll(/^#{2,4} *(?:§)?(\d+)(?:\.\d+)*[.·) ]/gm)].map((m) => m[1]!));
}

/**
 * Slug alla maniera di GitHub: minuscole, via tutto ciò che non è lettera,
 * numero, spazio, `_` o `-`, poi **ogni** spazio diventa un trattino.
 *
 * «Ogni», non «una sequenza»: un titolo con un trattino lungo fra due spazi
 * («A — B») produce due spazi dopo la rimozione della punteggiatura, e quindi
 * `a--b`. Collassarli darebbe `a-b` — un'ancora che sembra giusta, non risolve,
 * e nessuno se ne accorge finché non ci clicca sopra.
 */
function ancoraDi(titolo: string): string {
  return titolo
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

/** I titoli di un documento, come ancore. */
function ancoreDi(relPath: string): Set<string> | null {
  const abs = join(REPO, relPath);
  if (!existsSync(abs)) return null;
  const testo = readFileSync(abs, 'utf8');
  return new Set([...testo.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((m) => ancoraDi(m[1]!)));
}

/** `NOME §N` / `NOME.md § N` / `NOME §4.9`. */
const CITAZIONE = /\b([A-Z][A-Za-z0-9.-]*)\s*§\s*(\d+)(?:\.\d+)*/g;

type Reperto = { file: string; riga: number; testo: string; documento: string };

function citazioni(): Reperto[] {
  const out: Reperto[] = [];
  for (const f of file) {
    const testo = readFileSync(join(REPO, f), 'utf8');
    for (const m of testo.matchAll(CITAZIONE)) {
      const documento = risolviDocumento(m[1]!);
      if (!documento) continue; // non è un riferimento a un documento noto
      out.push({
        file: f,
        riga: testo.slice(0, m.index).split('\n').length,
        testo: m[0]!.replace(/\s+/g, ' ').trim(),
        documento,
      });
    }
  }
  return out;
}

describe('il corpus sorvegliato', () => {
  it('non è vuoto, e contiene i file su cui il drift è stato misurato', () => {
    // Questa è la lezione della prima versione di questo file, resa
    // eseguibile: saltava tutto il repository e passava verde su zero file.
    // Ogni asserzione sotto è un `expect([]).toEqual([])` quando il corpus è
    // vuoto — cioè un verde che non prova niente.
    //
    // Le tre sentinelle non sono decorative: sono i tre tipi di sorgente che
    // il checker deve vedere insieme — codice di prodotto, prosa che governa,
    // e configurazione di CI. Se una classe smettesse di essere raccolta, le
    // altre due terrebbero il test verde da sole.
    expect(file.length).toBeGreaterThan(100);
    for (const sentinella of ['core/turns/store.ts', 'docs/README.md', '.github/workflows/ci.yml']) {
      expect(file, `il corpus non contiene ${sentinella}`).toContain(sentinella);
    }
  });
});

describe('i riferimenti fra documenti', () => {
  it('citano una sezione che esiste', () => {
    const rotti = citazioni()
      .filter((c) => {
        const sezioni = sezioniNumerate(c.documento);
        const n = /§\s*(\d+)/.exec(c.testo)?.[1];
        return !sezioni || !n || !sezioni.has(n);
      })
      .map((c) => `${c.file}:${c.riga} cita «${c.testo}» ma ${c.documento} non ha quella sezione`);

    expect(rotti).toEqual([]);
  });

  it('non citano per posizione un documento che si rinumera', () => {
    // Un documento vivo si edita: inserire una sezione sposta tutte quelle
    // dopo, e ogni citazione `§N` altrove diventa falsa senza che niente
    // fallisca. Un titolo, invece, si sposta insieme al suo contenuto.
    const posizionali = citazioni()
      .filter((c) => classifica(c.documento) === 'vivo')
      .map((c) => `${c.file}:${c.riga} cita «${c.testo}» per posizione; usa il titolo della sezione`);

    expect(posizionali).toEqual([]);
  });
});

describe('le ancore', () => {
  it('risolvono a un titolo che esiste', () => {
    // È la proprietà che rende l'ancora un progresso rispetto al `§N`. Senza
    // di lei si è solo passati da un numero che non risolve a una stringa che
    // non risolve — con in più l'aria di essere semantica.
    const rotte: string[] = [];
    for (const f of file) {
      const testo = readFileSync(join(REPO, f), 'utf8');
      for (const m of testo.matchAll(/\b([A-Za-z0-9][\w.-]*\.md)#([\w\u00C0-\u024F-]+)/g)) {
        const documento = risolviDocumento(m[1]!.replace(/\.md$/, '')) ?? trovaPerNome(m[1]!);
        if (!documento) continue; // documento non noto: lo copre un'altra proprietà
        const ancore = ancoreDi(documento);
        if (!ancore || ancore.has(m[2]!)) continue;
        const riga = testo.slice(0, m.index).split('\n').length;
        rotte.push(`${f}:${riga} cita «${m[1]}#${m[2]}» ma ${documento} non ha quel titolo`);
      }
    }
    expect(rotte).toEqual([]);
  });
});

describe('gli indici', () => {
  it('non elencano file che non esistono', () => {
    // Un indice che promette un file assente manda a vuoto chi lo segue, e
    // dice implicitamente che il lavoro è stato fatto.
    //
    // «Voce d'indice» è deliberatamente stretto: il **nome di file nella prima
    // cella** di una riga di tabella. Una menzione in prosa non lo è — un
    // README può nominare un documento che vive altrove, e la prima versione
    // di questa proprietà segnalava proprio quelle, cioè rumore al posto di un
    // difetto. Una riga di tabella che si apre con un nome di file, invece,
    // sta promettendo un vicino.
    const VOCE = /^\| *`([\w][\w.-]*\.md)` *\|/gm;
    const fantasmi: string[] = [];
    for (const f of file.filter((x) => /README\.md$/.test(x))) {
      const dir = dirname(f);
      const testo = readFileSync(join(REPO, f), 'utf8');
      for (const m of testo.matchAll(VOCE)) {
        const nome = m[1]!;
        if (existsSync(join(REPO, dir, nome))) continue;
        const riga = testo.slice(0, m.index).split('\n').length;
        fantasmi.push(`${f}:${riga} elenca \`${nome}\`, che non esiste in ${dir}/`);
      }
    }
    expect(fantasmi).toEqual([]);
  });
});

describe('i router', () => {
  it('non mandano a STATE.md per lo stato corrente', () => {
    // `STATE.md` è una lapide dal 2026-08-19. Un router che ci manda insegna a
    // una sessione nuova a partire dalla cronologia invece che dall'osservato.
    const router = ['AGENTS.md', 'CLAUDE.md', 'docs/README.md', '.claude/loop.md'].filter((f) =>
      existsSync(join(REPO, f)),
    );
    const colpevoli: string[] = [];
    for (const f of router) {
      for (const riga of readFileSync(join(REPO, f), 'utf8').split('\n')) {
        if (!/STATE\.md/.test(riga)) continue;
        // Nominarlo per dire di NON usarlo è esattamente il suo scopo qui.
        if (/\bnon\b|\bnot\b|\bmai\b|\bnever\b|tombstone|lapide|chronicle|cronologia/i.test(riga)) continue;
        colpevoli.push(`${f}: ${riga.trim()}`);
      }
    }
    expect(colpevoli).toEqual([]);
  });
});
