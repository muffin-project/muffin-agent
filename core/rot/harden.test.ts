import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seal } from './verify.js';
import { buildHardenPlan, formatHardenPlan, hardenCommands, readOwner } from './harden.js';

/**
 * `muffin rot harden` prints a plan; it never runs anything. These tests hold
 * it to that promise the same way `core/gateway/unit.test.ts` holds
 * `planUnit` to "never a promise the platform cannot keep": assert the exact
 * strings the owner would copy, not just that *some* text came out.
 *
 * Real temp directories throughout, not made-up path strings: `readOwner` and
 * `hardeningHolds` (which `buildHardenPlan` calls) both use the real
 * `existsSync` — only `stat`/`getuid` are injectable — so a fixture that
 * never creates `rot/` on disk would exercise the "not installed yet" branch
 * for every test, silently. `verify.test.ts` is the reason this is known.
 */

const NOW = new Date('2026-08-04T12:00:00Z');

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-harden-'));
  mkdirSync(join(dir, 'rot'), { recursive: true });
  writeFileSync(join(dir, 'rot', 'policy.json'), '{"schemaVersion":1}\n');
  seal(dir, '0.0.0', NOW);
  return dir;
}

/** Same trick as verify.test.ts: real mode bits, a lied-about uid. */
const asForeignOwner =
  (uid: number) =>
  (path: string): { uid: number; mode: number } => ({ uid, mode: statSync(path).mode });

function readOnly(dir: string): void {
  chmodSync(join(dir, 'rot', 'policy.json'), 0o444);
  chmodSync(join(dir, 'rot', 'manifest.json'), 0o444);
  chmodSync(join(dir, '.rot-anchor'), 0o444);
  chmodSync(join(dir, 'rot'), 0o555);
}

const ROT_DIR = 'rot';

describe('readOwner', () => {
  it('says unknown when rot/ does not exist — nothing to harden before `muffin init`', () => {
    expect(readOwner('/no/such/dir', statSync, () => 501, () => 'giusto')).toEqual({ known: false });
  });

  it('names itself, with a username, when the uid matches this process', () => {
    const dir = home();
    const rotDir = join(dir, ROT_DIR);
    const myUid = statSync(rotDir).uid; // however this test process is actually identified
    expect(readOwner(rotDir, statSync, () => myUid, () => 'giusto')).toEqual({
      known: true,
      uid: myUid,
      isSelf: true,
      username: 'giusto',
    });
  });

  it('gives only the uid for a foreign owner — no /etc/passwd lookup, no shelling out', () => {
    const dir = home();
    const rotDir = join(dir, ROT_DIR);
    expect(readOwner(rotDir, asForeignOwner(0), () => 999_999, () => 'giusto')).toEqual({
      known: true,
      uid: 0,
      isSelf: false,
      username: null,
    });
  });

  it('falls back to "not self" when the uid probe itself is unavailable (Windows)', () => {
    const dir = home();
    const rotDir = join(dir, ROT_DIR);
    expect(readOwner(rotDir, statSync, () => undefined, () => 'giusto')).toMatchObject({
      known: true,
      isSelf: false,
      username: null,
    });
  });
});

describe('hardenCommands — the printed lines, exactly', () => {
  const { linux, macos } = hardenCommands('/home/g/.muffin/rot', '/home/g/.muffin/.rot-anchor');

  it('chowns to root only — no group, so no Linux/macOS root-group-name mismatch to get wrong', () => {
    expect(linux[0]).toBe('sudo chown -R root /home/g/.muffin/rot /home/g/.muffin/.rot-anchor');
    expect(linux[0]).not.toContain(':');
    expect(macos[0]).toBe(linux[0]);
  });

  it('strips only the write bit (go-w), never an absolute mode that would break traversal', () => {
    expect(linux[1]).toBe('sudo chmod -R go-w /home/g/.muffin/rot /home/g/.muffin/.rot-anchor');
    expect(linux[1]).not.toMatch(/chmod -R \d+/);
    expect(macos[1]).toBe(linux[1]);
  });

  it('never carries sudo -S, a password, or any other secret-shaped token', () => {
    for (const c of [...linux, ...macos]) expect(c).not.toMatch(/-S\b|password|passwd\s+\S+/i);
  });

  it("verifies with each platform's own stat(1) — the one genuine syntax difference", () => {
    expect(linux[2]).toBe("stat -c '%n %U %a' /home/g/.muffin/rot /home/g/.muffin/.rot-anchor");
    expect(macos[2]).toBe("stat -f '%N %Su %Lp' /home/g/.muffin/rot /home/g/.muffin/.rot-anchor");
    expect(linux[2]).not.toBe(macos[2]);
  });

  it('has exactly three lines per platform, and nothing that is not a shell command', () => {
    expect(linux).toHaveLength(3);
    expect(macos).toHaveLength(3);
    for (const c of [...linux, ...macos]) expect(c.startsWith('sudo') || c.startsWith('stat')).toBe(true);
  });
});

