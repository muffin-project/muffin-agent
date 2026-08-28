import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { tenantClass, type PromptBlock, type TenantClass } from '../agent/context/assemble.js';
import { caratteriInEco, eco } from '../agent/context/eco.js';
import { buildRuntime } from '../agent/runtime.js';
import { paths } from '../core/config/config.js';
import type { Principal, TenantId } from '../core/policy/types.js';
import { sha256 } from '../core/rot/verify.js';
import { redactText } from '../core/tracing/redact.js';

/**
 * `muffin prompt show` — what the model would really receive, not a
 * reconstruction of it.
 *
 * Named `cli/prompt-show.ts` rather than reusing `cli/prompt.ts`: that file is
 * `promptSecret`/`promptLine`, the TTY input helpers `cmdInit`/`cmdUninstall`
 * use to ask a question on stdin — a name collision with nothing in common.
 *
 * The one property this command exists to prove: it calls `buildRuntime`, the
 * exact function every surface calls, and reads `deps.systemPrompts` off the
 * `Runtime` it returns — the same object `agent/loop.ts:996` sends to the
 * provider (`system: [{ type: 'text', text: deps.systemPrompts[turnClass], ...`).
 * There is no second assembly here to describe production; drift between "what
 * this prints" and "what a turn sends" is exactly what `cli/prompt-show.test.ts`
 * and the A2/A3 acceptance scenario mutate for.
 *
 * House rule: stdout is the result (the prompt text, and nothing else, so
 * `muffin prompt show > snapshot.txt` is a sane thing to pipe), stderr is
 * every explanation — home, surface, class, size, and the two placeholders
 * for what is deliberately not shown (recall, the live tool list).
 */

export const PROMPT_USAGE = `usage: muffin prompt show [--surface cli|telegram|discord] [--member] [--tenant ID] [--blocks]
  stampa il system prompt che il modello riceverebbe davvero, sulla home corrente.
  --surface   surface simulata, solo per scegliere principal/tenant di default (default: cli)
  --member    simula un membro di un gruppo invece dell'owner (classe "group")
  --tenant    tenant esplicito (default: host; con --member, group:<surface>:preview)
  --blocks    annota il testo con intestazioni di provenienza e sha256 per blocco —
              l'output NON è più byte-identico al prompt reale, solo per ispezione
  --eco       invece del prompt, le affermazioni che compaiono in più di un blocco:
              la stessa regola detta due o quattro volte in registri diversi
`;

const SURFACES = ['cli', 'telegram', 'discord'] as const;
/** Ref-shaped strings the config schema recognises (`core/config/config.ts requireSecretRef`). Belt-and-suspenders: production never puts one in a prompt file, but a pasted key would print verbatim otherwise. */
const SECRET_REF = /secret:\/\/[A-Za-z0-9_]+/g;

function redactPrompt(text: string): string {
  return redactText(text).replace(SECRET_REF, (match) => `«redacted:${match.length}»`);
}

