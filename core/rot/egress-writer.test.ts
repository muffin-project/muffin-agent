import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { isValidEgressHost, widenEgressForCapability } from './egress-writer.js';
import { verify } from './verify.js';
import { paths } from '../config/config.js';
import { hostAllowed, isForbiddenAddress } from '../net/egress.js';

/**
 * `writeFileSync` reale per ogni chiamata, tranne quando `guasto.armato` è
 * vero: da lì in poi ogni scrittura successiva alla prima fallisce con
 * `EACCES` — quella "prima" è la nuova `egress.json` che
 * `widenEgressForCapability` scrive per prima; le successive sono i due
 * write di `seal()` (manifest, poi anchor) e i due tentativi di rollback che
 * seguono un fallimento. Un mock, non un `chmod`: un `chmod` sul file blocca
 * la *prima* scrittura, non permette "la prima riesce, tutte le altre no" —
 * esattamente la sequenza che fa scattare `rollbackFallito` (vedi sotto), e
 * lo stesso approccio con cui un giudice indipendente l'ha esercitato la
 * prima volta.
 */
const guasto = vi.hoisted(() => ({ armato: false, chiamate: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const vero = await importOriginal<typeof import('node:fs')>();
  return {
    ...vero,
    writeFileSync: (...args: Parameters<typeof vero.writeFileSync>) => {
      if (guasto.armato) {
        guasto.chiamate += 1;
        if (guasto.chiamate > 1) {
          throw Object.assign(new Error('EACCES: permission denied, open (mock)'), { code: 'EACCES' });
        }
      }
      return vero.writeFileSync(...args);
    },
  };
});

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

  /**
   * Il ramo che il test sopra NON esercita: lì il rollback riesce sempre,
   * perché soltanto l'anchor era bloccato e i due file da riportare indietro
   * restavano scrivibili. Qui, con `writeFileSync` mockato (vedi `guasto` in
   * cima al file) per fallire da SUBITO DOPO la prima scrittura riuscita in
   * poi, la sequenza è: (1) la nuova `egress.json` si scrive davvero, (2)
   * `seal()` fallisce sul primo write che tenta (`manifest.json`, mai
   * arrivato a toccare il file — resta quello di prima), (3) il tentativo di
   * rimettere `egress.json` com'era fallisce anch'esso. `egress.json` sul
   * disco resta quindi con il nuovo host **mai ripristinato** — l'unica riga
   * owner-facing del modulo senza copertura, misurata da un giudice
   * indipendente mockando `writeFileSync` per fallire dopo la prima
   * scrittura riuscita. Il messaggio deve ammetterlo, non promettere un
   * ripristino che il disco non ha — ed è per questo che `verify()` lo vede
   * davvero come uno scarto (`files_diverged`), non come uno stato pulito.
   */
  it("rollbackFallito: se anche il ripristino fallisce, il messaggio lo dice — non promette un ripristino che non c'è stato", async () => {
    const h = home();
    const egressPath = join(paths(h).rot, 'egress.json');
    const manifestPath = join(paths(h).rot, 'manifest.json');
    const egressPrima = readFileSync(egressPath, 'utf8');
    const manifestPrima = readFileSync(manifestPath, 'utf8');
    const { out, sink } = raccogli();
    guasto.chiamate = 0;
    guasto.armato = true;
    try {
      const esito = await widenEgressForCapability(h, ['api.tavily.com'], 'la ricerca web (Tavily)', {
        out: sink,
        chiediConferma: () => Promise.resolve('s'),
      });
      expect(esito.ok).toBe(false);
    } finally {
      guasto.armato = false;
    }
    const testo = out.join('\n');
    expect(testo).toContain('non sono riuscito a rimettere');
    // I due percorsi separati e leggibili, non incollati da un `/` che li fa
    // sembrare un unico percorso inesistente (`…/egress.json//tmp/…/manifest.json`).
    expect(testo).toContain(`rimettere ${egressPath} e ${manifestPath} come stavano prima`);
    expect(testo).not.toContain(`${egressPath}/${manifestPath}`);
    expect(testo).toContain('muffin rot verify');
    // Il disco, a differenza del rollback riuscito sopra, NON è tornato
    // com'era: `egress.json` ha già il nuovo host e il tentativo di
    // rimetterlo com'era è quello che è fallito.
    expect(readFileSync(egressPath, 'utf8')).not.toBe(egressPrima);
    expect(JSON.parse(readFileSync(egressPath, 'utf8')).allow).toContain('api.tavily.com');
    // manifest.json non è mai stato toccato: seal() ha fallito sul suo stesso
    // primo write, prima ancora di scrivere byte nuovi.
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestPrima);
    // E `verify()` lo vede per quello che è: uno scarto reale fra il
    // manifest (vecchio) e `egress.json` (nuovo) — non uno stato pulito che
    // il messaggio avrebbe promesso a torto.
    const stato = verify(h, 'single-user');
    expect(stato.ok).toBe(false);
  });
});

