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
 * **Revision, 03/09/2026, after an independent judge's review.** The first
 * version of this file claimed "stdin is never a TTY inside `sys.shell`'s
 * child" was the barrier. That claim is FALSE on Linux: the judge ran the
 * production `SandboxExecutor` under bwrap and allocated a real pty for the
 * grandchild with `script -qc "…" /dev/null` — present, working, and not a
 * privileged operation. That grandchild observes `process.stdin.isTTY ===
 * true`. macOS/seatbelt denies the pty allocation outright (`openpty:
 * Operation not permitted`), which is why the original test passed here —
 * for the wrong reason, on the one platform this repository does not ship to
 * (`docs/decisions/*` — Muffin runs on a Linux VPS).
 *
 * The barrier that actually holds, proven below on **both** platforms and
 * **regardless of whether a pty was allocated**, is the write-deny on
 * `~/.muffin/rot`:
 *
 * 1. **`mandatoryGuards` (`core/rot/guards.ts`) puts `paths(home).rot` in
 *    `denyWrite` unconditionally** — "whatever the per-call scope says"
 *    (`agent/runtime.ts`) — and that is the same `Guards` object the
 *    production `SandboxExecutor` in `agent/runtime.ts` is built with. It
 *    fails a write with `EPERM` under seatbelt and `EROFS` under bwrap, holds
 *    through a pty, a grandchild, and a freshly `exec`'d interpreter, and
 *    cannot be lifted by naming the same path in that call's own
 *    `writeScope` (mandatory beats explicit).
 * 2. **The `isatty(0)` gate in `cli/main.ts` is ergonomics, not a security
 *    boundary.** It keeps a script or a non-interactive invocation from
 *    hanging on a question nobody can answer — genuinely useful, and still
 *    the reason `widenEgressForCapability` (`core/rot/egress-writer.ts`)
 *    refuses unconditionally on the ordinary, no-pty path (test below). It is
 *    not what stops a determined attempt: that is barrier 1.
 *
 * Both are proved against a real sandbox rather than a stub — same gating
 * discipline as `core/sandbox/executor.test.ts`, because a security guarantee
 * asserted against a fake executor only proves the fake agrees with itself.
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

/**
 * Un piccolo script Python, non una riga di shell: `pty.fork()` è nella
 * libreria standard con la stessa API su Linux e macOS, mentre `script(1)`
 * ha due sintassi incompatibili (BSD su macOS non ha nemmeno `-c`; util-linux
 * su Linux sì) — usarlo avrebbe reso questo test dipendente dalla piattaforma
 * proprio nella parte che deve girare ovunque. Il figlio è lanciato con
 * `os.execvp` e un argv esplicito, mai una stringa di shell: niente
 * escaping annidato fra Python, shell e il sorgente node.
 *
 * Il figlio, attaccato al lato slave del pty, stampa `TTY=<bool>
 * WRITE=<ok|denied:CODICE>` — un solo tentativo di scrittura su
 * `rot/egress.json`, mai eseguito due volte, mai eseguito se l'allocazione
 * del pty stessa fallisce (in quel caso il genitore lo dice con
 * `PTY_DENIED:<errore>` e non lancia il figlio affatto).
 */
function ptyProbeSource(): string {
  return [
    'import pty, os, sys',
    'egress_path = sys.argv[1]',
    "js = (\"const fs=require('fs');\"",
    '      "const tty=!!process.stdin.isTTY;"',
    '      "let wrote=\'ok\';"',
    "      \"try{fs.writeFileSync(process.argv[2], 'PWNED');}catch(e){wrote='denied:'+e.code;}\"",
    "      \"process.stdout.write('TTY='+tty+' WRITE='+wrote);\")",
    'try:',
    '    pid, fd = pty.fork()',
    'except OSError as e:',
    "    sys.stdout.write('PTY_DENIED:' + str(e))",
    '    sys.exit(0)',
    'if pid == 0:',
    "    os.execvp('node', ['node', '-e', js, 'placeholder', egress_path])",
    'else:',
    "    out = b''",
    '    while True:',
    '        try:',
    '            chunk = os.read(fd, 4096)',
    '        except OSError:',
    '            break',
    '        if not chunk:',
    '            break',
    '        out += chunk',
    '    os.waitpid(pid, 0)',
    '    sys.stdout.buffer.write(out)',
  ].join('\n');
}

