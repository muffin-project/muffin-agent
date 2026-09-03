import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { widenEgressForCapability } from './egress-writer.js';
import { verify } from './verify.js';
import { paths } from '../config/config.js';

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'muffin-egress-writer-'));
  runInit({ home: h, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
  return h;
}

const raccogli = (): { out: string[]; sink: (l: string) => void } => {
  const out: string[] = [];
  return { out, sink: (l) => void out.push(l) };
};

function egressAllow(h: string): string[] {
  return JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8')).allow;
}

describe('widenEgressForCapability', () => {
  it('un host già in allowlist non chiede nulla e non tocca il file', async () => {
    const h = home();
    const egressPath = join(paths(h).rot, 'egress.json');
    const prima = readFileSync(egressPath, 'utf8');
    writeFileSync(egressPath, JSON.stringify({ schemaVersion: 1, allow: ['già-dentro.example'] }, null, 2));
    let chiesto = 0;
    const out = widenEgressForCapability(h, ['già-dentro.example'], 'test', {
      out: () => {},
      chiediConferma: () => {
        chiesto += 1;
        return Promise.resolve('si');
      },
    });
    expect((await out).ok).toBe(true);
    expect(chiesto).toBe(0);
    expect(prima).not.toBe(readFileSync(egressPath, 'utf8')); // riscritto sopra dal test, non da widenEgress
  });

  /**
   * Il caso non-interattivo — quello che il figlio sandboxato di `sys.shell`
   * produce sempre, perché il suo stdin non è mai un TTY (`stdio: ['ignore',
   * 'pipe', 'pipe']`, `core/sandbox/executor.ts`). Nessun flag può forzarlo:
   * `deps.chiediConferma` è assente perché nessuno lo ha cablato, non perché
   * un parametro dice "salta la domanda".
   */
  it('senza terminale (chiediConferma assente): rifiuta, non scrive, stampa il rimedio a mano', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', { out: sink });
    expect(esito.ok).toBe(false);
    expect(egressAllow(h)).toEqual([]);
    const testo = out.join('\n');
    expect(testo).toContain('api.tavily.com');
    expect(testo).toContain('nessun terminale interattivo');
    expect(testo).toContain(join(paths(h).rot, 'egress.json'));
    expect(testo).toContain('muffin rot reseal');
    // Il root of trust non si è mosso: verify resta pulito.
    expect(verify(h, 'single-user').ok).toBe(true);
  });

  it('rifiuto esplicito dell owner ("n"): non scrive nulla', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
      out: sink,
      chiediConferma: () => Promise.resolve('n'),
    });
    expect(esito.ok).toBe(false);
    expect(egressAllow(h)).toEqual([]);
  });

  it('Ctrl+D / EOF sulla domanda (chiediConferma risolve undefined): non scrive nulla', async () => {
    const h = home();
    const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
      out: () => {},
      chiediConferma: () => Promise.resolve(undefined),
    });
    expect(esito.ok).toBe(false);
    expect(egressAllow(h)).toEqual([]);
  });

  it('conferma esplicita ("s"): aggiunge esattamente l host nominato e risigilla', async () => {
    const h = home();
    const domande: string[] = [];
    const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
      out: () => {},
      chiediConferma: (d) => {
        domande.push(d);
        return Promise.resolve('s');
      },
    });
    expect(esito).toEqual({ ok: true, added: ['api.tavily.com'] });
    expect(egressAllow(h)).toEqual(['api.tavily.com']);
    expect(domande).toHaveLength(1);
    expect(domande[0]).toContain('api.tavily.com');
    expect(domande[0]).toContain('la ricerca web (Tavily)');
    // Il root of trust è di nuovo integro, non degradato.
    const stato = verify(h, 'single-user');
    expect(stato.ok).toBe(true);
  });

  it('una allowlist non vuota resta intatta: si aggiunge, non si sostituisce', async () => {
    const h = home();
    const egressPath = join(paths(h).rot, 'egress.json');
    writeFileSync(
      egressPath,
      JSON.stringify({ _comment: 'nota owner', schemaVersion: 1, allow: ['altro.example'] }, null, 2),
    );
    await widenEgressForCapability(h, ['nuovo.example'], 'test', {
      out: () => {},
      chiediConferma: () => Promise.resolve('sì'),
    });
    const scritto = JSON.parse(readFileSync(egressPath, 'utf8'));
    expect(scritto.allow).toEqual(['altro.example', 'nuovo.example']);
    expect(scritto._comment).toBe('nota owner');
  });

  it('più host nominati insieme: una sola domanda, tutti aggiunti', async () => {
    const h = home();
    let chiesto = 0;
    const esito = await widenEgressForCapability(h, ['a.example', 'b.example'], 'un server MCP', {
      out: () => {},
      chiediConferma: () => {
        chiesto += 1;
        return Promise.resolve('y');
      },
    });
    expect(chiesto).toBe(1);
    expect(esito).toEqual({ ok: true, added: ['a.example', 'b.example'] });
    expect(egressAllow(h)).toEqual(['a.example', 'b.example']);
  });

  it('non inferisce host non nominati: chiede e scrive solo quelli passati', async () => {
    const h = home();
    await widenEgressForCapability(h, ['solo-questo.example'], 'test', {
      out: () => {},
      chiediConferma: () => Promise.resolve('s'),
    });
    expect(egressAllow(h)).toEqual(['solo-questo.example']);
  });
});

describe('widenEgressForCapability — permesso negato al risigillo', () => {
  afterEach(() => {
    // Niente da ripulire oltre il tmpdir stesso: mkdtempSync ognuno il suo.
  });

  it.skipIf(platform() === 'win32' || process.getuid?.() === 0)(
    'rot/ non scrivibile da questo processo: non scrive, dice permesso negato, non lascia un file a metà',
    async () => {
      const h = home();
      const rotDir = paths(h).rot;
      const egressPath = join(rotDir, 'egress.json');
      const prima = readFileSync(egressPath, 'utf8');
      // Il permesso che conta per riscrivere un file ESISTENTE è quello del
      // file, non della directory che lo contiene — chmod solo sulla
      // directory lascia `writeFileSync` libero di troncare l'inode com'era.
      chmodSync(egressPath, 0o400);
      try {
        const { out, sink } = raccogli();
        const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
          out: sink,
          chiediConferma: () => Promise.resolve('s'),
        });
        expect(esito.ok).toBe(false);
        expect(out.join('\n')).toMatch(/permesso negato/);
      } finally {
        chmodSync(egressPath, 0o600);
      }
      expect(readFileSync(egressPath, 'utf8')).toBe(prima);
    },
  );
});
