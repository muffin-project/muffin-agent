import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, paths, saveConfig } from '../core/config/config.js';
import { sha256 } from '../core/rot/verify.js';
import { runInit } from './init.js';
import { cmdPromptShow, cmdPromptVersion } from './prompt-show.js';

/**
 * `muffin prompt show` has to be **truthful**, not merely functional: its one
 * job is proving what the model receives, so a test that only checks "it
 * prints something plausible" would pass on a command that quietly drifted
 * from production. Every assertion below compares the command's output
 * against the *same* `buildRuntime(...).deps.systemPrompts` the loop sends to
 * the provider (`agent/loop.ts:996`) — never a hand-written expectation of
 * what the prompt "should" contain, because that would only prove this file
 * agrees with itself.
 *
 * The end-to-end version of this same claim — a real `muffin run` against a
 * fake provider, its captured request compared against `prompt show` on the
 * same home — is the A2/A3 acceptance scenario
 * (`evals/acceptance/scenarios/a-lifecycle.accept.ts`). This file is the fast,
 * fine-grained layer underneath it.
 */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'muffin-prompt-show-ws-'));

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-prompt-show-'));
  runInit({ home, apiKey: 'sk-prompt-show-never-called' });
  return home;
}

function capture(fn: () => number): { out: string; err: string; code: number } {
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = fn();
    return { out, err, code };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** The real owner/group prompts for this home, through the same construction `buildRuntime` uses everywhere else. */
function realPrompts(home: string): { owner: string; group: string } {
  const runtime = buildRuntime(home, WORKSPACE);
  try {
    return { owner: runtime.deps.systemPrompts.owner, group: runtime.deps.systemPrompts.group };
  } finally {
    runtime.close();
  }
}

describe('muffin prompt show', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prints, byte for byte, the same owner prompt the loop would send', () => {
    const home = bootHome();
    const { owner } = realPrompts(home);
    const { out, code } = capture(() => cmdPromptShow(home, []));
    expect(code).toBe(0);
    // Exactly one trailing newline is the command's own convention (a text
    // stream ends with one) — normalized here rather than baked into
    // `realPrompts`, so the comparison states what it is instead of hiding it
    // in a helper.
    expect(out).toBe(`${owner}\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it('--member prints the group prompt, not the owner one', () => {
    const home = bootHome();
    const { owner, group } = realPrompts(home);
    const { out, code } = capture(() => cmdPromptShow(home, ['--member']));
    expect(code).toBe(0);
    expect(out).toBe(`${group}\n`);
    expect(out).not.toBe(`${owner}\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it('--surface telegram --member also resolves to the group class', () => {
    // `tenantClass` cares about the tenant and the principal kind, not the
    // surface name — this proves the flag combination lands on the same
    // class as the bare `--member`, through the real function, not an
    // assumption about what the flags are supposed to do.
    const home = bootHome();
    const { group } = realPrompts(home);
    const { out, code } = capture(() => cmdPromptShow(home, ['--surface', 'telegram', '--member']));
    expect(code).toBe(0);
    expect(out).toBe(`${group}\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it('an explicit non-host --tenant forces the group class even without --member', () => {
    const home = bootHome();
    const { group } = realPrompts(home);
    const { out, code } = capture(() => cmdPromptShow(home, ['--tenant', 'group:telegram:-100']));
    expect(code).toBe(0);
    expect(out).toBe(`${group}\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects an unknown --surface without touching stdout', () => {
    const home = bootHome();
    const { out, err, code } = capture(() => cmdPromptShow(home, ['--surface', 'discord-bot-9000']));
    expect(code).toBe(78);
    expect(out).toBe('');
    expect(err).toContain('--surface');
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the explanation on stderr and only the prompt on stdout', () => {
    const home = bootHome();
    const { out, err, code } = capture(() => cmdPromptShow(home, []));
    expect(code).toBe(0);
    // The stderr-only vocabulary must never leak into the result stream.
    expect(out).not.toContain('caratteri stimati');
    expect(out).not.toContain('token stimati');
    expect(out).not.toContain('[memoria]');
    // And the explanation is actually there, on the other stream.
    expect(err).toContain('classe: owner');
    expect(err).toMatch(/\d+ caratteri/);
    expect(err).toContain('[memoria]');
    rmSync(home, { recursive: true, force: true });
  });

  it('redacts a secret-shaped string instead of printing it verbatim', () => {
    const home = bootHome();
    const voice = paths(home).voice;
    const fakeKey = 'sk-ant-api03-thisIsNotARealKeyJustShapedLikeOne1234567890';
    writeFileSync(voice, `${readFileSync(voice, 'utf8')}\n\nMARCATORE-PRIMA ${fakeKey} MARCATORE-DOPO\n`);
    const { out, code } = capture(() => cmdPromptShow(home, []));
    expect(code).toBe(0);
    expect(out).not.toContain(fakeKey);
    expect(out).toContain('«redacted:');
    // Only the secret itself is swallowed — the surrounding authored text survives.
    expect(out).toContain('MARCATORE-PRIMA');
    expect(out).toContain('MARCATORE-DOPO');
    rmSync(home, { recursive: true, force: true });
  });

  it('redacts a literal secret:// reference too', () => {
    const home = bootHome();
    const voice = paths(home).voice;
    writeFileSync(voice, `${readFileSync(voice, 'utf8')}\n\nMARCATORE-REF secret://provider_api_key MARCATORE-FINE\n`);
    const { out, code } = capture(() => cmdPromptShow(home, []));
    expect(code).toBe(0);
    expect(out).not.toContain('secret://provider_api_key');
    expect(out).toContain('«redacted:');
    rmSync(home, { recursive: true, force: true });
  });

  it('--blocks names the real installed file and its true sha256, per block', () => {
    const home = bootHome();
    const { out, code } = capture(() => cmdPromptShow(home, ['--blocks']));
    expect(code).toBe(0);

    const personaHash = sha256(readFileSync(paths(home).persona)).slice(0, 12);
    const identityHash = sha256(readFileSync(join(paths(home).rot, 'identity.md'))).slice(0, 12);
    const voiceHash = sha256(readFileSync(paths(home).voice)).slice(0, 12);

    expect(out).toContain(`--- blocco: persona (persona.md, sha256 ${personaHash}) ---`);
    expect(out).toContain(`--- blocco: identity (rot/identity.md, sha256 ${identityHash}) ---`);
    expect(out).toContain(`--- blocco: voice (voice.md, sha256 ${voiceHash}) ---`);
    rmSync(home, { recursive: true, force: true });
  });

  it("--blocks on the group class never hashes persona.md for the code-sourced GROUP_PERSONA block", () => {
    // Regression for a real bug found while building this command: keying the
    // sha256 lookup on the block *name* ('persona') rather than its *source*
    // hashed persona.md next to text that file never produced — GROUP_PERSONA
    // is a string literal in agent/context/assemble.ts.
    const home = bootHome();
    const { out, code } = capture(() => cmdPromptShow(home, ['--member', '--blocks']));
    expect(code).toBe(0);
    expect(out).toContain('--- blocco: persona (agent/context/assemble.ts (GROUP_PERSONA)) ---');
    expect(out).not.toMatch(/blocco: persona \([^)]*persona\.md/);
    rmSync(home, { recursive: true, force: true });
  });

  it('reflects safe mode on stdout and stderr when the root of trust has diverged', () => {
    const home = bootHome();
    // Tamper with a real sealed file, the same way A5's acceptance scenario
    // does — never a fixture doctor was merely told about.
    const policyPath = join(paths(home).rot, 'policy.json');
    const original = readFileSync(policyPath, 'utf8');
    writeFileSync(policyPath, JSON.stringify({ ...(JSON.parse(original) as object), _tamper: true }, null, 2));

    const { out, err, code } = capture(() => cmdPromptShow(home, []));
    expect(code).toBe(0);
    expect(err).toContain('safe mode');
    // The prompt shown is the one actually produced in this degraded state —
    // not a description of safe mode bolted on afterwards.
    expect(out).toContain('Modalità sicura');
    rmSync(home, { recursive: true, force: true });
  });
});

/**
 * `muffin prompt version` — la seconda porta, e il fatto che le due porte non
 * possano dire cose diverse.
 *
 * La regola di casa che questo test difende è vecchia: una manopola esposta da
 * una porta sola è un difetto, e due porte che divergono sono peggio di una. La
 * proprietà non è «il comando scrive un campo» — è che il prompt montato dopo
 * il comando sia **byte per byte** quello montato dopo la stessa scelta scritta
 * a mano in `config.json`.
 */
describe('muffin prompt version — le due porte sulla stessa manopola', () => {
  it('senza argomento stampa la versione attiva, e il default è v1 senza scriverlo da nessuna parte', () => {
    const home = bootHome();
    expect(loadConfig(home).prompt).toBeUndefined();
    const r = capture(() => cmdPromptVersion(home, []));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('v1');
    // stdout è il risultato, stderr la spiegazione: la stessa regola di casa
    // che `prompt show` segue, così `$(muffin prompt version)` è usabile.
    expect(r.err).toContain('v1, v2');
    expect(loadConfig(home).prompt).toBeUndefined();
  });

  it('scrivere v2 col comando dà lo stesso prompt di scriverlo a mano in config.json', () => {
    const aMano = bootHome();
    saveConfig({ ...loadConfig(aMano), prompt: { version: 'v2' } }, aMano);

    const colComando = bootHome();
    const r = capture(() => cmdPromptVersion(colComando, ['v2']));
    expect(r.code).toBe(0);
    expect(loadConfig(colComando).prompt?.version).toBe('v2');

    // Le due home differiscono per il nonce delle skill (è per-installazione),
    // quindi il confronto è sul blocco che la versione decide, non sulla
    // stringa intera: prendere l'intero proverebbe che i nonce sono diversi.
    const uno = buildRuntime(aMano, WORKSPACE);
    const due = buildRuntime(colComando, WORKSPACE);
    try {
      const blocco = (r: typeof uno, nome: string) => r.promptBlocks.owner.find((b) => b.name === nome)?.text;
      for (const nome of ['persona', 'voice', 'work-rules']) {
        expect(blocco(due, nome), nome).toBe(blocco(uno, nome));
      }
      expect(blocco(due, 'work-rules')).toContain('## Quando il risultato è incerto');
    } finally {
      uno.close();
      due.close();
    }
  });

  it('il comando non può annunciare una versione diversa da quella che il turno riceve', () => {
    // `promptVersion` è la sola risposta alla domanda: `cmdPromptVersion` la
    // stampa e `buildRuntime` la monta. Il confronto qui è fra quello che il
    // comando dice e quello che il prompt **è**, non fra due letture della
    // config.
    const home = bootHome();
    capture(() => cmdPromptVersion(home, ['v2']));
    const detto = capture(() => cmdPromptVersion(home, [])).out.trim();
    const runtime = buildRuntime(home, WORKSPACE);
    try {
      const montato = runtime.deps.systemPrompts.owner.includes('## Quando il risultato è incerto') ? 'v2' : 'v1';
      expect(montato).toBe(detto);
      // E `prompt show` lo dice a chi guarda, invece di lasciarglielo dedurre.
      const mostrato = capture(() => cmdPromptShow(home, []));
      expect(mostrato.err).toContain('versione prompt: v2');
    } finally {
      runtime.close();
    }
  });

  it('torna a v1 e riporta i byte esatti di prima', () => {
    const home = bootHome();
    const prima = buildRuntime(home, WORKSPACE);
    const v1 = prima.deps.systemPrompts.owner;
    prima.close();

    capture(() => cmdPromptVersion(home, ['v2']));
    capture(() => cmdPromptVersion(home, ['v1']));
    const dopo = buildRuntime(home, WORKSPACE);
    try {
      expect(dopo.deps.systemPrompts.owner).toBe(v1);
    } finally {
      dopo.close();
    }
  });

  it('rifiuta una versione che non esiste senza toccare la config', () => {
    const home = bootHome();
    capture(() => cmdPromptVersion(home, ['v2']));
    const r = capture(() => cmdPromptVersion(home, ['v3']));
    expect(r.code).toBe(78);
    expect(r.err).toContain('v3');
    expect(loadConfig(home).prompt?.version).toBe('v2');
  });
});
