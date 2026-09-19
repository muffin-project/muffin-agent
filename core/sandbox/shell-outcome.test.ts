import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * **I falsificatori dell'integrità dell'esito shell, eseguiti.**
 *
 * Il contratto che questo file prova, in una frase: se il comando chiede una
 * sequenza che semanticamente fallisce senza gestire il fallimento,
 * l'esito è un errore; se il fallimento è gestito esplicitamente dal comando,
 * può essere un successo.
 *
 * Fino a oggi il contratto era un altro, mai scritto da nessuna parte: l'esito
 * era l'exit code dell'ULTIMO comando lanciato da `bash -c`, senza `pipefail`
 * e senza fail-fast. Misurato sul runtime dell'owner:
 *
 * - `vitest ... | tail` falliva e `tail` riusciva → `exit=0, is_error=false`;
 * - `git add`/`git commit` fallivano e il successivo `git status` riusciva →
 *   successo registrato, effetto mai avvenuto.
 *
 * Il modello compensava leggendo `fatal` su stderr. Quella non è una
 * correttezza: è un'euristica su parole, e questo file la sostituisce con
 * un'uscita che dice il vero.
 *
 * Qui gira un comando vero attraverso `execute()` — la stessa porta di
 * `shell_run` e `shell_run_write` — e si guarda cosa è successo. Come in
 * `executor.test.ts`, il meccanismo è provato su macOS sempre e su Linux dove
 * la sonda lo permette, mai asserito sui flag che srt costruisce.
 *
 * **La mutazione che deve far cadere i test rossi**, in codice nostro:
 * togliere il prefisso `set -eo pipefail` in `core/sandbox/executor.ts` —
 * `false | true` e `false; true` tornano a uscire 0, il sentinel viene
 * toccato, `git add` fallito più `git status` riuscito torna 0. Verificato a
 * mano scrivendo il fix, non asserito a memoria.
 *
 * **I test verdi che devono restare verdi**: la sezione sul fallimento
 * gestito (`||`, `if`, `!`, `set +e`) — il fix non deve rompere il modo in
 * cui la shell dice «questo fallimento l'ho previsto».
 */
const host = platform();

/** Stesso cancello di `executor.test.ts`, e per le stesse ragioni: vedi lì. */
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

