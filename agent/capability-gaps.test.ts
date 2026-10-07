import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths, writeSecret } from '../core/config/config.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import type { Principal } from '../core/policy/types.js';
import { seal } from '../core/rot/verify.js';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityExposure,
} from './capability-exposure.js';
import { visibleTools } from './context/assemble.js';
import { toolContext } from './fixtures/tool-context.js';
import { buildRuntime } from './runtime.js';
import { makeSendFileTool, sendFileCapability } from './tools/deliver.js';

/**
 * A tool that is off can say why — end to end, not just in the formatter.
 *
 * The owner's real 03/09/2026 turn: `config.json` declared Tavily, `rot/
 * egress.json` never allowlisted `api.tavily.com`, and three retries against
 * "il tool non mi è esposto in questo turno" taught nothing the log did not
 * already say once, at boot (`! web_search spento: api.tavily.com non è in
 * rot/egress.json`, exactly once in a 415 KB `gateway.err`). This file proves
 * the same reason reaches `sys_inspect`'s actual output, through the real
 * `buildRuntime` wiring — not a fake `InspectSources` object standing in for
 * it (that unit-level coverage is `agent/tools/inspect.test.ts`).
 */
function homeConTavilySenzaEgress(): { home: string; workspace: string } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-capgap-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-capgap-ws-'));
  runInit({ home, apiKey: 'sk-never-called' });

  const configPath = paths(home).config;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.search = { provider: 'tavily', apiKeyRef: 'secret://tavily' };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeSecret('tavily', 'tvly-test-key', home);
  // `rot/egress.json` resta quello di `muffin init`: nessun host aggiunto,
  // esattamente la lacuna dell'owner.

  return { home, workspace };
}

