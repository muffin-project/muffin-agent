import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIdentityLayers, SHIPPED_IDENTITY } from '../agent/context/identity.js';
import { paths } from '../core/config/config.js';
import { applyIdentityMigration, planIdentityMigration } from './identity-migrate.js';
import { runInit } from './init.js';
import { runRotMigrate } from './rot-migrate.js';

/**
 * ADR-0112, emendamento del 26/11/2026: il passaggio assistito da una
 * rot/identity.md modificata a mano a fondazione + user.md. Solo Home
 * temporanee e testi inventati: nessun dato personale vero.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'muffin-identity-migrate-'));
  roots.push(root);
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
  const home = join(root, 'home');
  runInit({ home, apiKey: 'sk-fixture-never-called' });
  return home;
}

const homeCopy = (home: string) => join(paths(home).rot, 'identity.md');
const shipped = () => readFileSync(SHIPPED_IDENTITY, 'utf8');

function handEdit(home: string, extra: string): void {
  writeFileSync(homeCopy(home), `${shipped()}\n${extra}`);
}

describe('planIdentityMigration', () => {
  it('una casa nuova non ha niente da migrare', () => {
    expect(planIdentityMigration(freshHome()).kind).toBe('not-needed');
  });

  it('con user.md già presente non propone di sovrascriverlo', () => {
    const home = freshHome();
    handEdit(home, 'Riga mia (fixture).\n');
    writeFileSync(paths(home).user, 'Già scritto (fixture).\n');
    const plan = planIdentityMigration(home);
    expect(plan.kind).toBe('not-needed');
    if (plan.kind === 'not-needed') expect(plan.reason).toContain('esiste già');
  });

  it('una copia modificata a mano dà le sole righe dell’owner, senza scrivere niente', () => {
    const home = freshHome();
    handEdit(home, '## Preferenze (fixture)\n\n- Risposte brevi.\n');
    const before = readFileSync(homeCopy(home));
    const plan = planIdentityMigration(home);
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.text).toBe('## Preferenze (fixture)\n\n- Risposte brevi.');
    expect(existsSync(paths(home).user)).toBe(false);
    expect(readFileSync(homeCopy(home))).toEqual(before);
  });

  it('oltre il tetto conserva il patto e richiede una scelta', () => {
    const home = freshHome();
    const lunga = Array.from(
      { length: 400 },
      (_, i) => `- riga fixture numero ${String(i)} abbastanza lunga`,
    ).join('\n');
    handEdit(home, `${lunga}\n`);
    const plan = planIdentityMigration(home);
    expect(plan.kind).toBe('needs-review');
    expect(existsSync(paths(home).user)).toBe(false);
  });
});

describe('applyIdentityMigration', () => {
  it('fa il backup, crea user.md 0600 e la casa passa a fondazione + user.md', () => {
    const home = freshHome();
    handEdit(home, '- Risposte brevi (fixture).\n');
    const copyBefore = readFileSync(homeCopy(home));
    const plan = planIdentityMigration(home);
    if (plan.kind !== 'ready') throw new Error('plan not ready');

    const done = applyIdentityMigration(home, plan, new Date('2026-11-26T12:00:00Z'));

    if (done.backup === null) throw new Error('no backup');
    expect(readFileSync(done.backup)).toEqual(copyBefore);
    expect(statSync(paths(home).user).mode & 0o777).toBe(0o600);
    const layers = resolveIdentityLayers(home);
    expect(layers.mode).toBe('foundation+user');
    expect(layers.pact.file).toBe(SHIPPED_IDENTITY);
    // Il commento d'intestazione non entra nel prompt; le righe sì.
    expect(layers.user?.text).toBe('- Risposte brevi (fixture).');
    // La copia in home resta com'era: non è più letta, non è riscritta.
    expect(readFileSync(homeCopy(home))).toEqual(copyBefore);
  });

  it('lascia il patto attivo se cambia tra anteprima e scrittura', () => {
    const home = freshHome();
    handEdit(home, '- Prima preferenza (fixture).\n');
    const plan = planIdentityMigration(home);
    if (plan.kind !== 'ready') throw new Error('plan not ready');

    handEdit(home, '- Seconda preferenza (fixture).\n');

    expect(() => applyIdentityMigration(home, plan)).toThrow(/dopo l’anteprima/);
    expect(existsSync(paths(home).user)).toBe(false);
  });

  it('non sovrascrive un user.md comparso nel frattempo', () => {
    const home = freshHome();
    handEdit(home, '- Riga (fixture).\n');
    const plan = planIdentityMigration(home);
    if (plan.kind !== 'ready') throw new Error('plan not ready');
    writeFileSync(paths(home).user, 'scritto a mano nel frattempo\n');
    expect(() => applyIdentityMigration(home, plan)).toThrow(/esiste già/);
    expect(readFileSync(paths(home).user, 'utf8')).toBe('scritto a mano nel frattempo\n');
  });
});

describe('muffin rot migrate (identità)', () => {
  const run = async (
    home: string,
    argv: string[],
    confirm?: (q: string) => Promise<string | undefined>,
  ) => {
    const lines: string[] = [];
    const code = await runRotMigrate(home, argv, {
      out: (l) => lines.push(l),
      ...(confirm ? { confirm } : {}),
    });
    return { code, text: lines.join('\n') };
  };

  it('senza terminale e senza --apply mostra l’anteprima e non scrive niente', async () => {
    const home = freshHome();
    handEdit(home, '- Riga mia (fixture).\n');
    const r = await run(home, []);
    expect(r.code).toBe(0);
    expect(r.text).toContain('│ - Riga mia (fixture).');
    expect(r.text).toContain('muffin rot migrate --apply');
    expect(existsSync(paths(home).user)).toBe(false);
    expect(resolveIdentityLayers(home).mode).toBe('foundation+legacy-preferences');
  });

  it('senza --apply non riscrive rot/budgets.json, anche se andrebbe riformattato', async () => {
    const home = freshHome();
    const budgets = join(paths(home).rot, 'budgets.json');
    writeFileSync(budgets, '{"schemaVersion":1,"monthlyUsd":80}\n');
    const before = readFileSync(budgets, 'utf8');
    const r = await run(home, []);
    expect(r.code).toBe(0);
    expect(readFileSync(budgets, 'utf8')).toBe(before);
    expect(r.text).toMatch(/Niente scritto senza --apply|da scrivere: rot\/budgets\.json/);
  });

  it('--apply sposta le righe e attiva fondazione + user.md', async () => {
    const home = freshHome();
    handEdit(home, '- Riga mia (fixture).\n');
    const r = await run(home, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('scritto:');
    expect(resolveIdentityLayers(home).mode).toBe('foundation+user');
  });

  it('esplicita una sottrazione e --apply conserva il patto senza creare un overlay', async () => {
    const home = freshHome();
    const pact = shipped().replace(/## Registro[\s\S]*?(?=\n## |$)/, '');
    expect(pact).not.toBe(shipped());
    writeFileSync(homeCopy(home), pact);

    const preview = await run(home, []);
    const applied = await run(home, ['--apply']);

    expect(preview.text).toContain('può ripristinare indicazioni che avevi tolto');
    expect(applied.code).toBe(1);
    expect(existsSync(paths(home).user)).toBe(false);
    expect(readFileSync(homeCopy(home), 'utf8')).toBe(pact);
    expect(resolveIdentityLayers(home).mode).toBe('legacy-home');
  });

  it('su un terminale chiede, e un no non scrive', async () => {
    const home = freshHome();
    handEdit(home, '- Riga mia (fixture).\n');
    const asked: string[] = [];
    const r = await run(home, [], async (q) => {
      asked.push(q);
      return 'n';
    });
    expect(asked).toHaveLength(1);
    expect(r.text).toContain('Niente scritto');
    expect(existsSync(paths(home).user)).toBe(false);
  });

  it('su un terminale un sì applica', async () => {
    const home = freshHome();
    handEdit(home, '- Riga mia (fixture).\n');
    await run(home, [], async () => 'sì');
    expect(resolveIdentityLayers(home).mode).toBe('foundation+user');
  });

  it('un flag sconosciuto è un errore d’uso, prima di toccare qualunque cosa', async () => {
    const home = freshHome();
    const r = await run(home, ['--force']);
    expect(r.code).toBe(78);
  });
});