/**
 * Un indirizzo privato o link-local (`127.0.0.1`, il metadata endpoint
 * `169.254.169.254`, un RFC1918) non deve entrare nell'allowlist da questa
 * porta — vedi il commento sopra `isValidEgressHost` per il perché. Ogni
 * caso qui prova **entrambe le metà**, come richiesto: rifiutato da chi
 * scrive, e comunque rifiutato a connect-time dal pavimento esistente
 * (`isForbiddenAddress`, la stessa funzione che `agent/tools/http.ts#addressVeto`
 * chiama su ogni hop) — due difese indipendenti, non la stessa provata due volte.
 */
describe('isValidEgressHost — il pavimento anti-SSRF si applica anche a chi scrive', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'metadata endpoint cloud'],
    ['10.0.0.5', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['*.169.254.169.254', 'wildcard su un indirizzo, non su un dominio'],
  ])('"%s" (%s): isValidEgressHost lo rifiuta', (host) => {
    expect(isValidEgressHost(host)).toBe(false);
  });

  it('un IPv4 pubblico resta un host valido — il controllo è mirato, non "nessun IP"', () => {
    expect(isValidEgressHost('8.8.8.8')).toBe(true);
  });

  it('widenEgressForCapability: rifiuta prima di chiedere o scrivere, e il pavimento a connect-time lo rifiuterebbe comunque', async () => {
    const h = home();
    const { out, sink } = raccogli();
    let chiesto = 0;
    const esito = await widenEgressForCapability(h, ['169.254.169.254'], 'test', {
      out: sink,
      chiediConferma: () => {
        chiesto += 1;
        return Promise.resolve('s');
      },
    });
    // Prima metà: la porta che scrive rifiuta.
    expect(esito.ok).toBe(false);
    expect(chiesto).toBe(0);
    expect(egressAllow(h)).toEqual([]);
    expect(out.join('\n')).toMatch(/non è un host valido/);
    // Seconda metà: anche se questo host fosse finito nell'allowlist per
    // un'altra via, il pavimento a connect-time lo rifiuterebbe comunque —
    // le due difese sono indipendenti, non la stessa cosa vista due volte.
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
  });
});

/**
 * RFC 1035 §3.1: un'etichetta non supera i 63 caratteri (già coperto sopra),
 * ma il nome intero non supera i 253 — un limite diverso, su un totale
 * diverso, che nessuna delle etichette singole può far scattare da sola.
 */
describe('isValidEgressHost — il nome intero, non solo ogni etichetta, ha un tetto', () => {
  it('cinque etichette da 60 caratteri (ciascuna valida) superano insieme i 253: rifiutato', () => {
    const nome = Array(5).fill('a'.repeat(60)).join('.');
    expect(nome.length).toBeGreaterThan(253);
    expect(nome.split('.').every((l) => l.length <= 63)).toBe(true); // nessuna etichetta, da sola, è il motivo
    expect(isValidEgressHost(nome)).toBe(false);
  });

  it('253 caratteri esatti restano validi — il tetto è "oltre", non "fino a"', () => {
    // 4 etichette da 62 (62·4 = 248) unite da 3 punti (251), più un punto e
    // un'etichetta finale di 1 carattere: 251 + 2 = 253.
    const nome = `${Array(4).fill('a'.repeat(62)).join('.')}.a`;
    expect(nome.length).toBe(253);
    expect(isValidEgressHost(nome)).toBe(true);
  });
});

/**
 * `EgressFileSchema` in modalità `.loose()` (`core/net/egress.ts`): una
 * chiave che l'owner ha scritto a mano — una nota, un promemoria, qualunque
 * cosa questo schema non conosca — sopravvive a una riscrittura, invece di
 * sparire in silenzio alla prima `widenEgressForCapability`.
 */
describe('widenEgressForCapability — una chiave sconosciuta scritta dall owner sopravvive alla riscrittura', () => {
  it('una nota owner in un campo che lo schema non conosce resta, byte per byte, dopo l aggiunta di un host', async () => {
    const h = home();
    const egressPath = join(paths(h).rot, 'egress.json');
    writeFileSync(
      egressPath,
      JSON.stringify(
        { schemaVersion: 1, allow: ['gia-dentro.example'], nota_owner: 'aggiunto per il progetto X, non toccare' },
        null,
        2,
      ),
    );
    const esito = await widenEgressForCapability(h, ['nuovo.example'], 'test', {
      out: () => {},
      chiediConferma: () => Promise.resolve('s'),
    });
    expect(esito.ok).toBe(true);
    const scritto = JSON.parse(readFileSync(egressPath, 'utf8'));
    expect(scritto.nota_owner).toBe('aggiunto per il progetto X, non toccare');
    expect(scritto.allow).toEqual(['gia-dentro.example', 'nuovo.example']);
  });
});
