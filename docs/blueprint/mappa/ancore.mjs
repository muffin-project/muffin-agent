#!/usr/bin/env node
/**
 * Rigenera `ancore.json` leggendo il codice puntato dalla mappa.
 *
 * La mappa (`docs/blueprint/mappa/*.json`) è una **vista derivata**: descrive la
 * parte del sistema che cambia di più e non ha un compilatore che la corregga.
 * Il meccanismo che le impedisce di mentire non è un promemoria ma questo:
 * ogni riferimento `file:riga` che compare nella mappa viene risolto qui, e il
 * testo di quella riga viene registrato. `mappa.test.ts` poi verifica che il
 * testo sia ancora lì — quando il codice si sposta, fallisce la suite.
 *
 * Uso:
 *   node docs/blueprint/mappa/ancore.mjs          # rigenera
 *   node docs/blueprint/mappa/ancore.mjs --check  # esce 1 se è cambiato
 *
 * ORCHESTRATION.md §14.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPPA = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(MAPPA, '..', '..', '..');
const OUT = join(MAPPA, 'ancore.json');

/**
 * Un riferimento è `percorso/relativo.ext:riga`, con percorso relativo alla
 * radice del repo così l'ancora resta valida da qualunque worktree.
 *
 * Cerca **dentro** le stringhe, non le confronta per intero: i riferimenti veri
 * arrivano in tre forme che una corrispondenza esatta perderebbe — intervalli
 * (`loop.ts:374-443`, si ancora alla prima riga), riferimenti multipli separati
 * da `;`, e citazioni immerse nella prosa. L'estensione obbligatoria è ciò che
 * distingue un'ancora da una data o da un `ADR-0038`.
 */
const REF = /([\w./@-]+\.(?:ts|tsx|mjs|js|md|json|sql|yml|yaml|sh)):(\d+)(?:-\d+)?/g;

/** Ogni stringa della mappa, a qualsiasi profondità, senza assumere uno schema. */
function* strings(node) {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const v of node) yield* strings(v);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) yield* strings(v);
}

export function mapFiles() {
  return readdirSync(MAPPA)
    .filter((f) => f.endsWith('.json') && f !== 'ancore.json')
    .sort()
    .map((f) => join(MAPPA, f));
}

/** Tutti i riferimenti citati dalla mappa, deduplicati e ordinati. */
/**
 * La cartella di casa di ogni sezione della mappa.
 *
 * Chi estrae i tool scrive `mcp.ts:102` intendendo `agent/tools/mcp.ts`; chi
 * estrae le superfici, con la stessa scrittura, intende `cli/mcp.ts`. Nessuno
 * dei due sbaglia: dentro un documento che parla dei tool, `mcp.ts` **è** il
 * tool. Il contesto rende risolvibile ciò che il nome da solo non risolve,
 * senza toccare la regola che conta — un nome che resta ambiguo anche col
 * contesto fallisce, e due sezioni che risolvono lo stesso nome in file diversi
 * falliscono pure.
 */
const CONTESTO = {
  'data-tools.json': ['agent/tools'],
  'data-loop.json': ['agent', 'agent/providers', 'agent/context'],
  'data-policy.json': ['core/policy', 'core/vault', 'core/session', 'core/rot', 'core/sandbox', 'core/net', 'core/budget', 'core/tracing'],
  'data-memory.json': ['core/memory'],
  'data-surfaces.json': ['cli', 'core/gateway', 'core/skills', 'core/mcp', 'core/config', 'connectors/telegram'],
};

