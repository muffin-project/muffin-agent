import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { isValidEgressHost, widenEgressForCapability } from './egress-writer.js';
import { verify } from './verify.js';
import { paths } from '../config/config.js';
import { hostAllowed } from '../net/egress.js';

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
    writeFileSync(egressPath, JSON.stringify({ schemaVersion: 1, allow: ['gia-dentro.example'] }, null, 2));
    let chiesto = 0;
    const out = widenEgressForCapability(h, ['gia-dentro.example'], 'test', {
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

  /**
   * Un host a due sole etichette (`solo-questo.example`) non distinguerebbe
   * "scrivi esattamente questo" da un'eventuale mutazione che allargasse a
   * `*.example` — la parte dopo il primo punto resterebbe un dominio
   * plausibile. Tre etichette rendono l'asserzione stringente: qualunque
   * forma diversa dall'esatta stringa passata (compreso un wildcard dedotto
   * dal genitore) fa fallire `toEqual`.
   */
  it('non inferisce host non nominati: chiede e scrive solo quelli passati', async () => {
    const h = home();
    await widenEgressForCapability(h, ['sub.solo-questo.example'], 'test', {
      out: () => {},
      chiediConferma: () => Promise.resolve('s'),
    });
    expect(egressAllow(h)).toEqual(['sub.solo-questo.example']);
  });
});

/**
 * `isValidEgressHost` da sola, e poi attraverso `widenEgressForCapability`:
 * `--host` è testo scritto a mano (o una variabile di shell non impostata),
 * mai un valore già fidato. Prima di questo controllo uno qualunque di questi
 * valori finiva scritto e sigillato tale e quale, con «aggiunto
 * all'allowlist» stampato sopra — e poi non funzionava mai, perché
 * `hostAllowed()` confronta contro `new URL(...).hostname`, oppure (la
 * stringa vuota) faceva fallire `loadEgress()` al prossimo boot e il catch
 * muto di `agent/runtime.ts` azzerava OGNI host già approvato.
 */
describe('isValidEgressHost', () => {
  it.each([
    ['api.tavily.com', true],
    ['*.example.com', true],
    ['localhost', true],
    ['a-b.c-d.example', true],
    ['', false],
    ['   ', false],
    ['api.tavily.com:443', false],
    ['https://api.tavily.com/search', false],
    ['a.example,b.example', false],
    ['user@evil.example', false],
    ['../../../etc/passwd', false],
    ['..', false],
    ['exa..mple.com', false],
    ['-inizia-con-trattino.example', false],
  ])('%s → %s', (candidato, atteso) => {
    expect(isValidEgressHost(candidato)).toBe(atteso);
  });

  /**
   * Il blocco confermato da una terza review indipendente: una prima stesura
   * chiamava `raw.trim()` **dentro** questa funzione, ma il chiamante
   * (`normalizzati` in `widenEgressForCapability`, sotto) non chiamava mai
   * `trim()` sul valore che poi finiva scritto — quindi la funzione vedeva
   * una copia ripulita e diceva "valido", mentre lo spazio (o il `\n`) restava
   * dentro il valore vero. Ora non c'è alcun `trim()` da nessuna parte: questi
   * tre valori sono esattamente quelli misurati end-to-end nella review — uno
   * spazio o un ritorno a capo a un bordo (il caso ordinario di
   * `--host "$MCP_HOST"` con una variabile che porta un `\n` finale) — e
   * `isValidEgressHost` li rifiuta perché lo spazio/`\n` finisce dentro
   * un'etichetta esattamente come `/` o `@`, senza bisogno di un controllo
   * separato per lo spazio.
   */
  it.each([
    ['api.tavily.com ', false, 'spazio finale'],
    [' api.tavily.com', false, 'spazio iniziale'],
    ['api.tavily.com\n', false, 'a capo finale — il caso di una variabile di shell'],
    ['\tapi.tavily.com', false, 'tab iniziale'],
  ])('%s → %s (%s)', (candidato, atteso) => {
    expect(isValidEgressHost(candidato)).toBe(atteso);
  });

  /**
   * `DNS_LABEL` da sola fa tutto il lavoro (una review indipendente ha
   * mostrato che il controllo esplicito su `/:@,\s` era ridondante: tolto,
   * nessuno dei 53 test cambiava esito, perché nessuno di quei caratteri
   * passa mai `DNS_LABEL` dentro un'etichetta). Questi casi non dipendono da
   * nessun altro controllo — solo da `DNS_LABEL` — cosa che i casi sopra
   * (schema, porta, percorso, utente, elenco, `..`) non garantivano da soli:
   * sostituendo `DNS_LABEL` con un pattern che accetta tutto, uno solo dei
   * casi sopra si accorgeva del guasto. Questi cinque se ne accorgono anche
   * loro, senza passare da `/`, `:`, `@`, `,`, spazio o `..`.
   */
  it.each([
    ['trattino-alla-fine-.example', false, 'un trattino alla fine di un etichetta'],
    ['a_b.example', false, 'un underscore — non RFC1123'],
    [`${'a'.repeat(64)}.example`, false, "un'etichetta oltre i 63 caratteri"],
    ['.example', false, 'un punto iniziale — etichetta vuota'],
    ['*.', false, 'un wildcard senza dominio dopo'],
  ])('%s → %s (%s)', (candidato, atteso) => {
    expect(isValidEgressHost(candidato)).toBe(atteso);
  });
});

