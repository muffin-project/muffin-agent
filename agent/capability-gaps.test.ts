import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths, writeSecret } from '../core/config/config.js';
import { seal } from '../core/rot/verify.js';
import { toolContext } from './fixtures/tool-context.js';
import { buildRuntime } from './runtime.js';

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
      expect(out.content).not.toContain('Capacità spente');
    } finally {
      runtime.close();
    }
  });

  it('un tool tagliato dal tetto del profilo è distinto da uno spento, non la stessa parola', async () => {
    // Nessun profilo spedito taglia oggi (consumer-local: 15, frontier: 24,
    // contro una dozzina di tool base — runtime-exposure.test.ts lo misura).
    // Un id modello che non combacia con nessun `match` risolve su
    // CONSERVATIVE (maxToolsExposed: 10), che invece taglia davvero: è la
    // stessa strada che `cli/doctor.ts` già percorre per dire "profilo
    // conservativo" quando il modello configurato non è riconosciuto.
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

      const tagliati = runtime.capabilityGaps.filter((g) => g.kind === 'truncated');
      const spenti = runtime.capabilityGaps.filter((g) => g.kind === 'disabled');
      expect(tagliati.length).toBeGreaterThan(0);
      // Distintamente etichettato: `kind` separa le due domande, e nessuna
      // riga «tagliata» condivide la parola con cui si dice una capacità
      // spenta (e viceversa) — altrimenti il collasso che il compito descrive
      // sarebbe ancora qui, solo spostato di un campo.
      for (const g of tagliati) {
        expect(g.reason).toContain('tetto');
        expect(g.reason).not.toContain('spento');
      }
      for (const g of spenti) {
        expect(g.reason).not.toContain('tetto');
      }

      const inspect = runtime.deps.tools.find((t) => t.spec.name === 'sys_inspect');
      const out = await inspect!.handler({}, toolContext());
      expect(out.content).toContain('tagliate dal tetto');
      expect(out.content).toContain('maxToolsExposed');
    } finally {
      runtime.close();
    }
  });
});