describe('shell outcome integrity dichiara se è stata provata', () => {
  it('o la prova è girata, o lo skip è dichiarato — e dove era richiesta, uno skip è un guasto', () => {
    if (gate.run) {
      expect(gate.why).not.toBe('');
      return;
    }
    if (containmentRequired) {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 e nessun contenimento reale è girato su questo host — ${gate.why}.`,
      );
    }
    console.warn(`[sandbox] shell-outcome NON provato — ${gate.why}`);
    expect(gate.why).not.toBe('');
  });
});

describe.runIf(gate.run)(`shell outcome integrity (real containment — ${gate.why})`, () => {
  const base = mkdtempSync(join(tmpdir(), 'muffin-shell-outcome-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] });

  afterAll(async () => {
    await executor.close();
  });

  describe('unhandled failure fails the call', () => {
    it('una pipeline con primo comando fallito e ultimo riuscito è un errore', async () => {
      // La forma esatta del guasto osservato: `vitest ... | tail` — il
      // produttore fallisce, il consumatore riesce, l'esito deve dire il vero.
      const r = await executor.runReadOnly({
        command: `(echo boom >&2; exit 3) | tail -n 5`,
        cwd: workspace,
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('boom');
    });

    it('una sequenza `false; true` è un errore', async () => {
      const r = await executor.runReadOnly({ command: 'false; true', cwd: workspace });
      expect(r.code).not.toBe(0);
    });

    it('fail-fast: dopo il primo fallimento niente altro gira', async () => {
      const sentinel = join(workspace, 'non-doveva-esistere.txt');
      const r = await executor.run({
        command: `false; touch '${sentinel}'`,
        cwd: workspace,
        writeScope: [workspace],
      });
      expect(r.code).not.toBe(0);
      // Non solo l'exit code: senza fail-fast il secondo comando gira e il
      // file resta a terra come prova che l'effetto è avvenuto «dopo» il
      // fallimento.
      expect(existsSync(sentinel)).toBe(false);
    });

    it('git: mutation fallita più inspection riuscita è un errore', async () => {
      const probe = await executor.runReadOnly({ command: 'git --version', cwd: workspace });
      if (probe.code !== 0) {
        if (containmentRequired) {
          throw new Error('MUFFIN_REQUIRE_SANDBOX=1 ma git non è eseguibile nel sandbox.');
        }
        console.warn('[sandbox] git assente nel sandbox — scenario git non provato');
        return;
      }
      const repo = join(workspace, 'repo-fallita');
      mkdirSync(repo, { recursive: true });
      // La forma esatta del secondo guasto osservato: `git add` fallisce, il
      // `git status` dopo riesce, l'esito deve dire il vero — e lo stderr
      // resta a disposizione come evidenza, non come unico segnale.
      // Separati da `;` di proposito: con `&&` la catena si spezza da sé e
      // non c'è niente da provare — il guasto osservato era una shell
      // sequenziale dove l'inspection dopo la mutation maschera tutto.
      const r = await executor.run({
        command: 'git init -q .; git add questo-file-non-esiste; git status',
        cwd: repo,
        writeScope: [repo],
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('questo-file-non-esiste');
    });
  });

  describe('handled failure stays a success', () => {
    it('`false || fallback` riesce e il fallback gira', async () => {
      const r = await executor.runReadOnly({
        command: 'false || echo fallback',
        cwd: workspace,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('fallback');
    });

    it('`if false; then … else …` riesce per il ramo else', async () => {
      const r = await executor.runReadOnly({
        command: 'if false; then echo ramo-sbagliato; else echo gestito; fi',
        cwd: workspace,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('gestito');
      expect(r.stdout).not.toContain('ramo-sbagliato');
    });

    it('`! false` riesce: la negazione è gestione esplicita', async () => {
      const r = await executor.runReadOnly({ command: '! false', cwd: workspace });
      expect(r.code).toBe(0);
    });

    it('`set +e` disattiva il fail-fast: opt-out esplicito, non maschera', async () => {
      const r = await executor.runReadOnly({
        command: 'set +e; false; true',
        cwd: workspace,
      });
      expect(r.code).toBe(0);
    });

    it('`true && echo ok` resta il caso felice', async () => {
      const r = await executor.runReadOnly({ command: 'true && echo ok', cwd: workspace });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('ok');
    });
  });

  describe('signal/timeout', () => {
    it('un timeout conserva l’output parziale e dice che il comando non ha finito', async () => {
      const r = await executor.runReadOnly({
        command: 'echo parziale && sleep 30',
        cwd: workspace,
        timeoutMs: 1_500,
      });
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain('parziale');
      // Il bound è una garanzia, non un auspicio: senza kill dell'intero
      // gruppo di processo la chiamata si risolve all'uscita naturale
      // dell'orfano più lungo (qui: 30s), e `timeoutMs` smette di contenere
      // la CPU dell'host per i comandi composti.
      expect(r.durationMs).toBeLessThan(9_000);
    }, 15_000);

    it('un abort rifiuta subito invece di fingersi un esito', async () => {
      // Un abort (Ctrl-C del turno, `signal` abortito): Node uccide il leader
      // con SIGTERM e la `error` event rifiuta — il giro lo registra come
      // errore deciso (`throwTier`), mai come un risultato. Il kill di gruppo
      // fa in modo che nessun orfano sopravviva al rifiuto.
      const controller = new AbortController();
      const pending = executor.runReadOnly({
        command: 'echo x && sleep 30',
        cwd: workspace,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      await expect(pending).rejects.toThrow(/abort/i);
    }, 15_000);
  });
});