describe('buildHardenPlan + formatHardenPlan — the plan an owner actually reads', () => {
  it('sends an owner with no install yet to `muffin init`, and proposes nothing', () => {
    const plan = buildHardenPlan('/no/such/home', 'single-user');
    expect(plan.owner).toEqual({ known: false });
    expect(plan.linuxCommands).toEqual([]);
    expect(plan.macosCommands).toEqual([]);
    const text = formatHardenPlan(plan);
    expect(text).toContain('muffin init');
    expect(text).not.toContain('chown');
  });

  it(
    'the common case: fresh single-user install — names itself, quotes hardeningHolds verbatim, ' +
      'states the consequence before the commands, Linux before macOS',
    () => {
      const dir = home(); // writable by this process — the default `muffin init` leaves
      const plan = buildHardenPlan(dir, 'single-user', { myUsername: () => 'giusto' });

      // Facts, not invented: the owner really is this process, and
      // `hardening.why` came straight from `hardeningHolds` — never rewritten.
      expect(plan.owner).toMatchObject({ known: true, isSelf: true, username: 'giusto' });
      expect(plan.hardening.holds).toBe(false);
      expect(plan.done).toBe(false);
      expect(plan.linuxCommands.length).toBeGreaterThan(0);
      expect(plan.macosCommands.length).toBeGreaterThan(0);

      const text = formatHardenPlan(plan);
      expect(text).toContain(plan.rotDir);
      expect(text).toContain(plan.anchorPath);
      if (!plan.hardening.holds) expect(text).toContain(plan.hardening.why);

      // Real paths for this machine, not a generic placeholder.
      expect(text).not.toMatch(/<home>|<rotDir>|\$HOME/);
      expect(plan.rotDir).toBe(join(dir, 'rot'));

      // The consequence — said BEFORE the commands, because it is what the
      // owner decides, not what they merely run.
      // Index 2 (the `stat` verify line), not 0: chown/chmod are identical
      // strings in both blocks (see the `hardenCommands` tests above), so
      // searching for either would always find the earlier, Linux occurrence
      // — the one genuinely distinct line is what actually locates each block.
      const consequenceAt = text.indexOf('sys.shell');
      const resealAt = text.indexOf('rot reseal');
      const linuxAt = text.indexOf(plan.linuxCommands[2]!);
      const macosAt = text.indexOf(plan.macosCommands[2]!);
      expect(consequenceAt).toBeGreaterThan(-1);
      expect(resealAt).toBeGreaterThan(-1);
      expect(linuxAt).toBeGreaterThan(-1);
      expect(macosAt).toBeGreaterThan(-1);
      expect(consequenceAt).toBeLessThan(linuxAt);
      expect(resealAt).toBeLessThan(linuxAt);
      // Linux first — production is a VPS; macOS is only the dev machine.
      expect(linuxAt).toBeLessThan(macosAt);

      // Declaring `"mode": "hardened"` is also proposed, since nothing here
      // touches config.json for the owner.
      expect(text).toContain(plan.configPath);
      expect(text).toContain('"hardened"');
    },
  );

  it('does not repeat the config.json instruction once "hardened" is already declared', () => {
    const dir = home();
    const plan = buildHardenPlan(dir, 'hardened', { myUsername: () => 'giusto' });
    const text = formatHardenPlan(plan);
    expect(text).not.toContain(plan.configPath);
  });

  it.skipIf(process.getuid?.() === 0)(
    'OS ownership already holds but config still says single-user: proposes only the declaration and the restart, no chown',
    () => {
      const dir = home();
      readOnly(dir);
      try {
        const plan = buildHardenPlan(dir, 'single-user', { stat: asForeignOwner(999_999) });
        expect(plan.hardening.holds).toBe(true);
        expect(plan.done).toBe(false); // config has not caught up yet
        expect(plan.linuxCommands).toEqual([]);
        expect(plan.macosCommands).toEqual([]);

        const text = formatHardenPlan(plan);
        expect(text).not.toContain('chown');
        expect(text).toContain(plan.configPath);
        expect(text).toContain('gateway stop'); // still needs a restart to be read
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'fully done: both the file ownership and the declared mode agree — nothing left to propose',
    () => {
      const dir = home();
      readOnly(dir);
      try {
        const plan = buildHardenPlan(dir, 'hardened', { stat: asForeignOwner(999_999) });
        expect(plan.done).toBe(true);
        const text = formatHardenPlan(plan);
        expect(text).toContain('Niente da proporre');
        expect(text).not.toContain('chown');
        expect(text).not.toContain('sys.shell');
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'names the narrower guarantee when the uid probe cannot run (Windows), instead of claiming the full one',
    () => {
      const dir = home();
      readOnly(dir);
      try {
        // No uid probe at all: hardeningHolds falls back to W_OK-only and
        // still holds (the same fixture verify.test.ts uses for this case).
        const plan = buildHardenPlan(dir, 'hardened', { getuid: () => undefined });
        expect(plan.hardening).toMatchObject({ holds: true, caveat: expect.stringContaining('non disponibile') });
        const text = formatHardenPlan(plan);
        expect(text).toContain('Niente da proporre');
        expect(text).toContain('non disponibile');
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
      }
    },
  );
});

/**
 * L'ultima riga del piano, che è quella che l'owner esegue davvero.
 *
 * Diceva «`muffin gateway stop`, poi il supervisore lo rialza da solo», ed era
 * vera fino a #217: da lì uno stop **chiesto** scrive `gateway.stopped` e il
 * supervisore non lo rialza, di proposito. Chi seguiva la vecchia riga si
 * ritrovava il gateway spento e l'hardening che sembrava averlo rotto.
 *
 * È lo stesso difetto trovato in `gateway status` lo stesso giorno, e la stessa
 * lezione: un rimedio che invecchia sotto una modifica fatta altrove non
 * fallisce — si esegue, e lascia le cose peggio di prima. Nessun test lo
 * teneva, ed è per questo che è invecchiato in silenzio.
 */
describe('il riavvio in fondo al piano', () => {
  it('dice di riaccenderlo, perché uno stop chiesto resta giù', () => {
    const dir = home();
    const text = formatHardenPlan(buildHardenPlan(dir, 'single-user', { myUsername: () => 'giusto' }));
    expect(text).toContain('muffin gateway stop');
    expect(text).toContain('muffin gateway start');
    // La frase che #217 ha reso falsa.
    expect(text).not.toContain('il supervisore lo rialza da solo');
  });
});
