import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Il guard che manda ogni merge dalla porta con il gate. Vedi la testa di
 * `guard-merge-gate.mjs` per il guasto che l'ha reso necessario.
 */
const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-merge-gate.mjs');

function esegui(command: string, env: Record<string, string> = {}): { code: number; err: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    env: { ...process.env, MUFFIN_MERGE_DIRECT: '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, err: r.stderr };
}

describe('guard-merge-gate', () => {
  it('rifiuta `gh pr merge` e nomina la porta con il numero della PR', () => {
    const r = esegui('cd /x && gh pr merge 418 --merge --delete-branch=false 2>&1 | tail -1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('npm run merge -- 418');
  });

  it('lascia passare la porta stessa e gli altri verbi di gh', () => {
    for (const c of ['npm run merge -- 418', 'gh pr view 418 --json state', 'gh pr create --base dev', 'gh pr close 416']) {
      expect(esegui(c).code, c).toBe(0);
    }
  });

  it("un `gh pr merge` citato dentro una stringa non e' un merge", () => {
    expect(esegui(`git commit -m 'docs: mai piu gh pr merge a mano'`).code).toBe(0);
  });

  it("il bypass e' esplicito, nel comando o nell'ambiente", () => {
    expect(esegui('MUFFIN_MERGE_DIRECT=1 gh pr merge 5 --merge').code).toBe(0);
    expect(esegui('gh pr merge 5 --merge', { MUFFIN_MERGE_DIRECT: '1' }).code).toBe(0);
  });
});