type PtyProbeOutcome =
  | { kind: 'denied-at-alloc'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ran'; tty: boolean; write: string };

function parsePtyProbe(code: number | null, stdout: string, stderr: string): PtyProbeOutcome {
  const testo = stdout.trim();
  if (testo.startsWith('PTY_DENIED:')) {
    return { kind: 'denied-at-alloc', reason: testo.slice('PTY_DENIED:'.length) };
  }
  const m = /TTY=(true|false) WRITE=(\S+)/.exec(testo);
  if (m) return { kind: 'ran', tty: m[1] === 'true', write: m[2]! };
  return { kind: 'unavailable', reason: `exit ${code} · stdout=${JSON.stringify(testo)} · stderr=${JSON.stringify(stderr.trim())}` };
}

describe.runIf(gate.run)(`sys.shell non può allargare l egress (contenimento reale — ${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-shell-escalation-'));
  const home = join(base, 'home');
  const cwd = join(base, 'workspace');
  mkdirSync(cwd, { recursive: true });
  runInit({ home, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
  writeFileSync(join(cwd, 'pty_probe.py'), ptyProbeSource(), 'utf8');

  // Stessi guards della produzione (`agent/runtime.ts`, `mandatoryGuards`):
  // non un elenco scritto apposta per questo test.
  const guards = mandatoryGuards(home, cwd, base /* userHome fittizio, non serve qui */);
  const executor = new SandboxExecutor(guards);

  afterAll(async () => {
    await executor.close();
  });

  it('sul percorso ordinario (nessun pty) lo stdin del figlio non è un TTY — ergonomia, non la barriera', async () => {
    const r = await executor.run({
      command: `${process.execPath} -e "process.stdout.write(String(!!process.stdin.isTTY))"`,
      cwd,
      writeScope: [cwd],
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('false');
  });

  it('un tentativo diretto di scrivere rot/egress.json dal sandbox è negato — la barriera vera', async () => {
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

  /**
   * La prova diretta della revisione: anche con un pty vero — quindi
   * `process.stdin.isTTY === true`, la condizione che su Linux/bwrap rende
   * falsa la frase "stdin non è mai un TTY" — la scrittura su
   * `rot/egress.json` resta negata. Non un doppio del test sopra: qui il
   * gate ergonomico (`isatty(0)`) è esplicitamente battuto, e la barriera che
   * regge è ancora e solo `mandatoryGuards`.
   *
   * Dove un pty non si può allocare per niente (macOS/seatbelt nega
   * `openpty`, o l'ambiente non ha `python3`) il test si salta esplicitamente
   * — `t.skip()`, non un `return` silenzioso, quindi compare come "saltato"
   * e non come "passato" nel report — con la ragione stampata. Sotto
   * `MUFFIN_REQUIRE_SANDBOX=1` (il runner Linux di CI) uno skip diventa un
   * fallimento: lì un pty deve potersi allocare, perché è la piattaforma su
   * cui questa proprietà deve essere vera.
   */
  it('anche con un pty vero (isTTY===true) la scrittura su rot/egress.json resta negata', async (t) => {
    const egressPath = join(paths(home).rot, 'egress.json');
    const prima = readFileSync(egressPath, 'utf8');

    const r = await executor.run({
      command: `python3 pty_probe.py '${egressPath}'`,
      cwd,
      writeScope: [cwd, paths(home).rot], // esplicito nello scope: il deny mandatorio deve battere anche questo
      timeoutMs: 15_000,
    });
    const esito = parsePtyProbe(r.code, r.stdout, r.stderr);

    if (esito.kind !== 'ran') {
      const motivo = esito.kind === 'denied-at-alloc' ? `allocazione del pty negata: ${esito.reason}` : esito.reason;
      if (containmentRequired) {
        throw new Error(
          `MUFFIN_REQUIRE_SANDBOX=1 e nessun pty è stato allocato qui — ${motivo}. Su questo runner deve potersi.`,
        );
      }
      console.warn(`[sandbox] prova col pty SALTATA — ${motivo}`);
      t.skip();
      return;
    }

    // Prova che il pty era vero prima di appoggiarci sopra qualunque cosa:
    // un TTY falso qui renderebbe il resto dell'asserzione senza senso.
    expect(esito.tty).toBe(true);
    expect(esito.write).toMatch(/^denied:/);
    expect(readFileSync(egressPath, 'utf8')).toBe(prima);
  }, 20_000);
});
