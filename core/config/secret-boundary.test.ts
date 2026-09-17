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
  'evals/character/con-la-chiave.ts':
    'launches the character eval with the installation model key in the CHILD ENV only — run.ts refuses to read ~/.muffin by design, and the key never touches argv or disk (same shape as evals/e2e/telegram.ts)',
  /**
   * Aggiunto il 27/08/2026, e la decisione è sulla **sonda**, non sul comando.
   *
   * `muffin model embed <slug>` esiste per togliere l'unico indovinello che lo
   * schema di config dichiara di non poter difendere: `embedder.dimensions`
   * «è cotta nella tabella vettoriale, quindi indovinarla sbagliata significa
   * un indice che si rifà da solo». Il solo modo di misurarla invece di
   * chiederla è **chiamare l'embedder** e guardare `vector.length` — e un
   * embedder `openai-compat` ha bisogno della sua chiave.
   *
   * Il valore va dritto in `makeEmbedder`, che lo passa al costruttore che lo
   * mette sul filo: stessa forma di `agent/runtime.ts`, nessuna struttura
   * intermedia lo tiene, niente lo stampa, e il comando non lo vede mai —
   * passa una funzione, non una stringa.
   *
   * L'altra chiamata in questo file (`keyOf`, per il catalogo dei modelli) su
   * OpenRouter **non scatta**: `catalogueNeedsKey` è `false` perché quel
   * `GET /models` risponde 200 senza `Authorization` (verificato sul vivo il
   * 27/08). Il campo esiste per il provider che un giorno la pretenderà, e
   * fino ad allora nessun segreto viene risolto per elencare dei modelli.
   */
  'cli/model.ts':
    "probes the configured embedder to MEASURE its dimension instead of asking the owner to guess it — the key goes straight into makeEmbedder's constructor and onto the wire; the model catalogue path resolves nothing on OpenRouter (catalogueNeedsKey: false)",
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
  /**
   * Aggiunto il 04/09/2026, e la decisione e' sul **verso**: qui il segreto
   * non esce dall'installazione, ci **rientra**.
   *
   * `evals/e2e/telegram.ts` costruisce una home usa-e-getta e ci installa
   * dentro Muffin da capo. Prima chiedeva tre segreti nell'ambiente, e due
   * l'installazione li aveva gia' sul disco — cioe' proponeva un `.env` a una
   * macchina che ha un vault, che e' il modo piu' rapido per far finire una
   * chiave in un file che nessuno ruota. Leggerli dal vault e' la porta
   * stretta, non una in piu'.
   *
   * I due sink sono entrambi la CLI, e via **stdin**, mai argv (direttiva
   * owner 2026-08-18): `muffin init` per la chiave del provider e
   * `muffin secret set telegram_token` per il bot. Nessuna struttura
   * intermedia li tiene, il filo che questo banco registra li redige, e lo
   * script non ne stampa un carattere.
   *
   * Stessa forma di `evals/floor/run.ts` qui sotto, con una differenza a
   * favore: quello mette la chiave sul filo verso il provider, questo la
   * consegna a un binario che la scrive in un file 0600 e la richiude.
   */
  'evals/e2e/telegram.ts':
    'installa una home usa-e-getta: chiave del provider a `muffin init` e token a `muffin secret set`, entrambi da stdin, mai da argv',
  'evals/floor/run.ts': 'runs the real loop against the real model — the key goes straight into the provider constructor and onto the wire, same shape as agent/runtime.ts; env vars still win, this is the fallback so nobody has to paste a secret into a shell to measure something',
  /**
   * Aggiunto il 18/09/2026 per l'A/B sull'execution policy (issue #498).
   *
   * Stessa forma di `evals/character/con-la-chiave.ts` qui sopra, riga per
   * riga: la chiave dell'installazione passa solo nell'ambiente del figlio
   * (`MUFFIN_AB_KEY`), mai in argv, mai su disco fuori dalla home usa-e-getta
   * che il pilot rimuove alla fine. Senza questo, misurare costringerebbe a
   * esportare la chiave a mano in una shell.
   */
  'evals/reasoning-ab/con-la-chiave.ts':
    'launches the reasoning A/B pilot with the installation model key in the CHILD ENV only — run.ts never reads ~/.muffin by design, and the key never touches argv (same shape as evals/character/con-la-chiave.ts)',
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
