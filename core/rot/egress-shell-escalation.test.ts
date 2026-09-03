import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from '../sandbox/executor.js';
import { probeSandbox } from '../sandbox/probe.js';
import { mandatoryGuards } from './guards.js';
import { runInit } from '../../cli/init.js';
import { paths } from '../config/config.js';

/**
 * The single most important assertion in this slice (ADR-0058): a verb that
 * widens `rot/egress.json` and reseals speaks with the owner's authority, so
 * `sys.shell` — the one tool that lets the model run an arbitrary command —
 * must have **no path** to it, and the refusal must rest on something the
 * model cannot forge, never on a flag it could pass (there is no `--yes` on
 * `muffin search`/`muffin mcp add`; none was added for this reason).
 *
 * Two independent facts close that path, and this file proves both against a
 * real sandbox rather than a stub — same gating discipline as
 * `core/sandbox/executor.test.ts`, because a security guarantee asserted
 * against a fake executor only proves the fake agrees with itself.
 *
 * 1. **stdin is never a TTY inside `sys.shell`'s child.** `agent/tools/
 *    shell.ts` declares "no PTY" and `core/sandbox/executor.ts`'s own
 *    `ExecRequest.command` doc says the same; `spawnCollect` spawns with
 *    `stdio: ['ignore', 'pipe', 'pipe']`. `cli/main.ts` wires
 *    `chiediConferma`/`chiediChiave` into `muffin search`/`muffin mcp add`
 *    **only** when `isatty(0)` is true at the moment `main()` runs — not from
 *    a parameter, an env var, or anything a spawned child controls. Without
 *    that callback, `widenEgressForCapability` (`core/rot/egress-writer.ts`)
 *    refuses unconditionally and writes nothing — proved directly below by
 *    running the exact non-interactive probe through the real sandbox.
 *
 * 2. **Even a write attempted straight at the file, bypassing this CLI
 *    entirely, is denied by the sandbox itself.** `core/rot/guards.ts`'s
 *    `mandatoryGuards` puts `paths(home).rot` in `denyWrite` unconditionally
 *    — "whatever the per-call scope says" (`agent/runtime.ts`) — and that is
 *    the same `Guards` object the production `SandboxExecutor` in
 *    `agent/runtime.ts` is built with. So the belt holds even if the
 *    suspenders (the TTY gate) were ever bypassed.
 */
const host = platform();

const gate: { run: boolean; why: string } = (() => {
  if (host === 'darwin') return { run: true, why: 'macOS: seatbelt is part of the OS' };
  if (host === 'linux') {
    const p = probeSandbox();
    if (p.available) return { run: true, why: `linux: ${p.mechanism} contained a real probe` };
    return { run: false, why: `linux: sandbox unavailable — ${p.reason}: ${p.detail}` };
  }
  return { run: false, why: `no OS-level sandbox on ${host}` };
})();

const containmentRequired = process.env['MUFFIN_REQUIRE_SANDBOX'] === '1';

describe('la suite di contenimento dichiara se è girata', () => {
  it('gira davvero, o lo skip è dichiarato — e dove serve provarlo uno skip è un fallimento', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(`MUFFIN_REQUIRE_SANDBOX=1 e nessun contenimento reale è girato qui — ${gate.why}.`);
    }
    console.warn(`[sandbox] contenimento reale SALTATO — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`sys.shell non può allargare l egress (contenimento reale — ${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-shell-escalation-'));
  const home = join(base, 'home');
  const cwd = join(base, 'workspace');
  mkdirSync(cwd, { recursive: true });
  runInit({ home, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });

  // Stessi guards della produzione (`agent/runtime.ts`, `mandatoryGuards`):
  // non un elenco scritto apposta per questo test.
  const guards = mandatoryGuards(home, cwd, base /* userHome fittizio, non serve qui */);
  const executor = new SandboxExecutor(guards);

  afterAll(async () => {
    await executor.close();
  });

  it('lo stdin del figlio sandboxato non è mai un TTY — la condizione che chiude la domanda', async () => {
    const r = await executor.run({
      command: `${process.execPath} -e "process.stdout.write(String(!!process.stdin.isTTY))"`,
      cwd,
      writeScope: [cwd],
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('false');
  });

  it('un tentativo diretto di scrivere rot/egress.json dal sandbox è negato — la seconda barriera', async () => {
    const egressPath = join(paths(home).rot, 'egress.json');
    const prima = readFileSync(egressPath, 'utf8');
    const r = await executor.run({
      command: `echo '{"schemaVersion":1,"allow":["evil.example"]}' > '${egressPath}'`,
      cwd,
      writeScope: [cwd, paths(home).rot], // anche dichiarandolo esplicitamente nello scope: il deny è mandatorio
    });
    expect(r.code).not.toBe(0);
    expect(readFileSync(egressPath, 'utf8')).toBe(prima);
  });

  it('e un tentativo di lanciare il binario muffin per riavviare la conferma non aiuta: nessun terminale dentro il sandbox', async () => {
    // Non serve costruire davvero il binario per questa proprietà: la riga
    // sopra ha già misurato che `process.stdin.isTTY` è falso per qualunque
    // comando lanciato attraverso questo executor, quindi qualunque programma
    // — `muffin` incluso — vedrebbe la stessa cosa e prenderebbe lo stesso
    // ramo non-interattivo di `cli/main.ts`. Questo test rende esplicita la
    // catena: `sh -c` dentro il sandbox eredita lo stesso stdin.
    const r = await executor.run({
      command: `${process.execPath} -e "process.exit(process.stdin.isTTY ? 1 : 0)"`,
      cwd,
      writeScope: [cwd],
    });
    expect(r.code).toBe(0);
  });
});