describe('una capacità spenta lo dice, non solo al log', () => {
  it("sys_inspect nomina motivo e rimedio della situazione esatta dell'owner (web_search)", async () => {
    const { home, workspace } = homeConTavilySenzaEgress();
    const runtime = buildRuntime(home, workspace);
    try {
      expect(runtime.deps.tools.map((t) => t.spec.name)).not.toContain('web_search');

      // Prima verifica: il produttore strutturato, non solo il testo reso.
      const gap = runtime.capabilityGaps.find((g) => g.capability === 'web_search');
      expect(gap).toBeDefined();
      expect(gap?.kind).toBe('disabled');
      expect(gap?.reason).toContain('api.tavily.com');
      expect(gap?.reason).toContain('rot/egress.json');
      expect(gap?.remedy).toContain('rot reseal');

      // Seconda verifica: lo stesso, dentro un turno vero — il tool reale
      // registrato da buildRuntime, non un InspectSources ricostruito a mano.
      const inspect = runtime.deps.tools.find((t) => t.spec.name === 'sys_inspect');
      expect(inspect).toBeDefined();
      const out = await inspect!.handler({}, toolContext());
      expect(out.content).toContain('web_search');
      expect(out.content).toContain('api.tavily.com');
      expect(out.content).toContain('rot/egress.json');
      expect(out.content).toContain('rot reseal');
    } finally {
      runtime.close();
    }
  });

  it('il rimedio sparisce quando l’owner allowlista l’host e risigilla', async () => {
    // La riparazione reale dell'owner, misurata: non basta scrivere la chiave,
    // l'host va aggiunto a rot/egress.json e il sigillo va rifatto.
    const { home, workspace } = homeConTavilySenzaEgress();

    const egressPath = join(paths(home).rot, 'egress.json');
    const egress = JSON.parse(readFileSync(egressPath, 'utf8'));
    egress.allow = ['api.tavily.com'];
    writeFileSync(egressPath, JSON.stringify(egress, null, 2));
    seal(home, '1', new Date());

    const runtime = buildRuntime(home, workspace);
    try {
      expect(runtime.deps.tools.map((t) => t.spec.name)).toContain('web_search');
      expect(runtime.capabilityGaps.find((g) => g.capability === 'web_search')).toBeUndefined();

      const inspect = runtime.deps.tools.find((t) => t.spec.name === 'sys_inspect');
      const out = await inspect!.handler({}, toolContext());
      // The claim is about *this* remedy (web_search), not "no gaps exist on
      // the host": on Linux with bwrap < 0.12.0 the shared shell boundary
      // (#642) correctly keeps shell_run in the same section, and a blanket
      // `not.toContain('Capacità spente')` would fail there for a gap this
      // test never fixed. End-to-end through the real tool, not just the
      // structured producer asserted above.
      expect(out.content).not.toMatch(/✗\s*web_search/);
    } finally {
      runtime.close();
    }
  });

  it('un tool oltre il tetto resta discoverable e non viene più dichiarato tagliato', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capgap-tetto-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-capgap-tetto-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const configPath = paths(home).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.models.main = 'modello-mai-schedato-xyz';
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const runtime = buildRuntime(home, workspace);
    try {
      expect(runtime.deps.profile.name).toBe('conservative');
      expect(runtime.deps.profile.maxToolsExposed).toBe(10);

      // #469 changes the meaning of the profile ceiling: it bounds the schema
      // projection, not whether an authorized capability exists.
      expect(runtime.capabilityGaps.filter((g) => g.kind === 'truncated')).toEqual([]);

      const inspect = runtime.deps.tools.find((t) => t.spec.name === 'sys_inspect');
      const out = await inspect!.handler({}, toolContext());
      expect(out.content).toContain('catalogo discoverable');
      expect(out.content).toContain('maxToolsExposed limita gli schema caricati');
      expect(out.content).not.toContain('tagliate dal tetto');
    } finally {
      runtime.close();
    }
  });

  it('send_file registrato tardi entra nel catalogo discoverable invece di diventare irraggiungibile', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capgap-sendfile-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-capgap-sendfile-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });

    const runtime = buildRuntime(home, workspace);
    try {
      const primaDiSendFile = runtime.deps.tools.length;
      expect(runtime.deps.tools.map((t) => t.spec.name)).not.toContain('send_file');

      // Before the late tool arrives the non-discovery catalogue fits exactly.
      runtime.deps.profile.maxToolsExposed = primaDiSendFile - 1;

      const vaultRoot = paths(home).vault;
      runtime.register(
        makeSendFileTool({
          scope: { root: vaultRoot, denyWrite: [], denyRead: [] },
          deliverFile: async () => ({ delivered: false, why: 'test: nessun registro superfici' }),
        }),
        sendFileCapability,
      );
      expect(runtime.deps.tools.map((t) => t.spec.name)).toContain('send_file');

      // Late registration still refreshes the deterministic live order, but
      // there is no longer a false "truncated" availability gap.
      expect(runtime.recomputeExposure()).toEqual([]);
      expect(runtime.capabilityGaps.filter((g) => g.kind === 'truncated')).toEqual([]);

      const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
      const eligible = visibleTools(
        runtime.deps.tools,
        owner,
        runtime.deps.capabilities,
        runtime.deps.grants?.get('host'),
      );
      const discoveryTool = eligible.find(
        (tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(discoveryTool).toBeDefined();
      const projection = createCapabilityExposure({
        eligible,
        maxToolsExposed: runtime.deps.profile.maxToolsExposed,
        discoveryTool: discoveryTool!,
      });
      expect(projection.pressured).toBe(true);
      expect(projection.exposed.map((t) => t.spec.name)).not.toContain('send_file');

      const found = projection.discovery?.searchAndLoad('send file to the user', 2);
      expect(found?.loaded.map((entry) => entry.name)).toContain('send_file');
      projection.discovery?.activatePending();
      expect(projection.exposed.map((t) => t.spec.name)).toContain('send_file');
    } finally {
      runtime.close();
    }
  });

});