export function cmdPromptShow(home: string, argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      surface: { type: 'string' },
      member: { type: 'boolean' },
      tenant: { type: 'string' },
      blocks: { type: 'boolean' },
      eco: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const surface = values.surface ?? 'cli';
  if (!(SURFACES as readonly string[]).includes(surface)) {
    process.stderr.write(`--surface deve essere ${SURFACES.join('|')} (ricevuto: ${surface})\n`);
    return 78;
  }

  const isMember = values.member === true;
  const tenant: TenantId = values.tenant ?? (isMember ? `group:${surface}:preview` : 'host');
  // The same two fields `tenantClass` (agent/context/assemble.ts) actually
  // reads — nothing else about a principal changes which prompt a turn gets.
  const principal: Principal = isMember
    ? { kind: 'member', connector: surface, tenantId: tenant, externalId: 'preview' }
    : { kind: 'owner', connector: surface, externalId: 'preview' };
  const cls: TenantClass = tenantClass(principal, tenant);

  let runtime;
  try {
    runtime = buildRuntime(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    if (runtime.safeMode) {
      process.stderr.write(
        `! safe mode: root of trust diverso (${runtime.safeMode.reason}: ${runtime.safeMode.diverged.join(', ')}) — ` +
          `il prompt sotto è quello che il modello riceve davvero in questo stato, capability sopra 'low' negate\n`,
      );
    }

    const prompt = runtime.deps.systemPrompts[cls];
    const charCount = prompt.length;
    // 4 char/token is the same rough constant `evals/acceptance/provider.ts
    // tokensOf` uses for its fake billing — not a tokenizer, an order of
    // magnitude, said as one.
    const approxTokens = Math.ceil(charCount / 4);

    process.stderr.write(
      `home: ${home}\n` +
        `surface: ${surface} · principal: ${principal.kind} · tenant: ${tenant} · classe: ${cls}\n` +
        `${charCount} caratteri, ~${approxTokens} token stimati (4 char/token, non un tokenizer reale)\n` +
        `[memoria] il recall non è nel system prompt: entra nei messages a ogni turno (agent/loop.ts buildContext) — qui non è mostrato\n` +
        `[tool] ${runtime.deps.tools.length} tool registrati in questo processo; quali sono esposti al turno dipende da principal e profilo (agent/context/assemble.ts visibleTools), non da questo comando\n`,
    );

    if (values.eco === true) {
      process.stdout.write(`${renderEco(runtime.promptBlocks[cls], charCount)}\n`);
    } else if (values.blocks) {
      process.stdout.write(`${renderBlocks(home, runtime.promptBlocks[cls])}\n`);
    } else {
      process.stdout.write(`${redactPrompt(prompt)}\n`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

/**
 * The installed file behind a block's `source`, for `--blocks`' sha256 —
 * `null` for a block whose source is code or a generated catalogue.
 *
 * Keyed on `source`, deliberately not on `block.name`: the group class has a
 * block named `persona` too, and its source is `GROUP_PERSONA` — a string
 * literal in `agent/context/assemble.ts`, not `persona.md`. Keying on the name
 * alone hashed `persona.md` for that block regardless — a real file's hash
 * printed next to text that file never produced, caught by actually running
 * `--surface telegram --member --blocks` rather than by reading the code.
 */
function blockFile(home: string, source: string): string | null {
  const p = paths(home);
  if (source === 'persona.md') return p.persona;
  if (source === 'rot/identity.md') return join(p.rot, 'identity.md');
  if (source === 'voice.md') return p.voice;
  return null;
}

function renderBlocks(home: string, blocks: readonly PromptBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.text.length === 0) continue; // an absent file, an empty skills catalogue, safe mode off
    const file = blockFile(home, block.source);
    const provenance =
      file && existsSync(file) ? `${block.source}, sha256 ${sha256(readFileSync(file)).slice(0, 12)}` : block.source;
    parts.push(`--- blocco: ${block.name} (${provenance}) ---\n${redactPrompt(block.text)}`);
  }
  return parts.join('\n\n');
}

/**
 * Il rapporto sull'eco.
 *
 * Non decide niente e non propone tagli: dice quali affermazioni si ripetono
 * fra blocchi e quanto prompt è coinvolto. La decisione su quale delle due
 * copie tenere dipende da quale blocco *possiede* quel tema, ed è una cosa che
 * sa chi legge, non una soglia.
 *
 * `identity.md` merita una nota a parte ed è il motivo per cui la sorgente si
 * stampa sempre: è sigillato sotto `rot/`, quindi in ogni coppia che lo tocca
 * il lato da tagliare è **l'altro**. Non c'è una scelta da fare lì.
 */
function renderEco(blocchi: readonly PromptBlock[], caratteriTotali: number): string {
  const presenti = blocchi.filter((b) => b.text.length > 0);
  const trovate = eco(presenti);
  if (trovate.length === 0) return 'Nessuna eco sopra soglia fra i blocchi.';

  const inEco = caratteriInEco(trovate);
  const quota = Math.round((inEco / caratteriTotali) * 100);
  const righe = [
    `${trovate.length} coppie sopra soglia; ${inEco} caratteri su ${caratteriTotali} (${quota}%) stanno in affermazioni ripetute altrove.`,
    '',
  ];
  for (const e of trovate) {
    righe.push(`${Math.round(e.somiglianza * 100)}%  ${e.a.blocco} ↔ ${e.b.blocco}`);
    righe.push(`      ${e.a.blocco}: ${e.a.testo}`);
    righe.push(`      ${e.b.blocco}: ${e.b.testo}`);
    righe.push('');
  }
  return righe.join('\n').trimEnd();
}
