import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from '../config/config.js';
import { POLICY_FLOOR, grantedTo, loadPolicyMatrix } from './matrix.js';
import { createDecide } from './decide.js';
import { httpCapability } from '../../agent/tools/http.js';
import type { Principal } from './types.js';

/**
 * `rot/policy.json` was sealed, hashed and read by nobody: the matrix it
 * declares lived as three `const`s in `decide.ts`. These tests pin both halves
 * of the fix — that the file now speaks, and that it cannot speak *louder* than
 * the compiled floor.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-matrix-'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

const policyOf = (dir: string) => join(paths(dir).rot, 'policy.json');

/**
 * The rows carry the ceiling since ADR-0053, so the clamp that matters is
 * theirs. These four exist for the reason the four below them do: an owner-
 * documented knob inside the Root of Trust with correct code and no falsifying
 * evidence is the shape this repository keeps getting caught by, and an
 * independent judge named it on the slice that introduced this one.
 */
describe('le righe della matrice sigillata', () => {
  it('lascia che il file stringa una riga', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, rows: { host: { denyAbove: 1 } } }));
    expect(loadPolicyMatrix(dir).rows.host).toEqual({ asksForIrreversible: true, denyAbove: 1 });
    // E le altre righe restano quelle del pavimento: un file parziale eredita.
    expect(loadPolicyMatrix(dir).rows.context).toEqual(POLICY_FLOOR.rows.context);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rifiuta di lasciargliela allargare, su entrambe le soglie', () => {
    const dir = home();
    // `asksForIrreversible: false` su una riga che il pavimento tiene a
    // `true` è l'allargamento della soglia che ADR-0074 mette al posto di
    // `askAbove`: spegnerebbe la domanda su `sys.shell` con una scrittura di
    // file più un reseal.
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, rows: { host: { asksForIrreversible: false, denyAbove: 3 } } }),
    );
    expect(loadPolicyMatrix(dir).rows.host).toEqual(POLICY_FLOOR.rows.host);

    // Mista: la metà che stringe atterra, quella che allarga no.
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, rows: { host: { asksForIrreversible: false, denyAbove: 1 } } }),
    );
    expect(loadPolicyMatrix(dir).rows.host).toEqual({
      asksForIrreversible: POLICY_FLOOR.rows.host.asksForIrreversible,
      denyAbove: 1,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * **ADR-0074, la conseguenza sul file sigillato.** `askAbove` è sparito da
   * `RowPolicy`: un `policy.json` che lo porta ancora promette un cancello
   * («host chiede sopra taint 1») che questa build non ha più. Ignorarlo in
   * silenzio — che è ciò che uno schema non-strict fa — lascerebbe l'owner a
   * credere in una difesa inesistente, dentro il file che il sistema chiama
   * radice di fiducia. Quindi il file viene **rifiutato**, si torna al
   * pavimento, e la nota nomina il campo: `doctor` la stampa.
   */
  it('rifiuta un file che porta ancora `askAbove`, nominando il campo', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, rows: { host: { askAbove: 1, denyAbove: 2 } } }));
    const m = loadPolicyMatrix(dir);
    expect(m.source).toBe('fallback');
    expect(m.note ?? '').toContain('askAbove');
    // E il pavimento è quello compilato, non una fusione a metà del file.
    expect(m.rows).toEqual(POLICY_FLOOR.rows);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Una riga che si stringe accendendo la domanda dove il pavimento non la fa. */
  it('lascia che il file accenda `asksForIrreversible` su una riga che non chiede', () => {
    const dir = home();
    expect(POLICY_FLOOR.rows.reply.asksForIrreversible).toBe(false);
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, rows: { reply: { asksForIrreversible: true } } }),
    );
    expect(loadPolicyMatrix(dir).rows.reply).toEqual({ asksForIrreversible: true, denyAbove: 3 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignora una riga che il codice non conosce, invece di aggiungerla', () => {
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, rows: { hostt: { denyAbove: 0 }, inventata: { denyAbove: 0 } } }),
    );
    const rows = loadPolicyMatrix(dir).rows;
    expect(Object.keys(rows).sort()).toEqual(Object.keys(POLICY_FLOOR.rows).sort());
    // E il refuso non ha stretto niente: `hostt` non è `host`.
    expect(rows.host).toEqual(POLICY_FLOOR.rows.host);
    rmSync(dir, { recursive: true, force: true });
  });

  it('non lascia risalire la riga che non deve essere raggiungibile a runtime', () => {
    const dir = home();
    // `rot` sta a -1: irraggiungibile a ogni taint. Il tipo del file è 0-3,
    // quindi qualunque valore scrivibile è più largo — e viene scartato.
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, rows: { rot: { denyAbove: 3 } } }));
    expect(loadPolicyMatrix(dir).rows.rot.denyAbove).toBe(-1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('un file illeggibile non allarga niente: si torna al pavimento, e si dice', () => {
    const dir = home();
    writeFileSync(policyOf(dir), '{ "schemaVersion": 1, "rows": { "host": { "denyAbove": "tre" } } }');
    const m = loadPolicyMatrix(dir);
    expect(m.source).toBe('fallback');
    expect(m.note).toBeTruthy();
    expect(m.rows).toEqual(POLICY_FLOOR.rows);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the sealed permission matrix', () => {
  it('lets the file tighten a ceiling and refuses to let it raise one', () => {
    // The judge measured what an unclamped default bought: `{"medium":3}` in a
    // resealed policy.json turned `mcp.*` from "a tainted turn cannot reach a
    // third-party server at all" into a silent allow at taint 3, because that
    // capability — like fs.write and sys.shell — inherits the class default
    // instead of pinning its own. A declaration is a reviewed commit; this file
    // is a write plus a reseal. So it may only lower, exactly like the deny
    // lists may only grow.
    const dir = home();

    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 3, medium: 3, high: 3 } }));
    expect(loadPolicyMatrix(dir).defaultMaxTaint).toEqual(POLICY_FLOOR.defaultMaxTaint);

    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 1, medium: 0, high: 0 } }));
    expect(loadPolicyMatrix(dir).defaultMaxTaint).toEqual({ low: 1, medium: 0, high: 0 });

    // And a mixed file: the tightening half lands, the widening half does not.
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 0, medium: 3 } }));
    const mixed = loadPolicyMatrix(dir).defaultMaxTaint;
    expect(mixed.low).toBe(0);
    expect(mixed.medium).toBe(POLICY_FLOOR.defaultMaxTaint.medium);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the values the kernel used to hardcode, exactly', () => {
    // P2. The JSON and the three `const`s were byte-compatible duplicates on the
    // day this slice started; a default install must not shift behaviour by a
    // single tier because the source of the numbers moved. If this ever goes
    // red, either the file or the floor changed alone — which is the drift the
    // duplication was always going to produce.
    const dir = home();
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.defaultMaxTaint).toEqual({ low: 3, medium: 1, high: 1 });
    expect(matrix.defaultMaxTaint).toEqual(POLICY_FLOOR.defaultMaxTaint);
    expect([...matrix.neverAtRuntime]).toEqual([...POLICY_FLOOR.neverAtRuntime]);
    expect([...matrix.forbiddenForSystem]).toEqual([...POLICY_FLOOR.forbiddenForSystem]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an owner edit instead of the compiled number', () => {
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 0, medium: 0, high: 0 } }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.defaultMaxTaint).toEqual({ low: 0, medium: 0, high: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a policy file that cannot be trusted never widens anything', () => {
  /**
   * The fallback values are asserted literally, not compared to `POLICY_FLOOR`,
   * so that widening the floor turns these red instead of dragging them along.
   */
  const expectFloor = (dir: string, why: RegExp) => {
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toMatch(why);
    expect(matrix.defaultMaxTaint).toEqual({ low: 3, medium: 1, high: 1 });
    expect(matrix.paramsMaxTaint).toBe(1);
    // The namespace entries joined the bare ids when the lookup learned to
    // read them (`denyListCovers`): 03 §3 says `outward.*`, and the Root of
    // Trust row says the RoT, not one verb of it. Both are tightenings — the
    // literal list only ever grows in the deny direction, which is why this
    // assertion stays literal.
    expect([...matrix.neverAtRuntime]).toEqual(['rot.write', 'rot.*']);
    expect([...matrix.forbiddenForSystem]).toEqual(['outward.send', 'outward.*', 'config.ratchet', 'jobs.schedule']);
  };

  it('an absent file degrades to the floor and says so', () => {
    const dir = home();
    rmSync(policyOf(dir));
    expectFloor(dir, /assente/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('unparseable JSON degrades to the floor rather than throwing at boot', () => {
    const dir = home();
    writeFileSync(policyOf(dir), '{ "schemaVersion": 1,');
    expectFloor(dir, /JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a taint tier outside 0..3 invalidates the file, it does not round', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 9 } }));
    expectFloor(dir, /defaultMaxTaint/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a future schemaVersion is not guessed at', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 2, defaultMaxTaint: { low: 0 } }));
    expectFloor(dir, /schemaVersion/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the deny lists are a floor, not a setting', () => {
  it('an emptied neverAtRuntime still denies rot.write', () => {
    // Monotone confinement (ADR-0013): the file may add prohibitions, never
    // remove the shipped ones. Without the union, editing one line of a sealed
    // JSON would hand the runtime a write path into its own root of trust.
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, neverAtRuntime: [], forbiddenForSystem: [] }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.neverAtRuntime.has('rot.write')).toBe(true);
    expect(matrix.forbiddenForSystem.has('outward.send')).toBe(true);
    expect(matrix.forbiddenForSystem.has('config.ratchet')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner may add to them', () => {
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, neverAtRuntime: ['sys.shell'] }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.neverAtRuntime.has('sys.shell')).toBe(true);
    expect(matrix.neverAtRuntime.has('rot.write')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('paramsMaxTaint — monotone floor since lane #624 + #641 (HOLD resolution)', () => {
  /**
   * Fino alla HOLD resolution questo numero era l'unico che il file poteva
   * anche ALZARE, e tre test qui sotto lo provavano. La ragione è caduta con
   * la misura: una home sigillata col vecchio shipped 2 conservava il
   * ceiling 2 dopo l'upgrade e con esso il path P0 owner+tier-2. Ora il
   * clamp è lo stesso `tighter()` di ogni altro ceiling — stringere sì,
   * riallargare mai — e il test che provava il raise prova il confine.
   * Riaprire il confine è una decisione/prodotto separata, non un reseal.
   */
  it('defaults to 1 when the file is genuinely silent — tier-2 disk is attacker-influenced, not owner-authored (lane #624 + #641)', () => {
    const dir = home();
    // `home()` installa `defaults/rot/policy.json`, che la chiave la CONTIENE:
    // asserire sul file installato non prova il default, prova il default del
    // file. Qui si riscrive il file **senza** la chiave — la forma che ha
    // davvero la `~/.muffin` dell'owner, sigillata prima di questa slice —
    // così togliere il `?? POLICY_FLOOR.paramsMaxTaint` in `merge()` va rosso.
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, neverAtRuntime: ['rot.write'] }));
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.paramsMaxTaint).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner edit can lower it', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 0 }));
    expect(loadPolicyMatrix(dir).paramsMaxTaint).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a sealed file can no longer RAISE it above the floor — the widening is confined to 1', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 3 }));
    expect(loadPolicyMatrix(dir).paramsMaxTaint).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an out-of-range value invalidates the whole file, same as defaultMaxTaint', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 9 }));
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toMatch(/paramsMaxTaint/);
    expect(matrix.paramsMaxTaint).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * **I grant per stanza — ADR-0073 punto 1.**
 *
 * L'unico campo di questo file che *allarga*, quindi l'unico su cui il
 * rifiuto deve essere rumoroso: un grant che il kernel non applicherà è la
 * stessa classe di guasto di un `askAbove` letto e scartato — il sigillo
 * promette un comportamento che il codice non ha.
 */
describe('grant per stanza nel sigillo (ADR-0073)', () => {
  const conTenants = (tenants: unknown): string => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, tenants }));
    return dir;
  };

  it('il pavimento non concede niente a nessuna stanza', () => {
    expect(POLICY_FLOOR.grants.size).toBe(0);
    // E un file che non nomina `tenants` non ne inventa: eredita il vuoto.
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1 }));
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.grants.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('una stanza nominata riceve esattamente le capability elencate', () => {
    const dir = conTenants({
      'group:telegram:-100950': { grants: ['vault.write', 'sys.search'] },
      'community:vicinato': { grants: ['turn.todo'] },
    });
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect([...(matrix.grants.get('group:telegram:-100950') ?? [])].sort()).toEqual([
      'sys.search',
      'vault.write',
    ]);
    expect(grantedTo(matrix, 'group:telegram:-100950', 'vault.write')).toBe(true);
    // Per stanza, non per famiglia di stanze: un'altra stanza non eredita.
    expect(grantedTo(matrix, 'group:telegram:-100951', 'vault.write')).toBe(false);
    // E per capability, non per prefisso: `sys.search` concesso non concede
    // `sys.shell`, nemmeno se qualcuno spedisse `sys.search.qualcosa` domani.
    expect(grantedTo(matrix, 'group:telegram:-100950', 'sys.shell')).toBe(false);
    expect(grantedTo(matrix, 'community:vicinato', 'turn.todo')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Il cuore del punto 1: la lista chiusa. Ogni voce provata per nome, perché
   * una lista di divieti che nessuno enumera è una lista di cui si può
   * perdere una riga in un giro di pulizia senza che niente diventi rosso.
   *
   * Il rifiuto è del **file intero** — non del solo grant illecito — e
   * nomina il campo: è la stessa decisione che `.strict()` prende per
   * `askAbove`, e la ragione è identica. Un file che concede `sys.shell` a un
   * gruppo è un file che l'owner ha scritto credendo qualcosa di falso;
   * leggerne il resto e tacere sulla riga rifiutata lo lascerebbe crederlo.
   */
  it.each([
    ['sys.shell', 'la shell'],
    ['sys.shell.write', 'la shell che scrive'],
    ['sys.process.kill', 'i processi'],
    ['fs.write', 'il disco'],
    ['fs.read', 'il disco in lettura'],
    ['rot.write', 'la radice di fiducia'],
    ['outward.send', 'un destinatario nuovo'],
    ['config.ratchet', 'la configurazione'],
    ['surface.send_file', 'il vault condiviso tra stanze'],
    ['skill.read', 'il catalogo install-wide delle skill'],
    ['sys.inspect', 'lo stato host dell’installazione'],
    ['jobs.schedule', 'la semantica di gruppo non ancora definita'],
  ])('nessun sigillo concede %s a una stanza (%s)', (capability) => {
    const dir = conTenants({ 'group:telegram:42': { grants: ['vault.write', capability] } });
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    // Il nome del campo, cioè dove intervenire, e il nome della capability.
    expect(matrix.note).toContain('tenants.group:telegram:42.grants.1');
    expect(matrix.note).toContain(capability);
    // E niente passa: nemmeno il grant lecito che stava nella stessa riga.
    expect(matrix.grants.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('un grant non nomina mai una famiglia di capability', () => {
    const dir = conTenants({ 'group:telegram:42': { grants: ['memory.*'] } });
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toContain('tenants.group:telegram:42.grants.0');
    expect(matrix.note).toContain('mai una famiglia');
    rmSync(dir, { recursive: true, force: true });
  });

  it('un grant non nomina mai un insieme di stanze, e mai host', () => {
    for (const chiave of ['group:*', '*', 'host', 'group:telegram:*']) {
      const dir = conTenants({ [chiave]: { grants: ['vault.write'] } });
      const matrix = loadPolicyMatrix(dir);
      expect(`${chiave}: ${matrix.source}`).toBe(`${chiave}: fallback`);
      expect(matrix.note).toContain(`tenants.${chiave}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('una chiave sconosciuta dentro un blocco che concede ferma il file, come per le righe', () => {
    const dir = conTenants({ 'group:telegram:42': { grants: ['vault.write'], denyAbove: 3 } });
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toContain('denyAbove');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Legacy-home regression (lane #624 + #641 repair, HOLD resolution).
 *
 * The previous shipped template pinned `"paramsMaxTaint": 2`, and `merge()`
 * honoured it verbatim (`file.paramsMaxTaint ?? POLICY_FLOOR`) — so an
 * existing home kept ceiling 2 after upgrade and preserved the P0
 * owner+tier-2 silent-egress path the lane exists to close. "Sealed
 * explicit-2 keeps it" was declared as residual and rejected: the sealed file
 * may tighten below the new floor, never re-widen above it (`tighter()`).
 */
describe('legacy home sealed with the previous shipped ceiling', () => {
  /** The exact previous shipped `defaults/rot/policy.json` (dev@35bde7b1), `_comment` included. */
  const LEGACY_SHIPPED = {
    _comment:
      'Permission matrix, read at boot by core/policy/matrix.ts. Part of the Root of Trust: the agent loop cannot change this at runtime, and your own edits take effect after `muffin rot reseal` and a restart. Since ADR-0053 the taint ceiling comes from each capability\'s EFFECT ROW — where the bytes of the effect land — and the shipped rows are ROW_FLOOR in core/policy/matrix.ts, transcribed from the threat model\'s own matrix. An optional `rows` object here may TIGHTEN a row ({"rows":{"host":{"denyAbove":1}}}) and never widen one; a row name this build does not know is ignored. `defaultMaxTaint` is kept so a home sealed before ADR-0053 still parses, and no longer decides anything. The two deny lists may only grow — removing a shipped entry from them does nothing. `paramsMaxTaint` is the one ceiling here the file may also RAISE, not just lower — it gates model-chosen bytes in a URL\'s query/fragment or a search query, above which the owner is asked and everyone else is refused. Ships 2: tier 2 is your own disk, tier 3 is the outside world (web, search, MCP, forwarded content).',
    schemaVersion: 1,
    defaultMaxTaint: { low: 3, medium: 1, high: 1 },
    paramsMaxTaint: 2,
    neverAtRuntime: ['rot.write'],
    forbiddenForSystem: ['outward.send', 'config.ratchet'],
  };

  const legacyHome = (): string => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify(LEGACY_SHIPPED));
    return dir;
  };

  it('a previous-shipped policy.json pinning paramsMaxTaint 2 loads confined to the new floor 1', () => {
    const dir = legacyHome();
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.paramsMaxTaint).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('production path on the legacy ceiling: owner-composed path/query at tier 2 asks, never silently allows', () => {
    const dir = legacyHome();
    const matrix = loadPolicyMatrix(dir);
    const decide = createDecide({
      capabilities: new Map([[httpCapability.id, httpCapability]]),
      matrix,
      budgetExhausted: () => false,
      hardened: true,
    });
    const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
    // Owner turn after a hostile tier-2 disk read; the model composed both
    // URLs (nothing quoted). Either one leaving silently is the P0 path.
    for (const url of [
      'https://public-attacker.example/?d=SECRET-BYTES',
      'https://public-attacker.example/SECRET-BYTES',
    ]) {
      const d = decide({
        principal: owner,
        tenant: 'host',
        capability: 'sys.http',
        resource: { kind: 'url-read', value: url },
        args: { url },
        taint: 2,
      });
      expect(`${url}: ${d.effect}`).toBe(`${url}: ask`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
