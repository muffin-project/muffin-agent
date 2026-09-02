import { describe, expect, it } from 'vitest';
import { createDecide } from './decide.js';
import { POLICY_FLOOR } from './matrix.js';
import type { CapabilityDecl, Decision, DecisionRequest, Principal, TrustTier } from './types.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { shellCapability } from '../../agent/tools/shell.js';
import { processCapabilities } from '../../agent/tools/process.js';
import { sendFileCapability } from '../../agent/tools/deliver.js';
import { httpCapability } from '../../agent/tools/http.js';
import { searchCapability } from '../../agent/tools/search.js';
import { memoryCapability } from '../../agent/tools/memory.js';
import { skillCapability } from '../../agent/tools/skill.js';
import { documentCapability } from '../../agent/tools/document.js';
import { inspectCapability } from '../../agent/tools/inspect.js';
import { todoCapability } from '../../agent/tools/todo.js';
import { waitCapability } from '../../agent/tools/wait.js';
import { mcpCapabilityFor } from '../../agent/tools/mcp.js';

/**
 * The normative matrix, executed.
 *
 * `docs/history/rebuild-2026/03-threat-model.md` §3 prints a table whose rows are
 * **effect classes** — where the bytes of an effect end up — and whose columns
 * are the turn's taint. The kernel used to decide from a risk class plus a
 * number pinned by hand on each declaration, and the two drifted apart in
 * silence: the row "Shell / filesystem host / processi" reads `ASK` at taint 2,
 * and only `sys.shell` ever got that cell, by an amendment written one
 * capability at a time (ADR-0044 §revisione 2026-08-16). `fs.write` and
 * `sys.process.kill` sit on the same row and kept inheriting the medium/high
 * class default of 1, so they answered `deny` where the matrix says `ask` —
 * measured on the real binary in
 * `evals/acceptance/scenarios/b-parita-superfici.accept.ts`.
 *
 * This file is the guard that makes that drift impossible to repeat: every
 * shipped declaration names its row, and every cell of the matrix is asserted
 * against the kernel's own answer. Move a row in the document without moving
 * the table here, or pin a `maxTaint` that contradicts a row, and this goes red.
 */

const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const TIERS: readonly TrustTier[] = [0, 1, 2, 3];

const ALL: readonly CapabilityDecl[] = [
  ...fsCapabilities,
  shellCapability,
  ...processCapabilities,
  sendFileCapability,
  httpCapability,
  searchCapability,
  memoryCapability,
  skillCapability,
  documentCapability,
  inspectCapability,
  todoCapability,
  waitCapability,
  mcpCapabilityFor('esempio'),
];

function resourceFor(decl: CapabilityDecl): DecisionRequest['resource'] {
  switch (decl.resourceKind) {
    case 'path':
      return { kind: 'path', value: '/tmp/scope/nota.txt' };
    case 'url':
      return { kind: 'url', value: 'https://esempio.test/pagina' };
    case 'query':
      return { kind: 'query', value: 'il tempo di domani' };
    case 'tenant':
      return { kind: 'tenant', value: 'host' };
    default:
      return { kind: 'none' };
  }
}

/** Hardened and owner: the most permissive context there is, so a refusal here is the ceiling talking. */
function decisionAt(decl: CapabilityDecl, taint: TrustTier): Decision {
  const decide = createDecide({
    capabilities: new Map([[decl.id, decl]]),
    matrix: POLICY_FLOOR,
    budgetExhausted: () => false,
    hardened: true,
    egressAllowed: () => true,
  });
  return decide({
    principal: OWNER,
    tenant: 'host',
    capability: decl.id,
    resource: resourceFor(decl),
    args: {},
    taint,
  });
}

/**
 * The matrix, as two thresholds per row: `askAbove` is the taint above which an
 * auto-allow (or an unattended `draft`) is no longer acceptable, `denyAbove`
 * the taint above which the capability is out of reach entirely. `3` means the
 * matrix does not constrain that column.
 */
const MATRICE = {
  /** Bytes enter the turn; nothing leaves and nothing on the host changes. */
  context: { askAbove: 3, denyAbove: 3 },
  /** "Shell / filesystem host / processi": ALLOW per classe · ASK · DENY. */
  host: { askAbove: 1, denyAbove: 2 },
  /** "Reply sul canale di origine": ALLOW · ALLOW · ALLOW. */
  reply: { askAbove: 3, denyAbove: 3 },
  /** "Egress rete": the allowlist and `paramsMaxTaint` own this row's columns. */
  egress: { askAbove: 3, denyAbove: 3 },
  /** "Scrittura memoria (episodi/fatti)": ALLOW · ALLOW nel tenant · ALLOW. */
  memory: { askAbove: 3, denyAbove: 3 },
  /** Third-party code outside the allowlist model (MCP). Not a printed row: keeps today's number. */
  external: { askAbove: 1, denyAbove: 1 },
  /** "Outward (mail, messaggi a terzi, pubblicazione)": DRAFT · DENY · DENY. */
  outward: { askAbove: 0, denyAbove: 1 },
  /** "Scrittura config/voice (cricchetto)": ALLOW solo via ratchet · DENY · DENY. */
  config: { askAbove: 0, denyAbove: 1 },
  /** "Root of Trust": DENY a runtime per chiunque. */
  rot: { askAbove: 0, denyAbove: -1 },
} as const;

describe('la matrice normativa è eseguibile', () => {
  it('ogni capability dichiara la riga di effetto a cui appartiene', () => {
    const senzaRiga = ALL.filter((d) => !(d.effect in MATRICE));
    expect(senzaRiga.map((d) => d.id)).toEqual([]);
  });

  it.each(ALL.map((d) => [d.id, d] as const))(
    '%s risponde come dice la sua riga, a ogni taint',
    (_id, decl) => {
      const riga = MATRICE[decl.effect];
      // Una dichiarazione può stringere la propria riga, mai allargarla: il
      // file sigillato e la dichiarazione non sono lo stesso dominio di
      // fiducia, e il knob per capability è esattamente ciò che ha prodotto la
      // deriva (matrix.ts, §"defaultMaxTaint è clampato verso il basso").
      const denyAbove = Math.min(riga.denyAbove, decl.maxTaint ?? 3);
      for (const taint of TIERS) {
        const d = decisionAt(decl, taint);
        if (taint > denyAbove) {
          expect(`${decl.id}@${taint}:${d.effect}`).toBe(`${decl.id}@${taint}:deny`);
          continue;
        }
        if (taint > riga.askAbove) {
          expect(`${decl.id}@${taint}:${d.effect}`).toBe(`${decl.id}@${taint}:ask`);
          continue;
        }
        expect(`${decl.id}@${taint}:${d.effect}`).not.toBe(`${decl.id}@${taint}:deny`);
      }
    },
  );

  it('le tre celle che questa slice cambia, per nome', () => {
    const write = fsCapabilities.find((d) => d.id === 'fs.write');
    const kill = processCapabilities.find((d) => d.id === 'sys.process.kill');
    if (!write || !kill) throw new Error('dichiarazione mancante');
    expect(decisionAt(write, 2).effect).toBe('ask');
    expect(decisionAt(kill, 2).effect).toBe('ask');
    expect(decisionAt(sendFileCapability, 2).effect).toBe('allow');
  });
});
