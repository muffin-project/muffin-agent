/**
 * I quattro frammenti puri condivisi dalle due porte di merge — lo hook
 * slice→dev (`.claude/hooks/guard-merge-gate.mjs`) e la promozione dev→main
 * (`scripts/promote.ts`). Una sola implementazione, due chiamanti: la logica
 * di PR/base/antenato/promozione resta separata in ciascuno, qui c'e' solo la
 * semantica di valutazione dell'evidenza. Niente I/O, niente rete: ogni ramo
 * dubbio e' un dato che il chiamante trasforma in rifiuto, mai un'eccezione.
 */

/**
 * L'insieme esentato da `ci.yml` (`paths-ignore` del trigger `pull_request`).
 * Parita' esatta, non interpretazione: `docs/**` e `.claude/**` corrispondono
 * ai path sotto quelle directory, i tre nomi ai file in root. Se `ci.yml`
 * cambia il suo ignore, cambiare anche qui (e i test che lo pinnano).
 */
export function isExemptPath(path) {
  if (path === 'README.md' || path === 'AGENTS.md' || path === 'CLAUDE.md') return false;
  if (path.startsWith('docs/') || path.startsWith('.claude/')) return false;
  return true;
}

/** Nome del check-run con eventuale prefisso `<workflow> /` tolto (dal vivo i nomi sono nudi, ma non si giura). */
export function nudeName(name) {
  const i = name.lastIndexOf('/');
  return (i === -1 ? name : name.slice(i + 1)).trim();
}

/**
 * Ultimo run per nome nudo: i rerun non resuscitano un rosso vecchio.
 * Ritorna la mappa nome → `{ at, run }`.
 */
export function latestPerName(runs) {
  const latest = new Map();
  for (const run of runs) {
    if (run?.name === undefined) continue;
    const at = Date.parse(run.completed_at ?? run.started_at ?? 0) || 0;
    const key = nudeName(run.name);
    if ((latest.get(key)?.at ?? -1) <= at) latest.set(key, { at, run });
  }
  return latest;
}

/**
 * Valuta i check correnti contro i nomi richiesti. Ordine fisso: assenza
 * totale, pendenti, rossi, richiesti mancanti/non-success. `skipped` e
 * `neutral` non bloccano i sidecar ma non soddisfano mai un nome richiesto.
 */
export function evaluateChecks(runs, required) {
  const latest = latestPerName(runs);
  const current = [...latest.values()].map((v) => v.run);
  if (current.length === 0) return { ok: false, kind: 'empty', names: [] };
  const pending = current.filter((r) => r.status !== 'completed').map((r) => r.name);
  if (pending.length > 0) return { ok: false, kind: 'pending', names: pending };
  const bad = current
    .filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))
    .map((r) => `${r.name} (${r.conclusion})`);
  if (bad.length > 0) return { ok: false, kind: 'red', names: bad };
  const missing = required.filter((n) => latest.get(n)?.run?.conclusion !== 'success');
  if (missing.length > 0) return { ok: false, kind: 'missing', names: missing };
  return { ok: true, kind: 'pass', names: [] };
}

/**
 * Eccezione docs-only, fail-closed. Vale solo con completezza provata:
 * `gh pr view --json files` tronca silenziosamente oltre 100 voci (bug
 * upstream aperto), quindi `files.length === changedFiles` deve tenere —
 * conteggio diverso, assente o illeggibile chiude, senza paginazione eroica.
 */
export function classifyDocsOnly(files, changedFiles) {
  if (!Array.isArray(files) || typeof changedFiles !== 'number' || files.length !== changedFiles) {
    return {
      ok: false,
      reason: 'incomplete',
      got: Array.isArray(files) ? files.length : null,
      want: typeof changedFiles === 'number' ? changedFiles : null,
    };
  }
  const outside = [];
  for (const f of files) {
    const path = typeof f === 'string' ? f : f?.path;
    if (typeof path !== 'string' || isExemptPath(path)) outside.push(String(path));
  }
  if (outside.length > 0) return { ok: false, reason: 'outside', offending: outside };
  return { ok: true, reason: 'exempt', count: files.length };
}
