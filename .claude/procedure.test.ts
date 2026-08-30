import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Skill e rules sono la superficie con cui Claude Code carica una procedura nel
 * momento in cui serve. Hanno una proprietà scomoda: **falliscono in silenzio**.
 *
 * Una skill con il frontmatter malformato non viene offerta e nessuno lo nota —
 * si nota l'assenza di un comando, mesi dopo, e si dà la colpa al modello. Una
 * rule con un glob che non corrisponde a niente non si carica mai, e sembra
 * attiva. Un rimando a un documento che nel frattempo si è spostato porta a
 * vuoto esattamente quando la procedura serviva.
 *
 * Queste asserzioni sono la ragione per cui `.github/workflows/strumenti.yml`
 * può includere `.claude/rules/**` e `.claude/skills/**` nei suoi `paths`: quel
 * job copre «i file di `.claude/` che un test copre», e senza questo file
 * girerebbe senza provare niente.
 *
 * **Cosa NON provano.** Che il rimando risolva non dice che la skill sia un
 * invocatore sottile: è reference integrity, non una misura di *thinness*. Che
 * il corpo rimandi al documento invece di ricopiarlo resta una scelta
 * editoriale, e non le si costruisce sopra un framework per dimostrarla.
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(QUI, '..');
const SKILLS = join(QUI, 'skills');
const RULES = join(QUI, 'rules');

/** Il blocco YAML iniziale, se il file comincia esattamente con `---`. */
function frontmatter(testo: string): string | null {
  if (!testo.startsWith('---\n')) return null;
  const fine = testo.indexOf('\n---', 3);
  return fine === -1 ? null : testo.slice(4, fine);
}

const skillFile = existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ nome: e.name, path: join(SKILLS, e.name, 'SKILL.md') }))
  : [];

const ruleFile = existsSync(RULES)
  ? readdirSync(RULES)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ nome: f, path: join(RULES, f) }))
  : [];

describe('le skill di progetto', () => {
  it('esistono e sono quelle attese', () => {
    // Senza questa riga ogni asserzione sotto è vera su zero file.
    expect(skillFile.map((s) => s.nome).sort()).toEqual(['giudice', 'riprendi', 'sfida']);
  });

  it('hanno un SKILL.md con frontmatter e una description', () => {
    const rotte: string[] = [];
    for (const s of skillFile) {
      if (!existsSync(s.path)) {
        rotte.push(`${s.nome}: manca SKILL.md`);
        continue;
      }
      const testo = readFileSync(s.path, 'utf8');
      const fm = frontmatter(testo);
      // Claude Code legge il frontmatter solo se `---` è la **prima** riga del
      // file; altrimenti tratta tutto, marcatori inclusi, come corpo — e la
      // skill perde la description con cui verrebbe scelta.
      if (fm === null) rotte.push(`${s.nome}: il frontmatter non apre alla prima riga`);
      else if (!/^description:\s*\S/m.test(fm)) rotte.push(`${s.nome}: nessuna description`);
    }
    expect(rotte).toEqual([]);
  });
});

describe('le rules di progetto', () => {
  it('sono path-scoped, e il loro glob corrisponde a qualcosa', () => {
    // Una rule senza `paths` si carica a ogni sessione: sarebbe `CLAUDE.md` con
    // un altro nome, e questo repo ha appena finito di togliere quel peso.
    // Una rule con un glob che non corrisponde a niente non si carica mai, e la
    // differenza fra le due non si vede leggendola.
    const rotte: string[] = [];
    for (const r of ruleFile) {
      const fm = frontmatter(readFileSync(r.path, 'utf8'));
      if (fm === null) {
        rotte.push(`${r.nome}: nessun frontmatter`);
        continue;
      }
      const globs = [...fm.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1]!.trim());
      if (!/^paths:/m.test(fm) || globs.length === 0) {
        rotte.push(`${r.nome}: nessun \`paths:\` — si caricherebbe sempre`);
        continue;
      }
      for (const g of globs) {
        // Prefisso letterale del glob: basta a dire se punta a una zona che
        // esiste, senza portarsi dentro un matcher di glob per un'asserzione.
        const letterale = g.split(/[*?[]/)[0]!.replace(/\/$/, '');
        if (letterale && !existsSync(join(REPO, letterale))) {
          rotte.push(`${r.nome}: il glob \`${g}\` non corrisponde a niente nel repo`);
        }
      }
    }
    expect(rotte).toEqual([]);
  });
});

describe('i rimandi di skill e rules', () => {
  it('puntano a documenti che esistono', () => {
    // Una skill è un invocatore: il suo valore è il documento a cui manda. Se
    // quel path si sposta — e le slice della migrazione ne sposteranno molti —
    // la skill continua a caricarsi e manda a vuoto.
    const rotti: string[] = [];
    for (const f of [...skillFile, ...ruleFile]) {
      if (!existsSync(f.path)) continue;
      const testo = readFileSync(f.path, 'utf8');
      for (const m of testo.matchAll(/`(docs\/[A-Za-z0-9._/-]+\.md)`/g)) {
        if (!existsSync(join(REPO, m[1]!))) rotti.push(`${f.nome} rimanda a ${m[1]}, che non esiste`);
      }
    }
    expect(rotti).toEqual([]);
  });
});

describe('il prompt di manutenzione', () => {
  it('resta un prompt e non ridiventa un manuale', () => {
    // `.claude/loop.md` è il default prompt di un `/loop` nudo, e ogni giro lo
    // paga per intero. Fino al 2026-08-30 conteneva l'intero metodo di sviluppo
    // — challenge pass, startup, disclosure, profili, scope firewall, chiusura —
    // cioè sette sezioni che appartengono ad altri documenti.
    //
    // Il tetto è la stessa difesa che porta `AGENTS.md`, contro la stessa
    // regressione: un file così ricresce una riga utile per volta, e nessuno
    // decide mai di ripagare la tassa.
    const parole = readFileSync(join(QUI, 'loop.md'), 'utf8').trim().split(/\s+/).length;
    expect(parole, `.claude/loop.md ha ${parole} parole`).toBeLessThanOrEqual(250);
  });
});
