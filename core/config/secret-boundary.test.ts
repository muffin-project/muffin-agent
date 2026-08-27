import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0048's structural claim, pinned as a fact about the source tree rather
 * than argued in a comment: *"a secret value known to the backend
 * (`readSecret`) is materialized only inside the privileged sink authorized
 * to need it."* That is provable exactly because `readSecret` has so few
 * callers — a resolved key never reaches a tool's args or result, an
 * approval resource, or `turns`/sessions, because nothing on any of those
 * paths ever calls it. The proof is this list staying complete: if it stops
 * matching, either a new sink was added on purpose (extend the allowlist and
 * say why in the same PR) or a secret just gained a way to leave a sink that
 * was never reviewed for it.
 *
 * Owner, 2026-08-17: *"un secret value conosciuto non entra mai nel data
 * plane generale di Muffin. Viene materializzato solo nel sink privilegiato
 * autorizzato che ne ha bisogno."*
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every production file allowed to call `readSecret`, and what it is the
 * privileged sink for. Adding a file here is a real decision — it is saying
 * "this code may hold a resolved secret" — not a formality, so each entry
 * names the sink it resolves for.
 */
const ALLOWED_CALLERS: Readonly<Record<string, string>> = {
  'agent/runtime.ts': 'builds the model provider and the search backend — the key is passed straight into the SDK/fetch client that puts it on the wire, never stored in a variable of its own',
  'cli/surface.ts': 'builds TelegramApi/DiscordApi at pairing/setup time, and one existence check (hasSecret) that discards the value',
  'cli/doctor.ts': 'diagnostic: reports backend, path and byte length only — never a character of the value (see doctor.test.ts)',
  'core/mcp/connect.ts': "resolves a server's `secret://` env refs at spawn time — the value goes into the child's environment (never argv, never the registry on disk) and no intermediate structure holds it",
  /**
   * Aggiunto il 27/08/2026, ed è una decisione sul confine, non una formalità.
   *
   * L'eval del floor **è** un sink privilegiato nel senso di ADR-0048: la sua
   * ragione di esistere è chiamare il modello vero, quindi la chiave va dritta
   * nel costruttore di `OpenAICompatProvider` e da lì sul filo, esattamente
   * come in `agent/runtime.ts`. Nessuna struttura intermedia la tiene, niente
   * la stampa, e resta un `const` in cima al file.
   *
   * L'alternativa era peggio per l'owner, non migliore: senza questo,
   * misurare qualcosa richiede di esportare la chiave a mano in una shell —
   * dove finisce nella history e nella process table. È lo stesso pericolo che
   * `AGENTS.md` vieta per argv, spostato di un metro.
   *
   * L'ambiente resta primo: questo è il fallback, e serve a non chiedere di
   * nuovo una chiave che l'installazione ha già.
   */
  'evals/floor/run.ts': 'runs the real loop against the real model — the key goes straight into the provider constructor and onto the wire, same shape as agent/runtime.ts; env vars still win, this is the fallback so nobody has to paste a secret into a shell to measure something',
};

/** Files matching this are never walked for callers: tests exercise the primitive on purpose. */
const isTestFile = (name: string): boolean => name.endsWith('.test.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !isTestFile(entry.name)) out.push(full);
  }
  return out;
}

describe('readSecret has a fixed, small set of callers', () => {
  const CALL = /\breadSecret\s*\(/;
  const DEFINITION_FILE = 'core/config/config.ts';

  const callers = walk(ROOT)
    .map((f) => relative(ROOT, f))
    .filter((f) => f !== DEFINITION_FILE)
    .filter((f) => CALL.test(readFileSync(join(ROOT, f), 'utf8')))
    .sort();

  it('matches the reviewed allowlist exactly — a new caller is a decision, not a drift', () => {
    expect(callers).toEqual(Object.keys(ALLOWED_CALLERS).sort());
  });

  it('no tool handler under agent/tools/ ever resolves a secret', () => {
    const toolFiles = walk(join(ROOT, 'agent', 'tools')).map((f) => relative(ROOT, f));
    const offenders = toolFiles.filter((f) => CALL.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders, 'a tool file calls readSecret — a resolved value could reach args/results').toEqual([]);
  });

  it('no connector calls readSecret directly — the token arrives already resolved, from cli/surface.ts', () => {
    const connectorFiles = walk(join(ROOT, 'connectors')).map((f) => relative(ROOT, f));
    const offenders = connectorFiles.filter((f) => CALL.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the turn/session/tracing write paths never resolve a secret either', () => {
    const files = [
      ...walk(join(ROOT, 'core', 'turns')),
      ...walk(join(ROOT, 'core', 'session')),
      ...walk(join(ROOT, 'core', 'tracing')),
    ].map((f) => relative(ROOT, f));
    const offenders = files.filter((f) => CALL.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