describe('widenEgressForCapability — host non valido: rifiuta prima di chiedere o scrivere', () => {
  it.each([
    ['', 'stringa vuota — es. una variabile di shell non impostata'],
    ['api.tavily.com:443', 'una porta'],
    ['https://api.tavily.com/search', 'uno schema e un percorso'],
    ['a.example,b.example', 'un elenco'],
    ['user@evil.example', 'un utente'],
    ['../../../etc/passwd', 'un attraversamento di percorso'],
    ['api.tavily.com ', 'uno spazio finale'],
    [' api.tavily.com', 'uno spazio iniziale'],
    ['api.tavily.com\n', 'un a capo finale — una variabile di shell con un \\n dietro'],
  ])('"%s" (%s): niente domanda, niente scrittura, il perché è nel messaggio', async (host) => {
    const h = home();
    let chiesto = 0;
    const { out, sink } = raccogli();
    const esito = await widenEgressForCapability(h, [host], 'test', {
      out: sink,
      chiediConferma: () => {
        chiesto += 1;
        return Promise.resolve('s');
      },
    });
    expect(esito.ok).toBe(false);
    expect(chiesto).toBe(0);
    expect(egressAllow(h)).toEqual([]);
    expect(out.join('\n')).toMatch(/non è un host valido|non sono host validi/);
    // Il root of trust non si è mosso.
    expect(verify(h, 'single-user').ok).toBe(true);
  });

  it('un host valido insieme a uno non valido: rifiuta tutto, non ne scrive nemmeno uno', async () => {
    const h = home();
    const esito = await widenEgressForCapability(h, ['api.tavily.com', 'https://evil.example/'], 'test', {
      out: () => {},
      chiediConferma: () => Promise.resolve('s'),
    });
    expect(esito.ok).toBe(false);
    expect(egressAllow(h)).toEqual([]);
  });

  /**
   * Il caso end-to-end che la seconda review indipendente ha misurato: il
   * perché rifiutare `"api.tavily.com "` (e i suoi fratelli con lo spazio
   * all'inizio o l'a-capo alla fine) non è cosmetico. Se quel valore fosse
   * finito scritto — la prima stesura di questa funzione lo faceva —
   * `hostAllowed()` non lo avrebbe mai fatto corrispondere a
   * `"api.tavily.com"`, la stringa che il boot controlla davvero
   * (`agent/runtime.ts`, `new URL(backend.endpoint).hostname`): l'owner
   * avrebbe letto «aggiunto all'allowlist», il seal sarebbe stato valido, e
   * `web_search` sarebbe rimasto spento lo stesso. Qui si prova sia che oggi
   * non si scrive quel valore, sia — costruendo a mano l'allowlist che una
   * versione senza il controllo avrebbe scritto — che se lo si scrivesse
   * davvero il match fallirebbe: la ragione per cui il rifiuto a monte è
   * quello giusto, non solo uno dei due modi validi di chiudere il difetto.
   */
  it.each(['api.tavily.com ', ' api.tavily.com', 'api.tavily.com\n'])(
    '"%s": non scritto oggi, e se lo fosse hostAllowed() non lo troverebbe comunque',
    async (host) => {
      const h = home();
      const esito = await widenEgressForCapability(h, [host], 'la ricerca web (Tavily)', {
        out: () => {},
        chiediConferma: () => Promise.resolve('s'),
      });
      expect(esito.ok).toBe(false);
      expect(egressAllow(h)).toEqual([]);
      // La dimostrazione che il rifiuto non è pignoleria: un allowlist che
      // contenesse quel valore tale e quale non farebbe mai match sull'host
      // pulito che il boot chiede.
      expect(hostAllowed('api.tavily.com', { allow: [host.toLowerCase()] })).toBe(false);
    },
  );
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

  /**
   * Il caso che il primo test qui sopra NON copre: lì la primissima
   * scrittura falliva, quindi non c'era niente da riportare indietro.
   * `seal()` scrive `manifest.json` per primo e l'anchor per secondo
   * (`core/rot/verify.ts`) — bloccando solo l'anchor, `egress.json` E
   * `manifest.json` sono già stati riscritti quando il sigillo fallisce, e
   * puntano ai nuovi hash mentre l'anchor punta ancora ai vecchi. Misurato
   * senza il rollback: l'esito era `{ok:false}` col messaggio "niente è
   * stato scritto", ma `egress.json` conteneva già il nuovo host e
   * `verify()` tornava `anchor_mismatch` — modalità sicura al prossimo
   * avvio, per un cambiamento che l'owner aveva approvato un attimo prima.
   */
  it.skipIf(platform() === 'win32' || process.getuid?.() === 0)(
    'il sigillo fallisce DOPO che egress.json e manifest.json erano già stati riscritti: torna tutto com era',
    async () => {
      const h = home();
      const egressPath = join(paths(h).rot, 'egress.json');
      const manifestPath = join(paths(h).rot, 'manifest.json');
      const anchorPath = join(h, '.rot-anchor');
      const egressPrima = readFileSync(egressPath, 'utf8');
      const manifestPrima = readFileSync(manifestPath, 'utf8');
      // Solo l'anchor è bloccato: `seal()` riesce a scrivere manifest.json e
      // fallisce solo sull'ultimo dei due write.
      chmodSync(anchorPath, 0o400);
      try {
        const { out, sink } = raccogli();
        const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
          out: sink,
          chiediConferma: () => Promise.resolve('s'),
        });
        expect(esito.ok).toBe(false);
      } finally {
        chmodSync(anchorPath, 0o600);
      }
      // Non solo "il messaggio dice che non è cambiato niente" — è vero:
      // entrambi i file sono tornati esattamente ai byte di prima.
      expect(readFileSync(egressPath, 'utf8')).toBe(egressPrima);
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifestPrima);
      // La prova che conta di più: non è `anchor_mismatch`/modalità sicura.
      const stato = verify(h, 'single-user');
      expect(stato.ok).toBe(true);
    },
  );
});
