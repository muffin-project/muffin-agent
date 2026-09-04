import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { tenantClass, type PromptBlock, type TenantClass } from '../agent/context/assemble.js';
import { caratteriInEco, eco } from '../agent/context/eco.js';
import { buildRuntime } from '../agent/runtime.js';
import {
  loadConfig,
  promptVersion,
  PROMPT_VERSIONS,
  saveConfig,
  type PromptVersion,
} from '../core/config/config.js';
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
       muffin prompt version [v1|v2]
  stampa il system prompt che il modello riceverebbe davvero, sulla home corrente.
  --surface   surface simulata, solo per scegliere principal/tenant di default (default: cli)
  --member    simula un membro di un gruppo invece dell'owner (classe "group")
  --tenant    tenant esplicito (default: host; con --member, group:<surface>:preview)
  --blocks    annota il testo con intestazioni di provenienza e sha256 per blocco —
              l'output NON è più byte-identico al prompt reale, solo per ispezione
  --eco       invece del prompt, le affermazioni che compaiono in più di un blocco:
              la stessa regola detta due o quattro volte in registri diversi

  version     senza argomento stampa la versione del prompt attiva; con v1 o v2
              la scrive in config.json (campo prompt.version). Il default resta
              v1: nessuna installazione passa a v2 da sola.
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
        `versione prompt: ${promptVersion(loadConfig(home))} (config.prompt.version; \`muffin prompt version v1|v2\` la cambia)\n` +
        `${charCount} caratteri, ~${approxTokens} token stimati (4 char/token, non un tokenizer reale)\n` +
        `[memoria] il recall non è nel system prompt: entra nei messages a ogni turno (agent/loop.ts buildContext) — qui non è mostrato\n` +
        `[tool] ${runtime.deps.tools.length} tool registrati in questo processo; quali sono esposti al turno dipende da principal e profilo (agent/context/assemble.ts visibleTools), non da questo comando\n`,
    );

    if (values.eco === true) {
      process.stdout.write(`${renderEco(runtime.promptBlocks[cls], charCount)}\n`);
    } else if (values.blocks) {
      process.stdout.write(`${renderBlocks(runtime.promptBlocks[cls])}\n`);
    } else {
      process.stdout.write(`${redactPrompt(prompt)}\n`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

/**
 * The blocks, each with the sha256 of the file it was actually read from.
 *
 * The path comes from `PromptBlock.file`, which the assembler sets while it is
 * reading — never from a second table here that maps a `source` string back to
 * a path. That table existed and it was the wrong shape twice: it had to be
 * extended by hand for every new source (the v2 files would have been the
 * fourth and fifth entries), and an earlier version keyed on `block.name`
 * instead, which hashed `persona.md` against the group's code-sourced
 * `GROUP_PERSONA` — a real file's hash printed next to text that file never
 * produced. A block built from a string literal or a generated catalogue
 * carries no `file` and gets no hash, which is the correct answer for it.
 */
function renderBlocks(blocks: readonly PromptBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.text.length === 0) continue; // an absent file, an empty skills catalogue, safe mode off
    const provenance =
      block.file && existsSync(block.file)
        ? `${block.source}, sha256 ${sha256(readFileSync(block.file)).slice(0, 12)}`
        : block.source;
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

/**
 * `muffin prompt version [v1|v2]` — la seconda porta sulla stessa manopola.
 *
 * Legge e scrive `config.prompt.version` e niente altro, attraverso lo stesso
 * `promptVersion` che `buildRuntime` usa per assemblare: il comando non ha un
 * modo di credere una versione diversa da quella che il turno riceve, perché
 * non c'è una seconda risposta alla domanda. La memoria di questa casa lo dice
 * come regola — flag, comando e config chiamano una funzione sola — ed è nata
 * dalle manopole esposte da una porta soltanto.
 *
 * Non tocca nessun file del prompt: `~/.muffin/persona.md` e `~/.muffin/voice.md`
 * restano dove sono qualunque versione sia attiva, che è ciò che rende il
 * ritorno a v1 un flag e non un ripristino.
 */
export function cmdPromptVersion(home: string, argv: string[]): number {
  const [wanted, ...extra] = argv;
  if (extra.length > 0) {
    process.stderr.write(PROMPT_USAGE);
    return 78;
  }

  let config;
  try {
    config = loadConfig(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const attuale = promptVersion(config);
  if (wanted === undefined) {
    process.stdout.write(`${attuale}\n`);
    process.stderr.write(`versioni disponibili: ${PROMPT_VERSIONS.join(', ')} — default v1\n`);
    return 0;
  }

  if (!(PROMPT_VERSIONS as readonly string[]).includes(wanted)) {
    process.stderr.write(`versione sconosciuta: ${wanted} (attese: ${PROMPT_VERSIONS.join(', ')})\n`);
    return 78;
  }

  const nuova = wanted as PromptVersion;
  if (nuova === attuale) {
    process.stderr.write(`già ${nuova}: config.json non toccata\n`);
    process.stdout.write(`${nuova}\n`);
    return 0;
  }

  saveConfig({ ...config, prompt: { version: nuova } }, home);
  process.stderr.write(
    `prompt: ${attuale} → ${nuova}. Vale dal prossimo boot (\`muffin run\`, gateway, job): ` +
      `il prompt si assembla all'avvio, non a ogni turno. Guardalo con \`muffin prompt show\`.\n`,
  );
  process.stdout.write(`${nuova}\n`);
  return 0;
}