/** Ogni riferimento citato, con i file della mappa che lo citano. */
export function references() {
  const found = new Map();
  for (const file of mapFiles()) {
    const nome = file.slice(file.lastIndexOf('/') + 1);
    for (const s of strings(JSON.parse(readFileSync(file, 'utf8')))) {
      for (const m of s.matchAll(REF)) {
        const ref = `${m[1]}:${m[2]}`;
        found.set(ref, (found.get(ref) ?? new Set()).add(nome));
      }
    }
  }
  return new Map([...found.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const IGNORA = new Set(['node_modules', 'dist', '.git', 'worktrees', 'coverage']);

/**
 * Indice `nomefile → percorsi`, per risolvere i riferimenti scritti in prosa.
 *
 * La mappa cita spesso `loop.ts:299` invece di `agent/loop.ts:299`, che è come
 * si parla di un file mentre lo si legge. Risolvere il nome corto è comodo, ma
 * il valore vero è l'altro: **un nome che diventa ambiguo fallisce**. Il giorno
 * in cui nasce un secondo `loop.ts` la mappa smette di compilare, invece di
 * puntare al file sbagliato con la stessa faccia sicura.
 */
let indice = null;
function basenameIndex(dir = REPO, out = new Map()) {
  if (indice) return indice;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    if (IGNORA.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) basenameIndex(full, out);
    else {
      const rel = full.slice(REPO.length + 1);
      out.set(e.name, [...(out.get(e.name) ?? []), rel]);
    }
  }
  if (dir === REPO) indice = out;
  return out;
}

/**
 * Il percorso, la riga e il testo puntati — o il motivo per cui non ci sono.
 *
 * `sezioni` sono i file della mappa che citano il riferimento: servono solo a
 * risolvere i nomi corti, e solo restringendo, mai allargando.
 */
export function resolveRef(ref, sezioni = []) {
  const cut = ref.lastIndexOf(':');
  const written = ref.slice(0, cut);
  const line = Number(ref.slice(cut + 1));

  let path = written;
  if (!written.includes('/')) {
    let hits = basenameIndex().get(written) ?? [];
    if (hits.length === 0) return { ok: false, reason: 'nessun file con questo nome' };
    if (hits.length > 1) {
      // In ordine, non per unicità: una sezione elenca le sue cartelle dalla
      // più centrale alla più periferica, e `types.ts` dentro la sezione del
      // kernel è il tipo del kernel, non quello del tracer che sta lì accanto.
      const casa = [...new Set(sezioni.flatMap((s) => CONTESTO[s] ?? []))];
      for (const dir of casa) {
        const dentro = hits.filter((h) => h.slice(0, h.lastIndexOf('/')) === dir);
        if (dentro.length === 1) {
          hits = dentro;
          break;
        }
      }
    }
    if (hits.length > 1) {
      return { ok: false, reason: `nome ambiguo, ${hits.length} file: ${hits.join(', ')} — scrivi il percorso` };
    }
    path = hits[0];
  }

  let lines;
  try {
    lines = readFileSync(join(REPO, path), 'utf8').split('\n');
  } catch {
    return { ok: false, reason: 'file assente' };
  }
  if (line < 1 || line > lines.length) {
    return { ok: false, reason: `riga fuori dal file (${lines.length} righe)` };
  }
  return { ok: true, path, line, text: lines[line - 1].trim() };
}

function build() {
  const anchors = {};
  const broken = [];
  for (const [ref, sezioni] of references()) {
    // Risolto una sezione alla volta: se due sezioni intendono file diversi con
    // la stessa scrittura, l'ancora non esiste — e va detto, non scelto.
    const esiti = new Map();
    for (const s of sezioni) {
      const r = resolveRef(ref, [s]);
      esiti.set(r.ok ? r.path : `✗ ${r.reason}`, r);
    }
    if (esiti.size > 1) {
      broken.push(`${ref} — risolto diversamente da ${[...sezioni].join(' e ')}: ${[...esiti.keys()].join(' vs ')}`);
      continue;
    }
    const r = [...esiti.values()][0];
    if (r.ok) anchors[ref] = { path: r.path, line: r.line, testo: r.text };
    else broken.push(`${ref} — ${r.reason}`);
  }
  return { anchors, broken };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { anchors, broken } = build();
  const next = `${JSON.stringify(anchors, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      /* prima esecuzione */
    }
    if (current !== next) {
      console.error('ancore.json non è aggiornato — esegui `node docs/blueprint/mappa/ancore.mjs`');
      process.exit(1);
    }
    console.log(`ancore.json aggiornato: ${Object.keys(anchors).length} ancore`);
  } else {
    writeFileSync(OUT, next);
    console.log(`${Object.keys(anchors).length} ancore scritte in ancore.json`);
  }
  if (broken.length) {
    console.error(`\n${broken.length} riferimenti rotti nella mappa:`);
    for (const b of broken) console.error(`  ${b}`);
    process.exit(1);
  }
}