/**
 * **Cosa raggiunge davvero un membro di una stanza — con e senza grant
 * (ADR-0073).**
 *
 * Questo file è ciò che l'ADR cita per la frase *«oggi un membro raggiunge
 * `documents.read`, `sys.http` (lettura), `memory.*`, `surface.reply`; tutto
 * il resto è `hostOnly`»*. Quella frase era vera e non era scritta qui: la
 * misura viveva in una sessione, non in un'asserzione, e una misura che
 * nessuno riesegue è una frase che invecchia in silenzio. Adesso è
 * un'enumerazione, e ha due colonne perché da ADR-0073 la risposta dipende da
 * **quale** stanza.
 *
 * Passa dal `buildRuntime` vero e dalla `rot/policy.json` **sigillata**, non
 * da una `PolicyMatrix` costruita a mano: il grant è una manopola che vive nel
 * sigillo, e provarla su un oggetto in memoria proverebbe la funzione senza
 * provare che l'owner possa girarla.
 */
describe('cosa raggiunge un membro, con e senza grant (ADR-0073)', () => {
  const STANZA_CON_GRANT = 'group:telegram:-100950';
  const STANZA_SENZA = 'group:telegram:-100777';
  const CONCESSE = ['vault.write', 'turn.todo', 'turn.wait'];

  function homeConGrant(): { home: string; workspace: string } {
    const home = mkdtempSync(join(tmpdir(), 'muffin-grant-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-grant-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const policy = join(paths(home).rot, 'policy.json');
    writeFileSync(
      policy,
      JSON.stringify(
        { schemaVersion: 1, tenants: { [STANZA_CON_GRANT]: { grants: CONCESSE } } },
        null,
        2,
      ),
    );
    // La stessa cosa che fa `muffin rot reseal`: senza, il file diverge dal
    // manifest e la home entra in safe mode invece di leggere il grant.
    seal(home, '1', new Date());
    return { home, workspace };
  }

  const membro = (tenantId: string): Principal => ({
    kind: 'member',
    connector: 'telegram',
    tenantId,
    externalId: 'u1',
  });

  /** Il menu iniziale che il modello vede per quel principal, per nome di tool. */
  function menu(runtime: ReturnType<typeof buildRuntime>, tenantId: string): string[] {
    const eligible = visibleTools(
      runtime.deps.tools,
      membro(tenantId),
      runtime.deps.capabilities,
      runtime.deps.grants?.get(tenantId),
    );
    const discoveryTool = eligible.find(
      (tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME,
    );
    return createCapabilityExposure({
      eligible,
      maxToolsExposed: runtime.deps.profile.maxToolsExposed,
      ...(discoveryTool === undefined ? {} : { discoveryTool }),
    })
      .exposed.map((t) => t.spec.name)
      .sort();
  }

  /** Cosa il kernel vero concede a quel principal, per id di capability. */
  function raggiunte(runtime: ReturnType<typeof buildRuntime>, tenantId: string): string[] {
    const out: string[] = [];
    for (const [id, decl] of runtime.deps.capabilities) {
      const d = runtime.deps.decide({
        principal: membro(tenantId),
        tenant: tenantId,
        capability: id,
        resource:
          decl.resourceKind === 'path'
            ? { kind: 'path', value: '/tmp/x' }
            : decl.resourceKind === 'url-read'
              ? // Bare host on purpose: this file proves ADR-0073 grant
                // mechanics (which capabilities a member reaches), and composed
                // URL bytes answer to the params gate instead (`decide.ts`,
                // lane #624 + #641) — a fixture with a path would measure the
                // gate here instead of the grant.
                { kind: 'url-read', value: 'https://esempio.test/' }
              : decl.resourceKind === 'url'
                ? { kind: 'url', value: 'https://esempio.test/' }
                : decl.resourceKind === 'query'
                  ? { kind: 'query', value: 'q' }
                  : decl.resourceKind === 'tenant'
                    ? { kind: 'tenant', value: tenantId }
                    : { kind: 'none' },
        args: {},
        // 2 e non 0: è il taint di un membro per costruzione (`tierOf`), cioè
        // il numero con cui questa domanda si pone davvero.
        taint: 2,
      });
      if (d.effect !== 'deny') out.push(id);
    }
    return out.sort();
  }

  it('senza grant: la stessa lista di sempre, e niente di più', () => {
    const { home, workspace } = homeConGrant();
    const runtime = buildRuntime(home, workspace);
    try {
      // La frase dell'ADR, eseguita. `surface.reply` e `memory.write` sono le
      // due porte del loop (`DOORS`), che non compaiono in `capabilities`.
      expect(raggiunte(runtime, STANZA_SENZA)).toEqual([
        'documents.read',
        'memory.read',
        'sys.capability_discover',
        'sys.http',
      ]);
      expect(menu(runtime, STANZA_SENZA)).toEqual([
        'document_read',
        'http_get',
        'memory_search',
        'memory_why',
      ]);
      // In particolare, ciò che una stanza non riceverà mai.
      expect(raggiunte(runtime, STANZA_SENZA)).not.toContain('sys.shell');
      expect(raggiunte(runtime, STANZA_SENZA)).not.toContain('fs.write');
      expect(raggiunte(runtime, STANZA_SENZA)).not.toContain('vault.write');
    } finally {
      runtime.close();
    }
  });

  it('con grant: le tre concesse in più, per nome, e nient’altro', () => {
    const { home, workspace } = homeConGrant();
    const runtime = buildRuntime(home, workspace);
    try {
      expect(runtime.deps.grants?.get(STANZA_CON_GRANT)).toBeDefined();
      const con = raggiunte(runtime, STANZA_CON_GRANT);
      const senza = raggiunte(runtime, STANZA_SENZA);
      // La differenza è **esattamente** ciò che il sigillo ha nominato: un
      // grant aggiunge per nome, e questa sottrazione è ciò che va rosso se
      // un giorno concedesse per famiglia.
      expect(con.filter((id) => !senza.includes(id))).toEqual([...CONCESSE].sort());
      expect(senza.filter((id) => !con.includes(id))).toEqual([]);

      // E il menu segue il kernel: una capability concessa che il modello non
      // vede è un grant che non si usa mai (`visibleTools`, quarto argomento).
      expect(menu(runtime, STANZA_CON_GRANT)).toContain('vault_save');
      expect(menu(runtime, STANZA_CON_GRANT)).toContain('todo');
      expect(menu(runtime, STANZA_CON_GRANT)).toContain('wait');
      expect(menu(runtime, STANZA_SENZA)).not.toContain('vault_save');

      // La shell resta fuori nella stanza che salva: è l'affermazione (c) di F7.
      expect(con).not.toContain('sys.shell');
      expect(menu(runtime, STANZA_CON_GRANT)).not.toContain('shell_run');
    } finally {
      runtime.close();
    }
  });

  it('un grant che nomina la shell fa cadere il file intero, e doctor lo dice', () => {
    // Il verso rumoroso del rifiuto: non «quel grant è ignorato», ma «questo
    // file non si usa», con il nome del campo. Altrimenti l'owner resta a
    // credere di aver concesso qualcosa a metà.
    const home = mkdtempSync(join(tmpdir(), 'muffin-grant-no-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-grant-no-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });
    writeFileSync(
      join(paths(home).rot, 'policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        tenants: { [STANZA_CON_GRANT]: { grants: ['sys.shell'] } },
      }),
    );
    seal(home, '1', new Date());

    const matrix = loadPolicyMatrix(home);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toContain('tenants.group:telegram:-100950.grants.0');
    expect(matrix.note).toContain('sys.shell');
    expect(matrix.grants.size).toBe(0);
  });
});
