import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths, writeSecret } from '../core/config/config.js';
import { seal } from '../core/rot/verify.js';
import { visibleTools } from './context/assemble.js';
import { loadPolicyMatrix } from '../core/policy/matrix.js';
import type { Principal } from '../core/policy/types.js';
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

  it('send_file, registrato dopo buildRuntime come fa cli/gateway.ts, non cade dal tetto per accidente di quando si registra', async () => {
    /**
     * Il difetto misurato: `send_file` (`cli/surface.ts#attachSendFile`, DAY-1
     * B14) si registra **dopo** che `buildRuntime` è tornato — il
     * `SurfaceRegistry` che gli serve non esiste ancora a quel punto del boot
     * (`registry` resta `null` in `cli/gateway.ts` fino a `connectSurfaces`,
     * chiamato dopo `buildRuntime`). Il calcolo del taglio che gira **dentro**
     * `buildRuntime` non può quindi vederlo, e prima di questa riparazione
     * restava così per sempre: l'annuncio del taglio era la fotografia di un
     * boot che non aveva ancora finito di registrare tool.
     *
     * `runtime.recomputeExposure()` è la riparazione: rifà il calcolo sul
     * registro *live*, ordinato per priorità dichiarata (`baseToolOrder`, che
     * ora include `send_file` prima di `wait`/`todo`/`sys_inspect` — le tre
     * che il repository dichiara già, per iscritto, come le prime a cadere).
     */
    const home = mkdtempSync(join(tmpdir(), 'muffin-capgap-sendfile-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-capgap-sendfile-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });

    const runtime = buildRuntime(home, workspace);
    try {
      const primaDiSendFile = runtime.deps.tools.length;
      expect(runtime.deps.tools.map((t) => t.spec.name)).not.toContain('send_file');

      // Un tetto che, sul registro base (senza `send_file`), non taglierebbe
      // niente — esattamente come sull'installazione reale dell'owner
      // (misurato: 14-15 tool base contro un tetto di 15). L'unico modo per
      // farlo tagliare è aggiungere il tool che oggi si registra per ultimo.
      runtime.deps.profile.maxToolsExposed = primaDiSendFile;
      expect(runtime.capabilityGaps.filter((g) => g.kind === 'truncated')).toEqual([]);

      // La stessa fabbrica e la stessa chiamata di `attachSendFile`, dopo che
      // `buildRuntime` è già tornato — non un tool finto sostituito al suo posto.
      const vaultRoot = paths(home).vault;
      runtime.register(
        makeSendFileTool({
          scope: { root: vaultRoot, denyWrite: [], denyRead: [] },
          deliverFile: async () => ({ delivered: false, why: 'test: nessun registro superfici' }),
        }),
        sendFileCapability,
      );
      expect(runtime.deps.tools.map((t) => t.spec.name)).toContain('send_file');

      // Il produttore dell'annuncio (`cli/gateway.ts`/`cli/repl.ts`) chiama
      // questo esattamente qui: dopo ogni `attach*` del boot, mai prima.
      const righe = runtime.recomputeExposure();
      const tagliati = runtime.capabilityGaps.filter((g) => g.kind === 'truncated');

      // L'asserzione che deve diventare rossa alla mutazione "rimetti il
      // calcolo dentro buildRuntime, prima che send_file esista": senza
      // `recomputeExposure` che rilegge il registro live, `tagliati` qui
      // resterebbe `[]` (la fotografia di prima, presa quando `send_file` non
      // esisteva ancora) invece di nominare il tool tagliato per davvero.
      //
      // E se invece `baseToolOrder` tornasse a non conoscere `send_file` (la
      // seconda mutazione, quella di questa stessa riparazione): l'ordinamento
      // lo spingerebbe in coda a tutto, oltre `sys_inspect`, e sarebbe
      // `send_file` — il tool DAY-1, non lo scaffolding — a cadere qui al
      // posto suo. Nessuna delle due mutazioni lascia `['sys_inspect']` come
      // unico tagliato.
      expect(tagliati.map((g) => g.capability)).toEqual(['sys_inspect']);
      expect(righe.some((riga) => riga.startsWith('sys_inspect tagliato'))).toBe(true);
      expect(righe.some((riga) => riga.includes('send_file'))).toBe(false);
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
      JSON.stringify({ schemaVersion: 1, tenants: { [STANZA_CON_GRANT]: { grants: CONCESSE } } }, null, 2),
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

  /** Il menu che il modello vede per quel principal, per nome di tool. */
  function menu(runtime: ReturnType<typeof buildRuntime>, tenantId: string): string[] {
    return visibleTools(
      runtime.deps.tools,
      membro(tenantId),
      runtime.deps.capabilities,
      runtime.deps.grants?.get(tenantId),
    )
      .map((t) => t.spec.name)
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
              ? // Host nudo di proposito: qui si misura la raggiungibilità di
                // riga (il grant apre la capability?), non il cancello di
                // provenienza — un path composto nega per ADR-0071 anche a
                // taint di stanza (provato in link-copiato-non-e-composto).
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
      expect(raggiunte(runtime, STANZA_SENZA)).toEqual(['documents.read', 'memory.read', 'sys.http']);
      expect(menu(runtime, STANZA_SENZA)).toEqual(['document_read', 'http_get', 'memory_search', 'memory_why']);
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
      JSON.stringify({ schemaVersion: 1, tenants: { [STANZA_CON_GRANT]: { grants: ['sys.shell'] } } }),
    );
    seal(home, '1', new Date());

    const matrix = loadPolicyMatrix(home);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toContain('tenants.group:telegram:-100950.grants.0');
    expect(matrix.note).toContain('sys.shell');
    expect(matrix.grants.size).toBe(0);
  });
});
