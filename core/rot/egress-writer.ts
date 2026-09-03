import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/config.js';
import { EgressFileSchema, hostAllowed, loadEgress, type EgressPolicy } from '../net/egress.js';
import { seal, type RotManifest } from './verify.js';

/**
 * The one function that widens `rot/egress.json` for an owner-approved
 * capability, and reseals — shared by `muffin search` and `muffin mcp add`
 * (ADR-0058).
 *
 * Before this existed, accendere una capability che parla con l'esterno erano
 * **due atti scollegati**: `muffin search tavily` scriveva la config e la
 * chiave, e nessun comando toccava mai `rot/egress.json` — misurato il
 * 03/09/2026, `grep -rn "egress.json" --include="*.ts"` fuori dai test dava
 * solo il lettore (`core/net/egress.ts`) e l'inventario. L'owner ha configurato
 * Tavily giusto, `doctor` era verde, e `web_search` restava spento perché
 * `api.tavily.com` non era nell'allowlist sigillata — lo ha scoperto grepando
 * il proprio log.
 *
 * **Perché una funzione sola e non due copie.** `muffin search` e `muffin mcp
 * add` sono la stessa domanda — "questa capability deve raggiungere questo
 * host, lo autorizzo?" — con owner e vocabolario diversi. Una porta duplicata
 * è esattamente il difetto che questo repository ha già pagato una volta
 * (`docs/decisions/0055-le-due-porte-passano-dal-kernel.md`).
 *
 * **Perché non pre-riempire l'allowlist.** Il vuoto è ciò che fa dell'elenco
 * il consenso dell'owner, non un default che sembra sicurezza. Questa
 * funzione non inferisce mai un host da un URL passato dal chiamante: prende
 * l'host esatto che il chiamante nomina (l'endpoint fisso di un provider dal
 * catalogo, o un host che l'owner ha scritto lui con `--host`), e nessun
 * altro — e verifica che sia sintatticamente un host prima di chiedere o
 * scrivere qualunque cosa (`isValidEgressHost` sotto): `--host` è testo
 * scritto a mano, o una variabile di shell non impostata, non un valore già
 * fidato.
 *
 * **Dove sta davvero l'autorità, e cosa è solo ergonomia (revisione
 * 03/09/2026, dopo la review del giudice indipendente).** La prima stesura di
 * questo modulo diceva che il gate `isatty(0)` FOSSE la barriera contro
 * `sys.shell`. È falso su Linux: dentro bwrap uno strumento come `script` può
 * allocare un vero pty per il grande-figlio, e quel processo vede
 * `process.stdin.isTTY === true` — provato dal giudice, e riprodotto in
 * `core/rot/egress-shell-escalation.test.ts`. Su macOS/seatbelt l'allocazione
 * di un pty è negata dalla policy (`openpty: Operation not permitted`), il
 * che aveva reso il test precedente verde per il motivo sbagliato.
 *
 * La barriera vera è **la scrittura negata su `~/.muffin/rot`**
 * (`core/rot/guards.ts`, `mandatoryGuards`) — la stessa lista con cui
 * `agent/runtime.ts` costruisce il `SandboxExecutor` di produzione, e regge a
 * un pty, a un grande-figlio, a un interprete lanciato di fresco, con lo
 * stesso deny sia sotto seatbelt (`EPERM`) sia sotto bwrap (`EROFS`), anche
 * quando `paths(home).rot` è esplicitamente dentro `writeScope` per quella
 * chiamata (mandatorio batte esplicito). `deps.chiediConferma` cablato solo
 * da `isatty(0)` (`cli/main.ts`) resta un buon gate ergonomico — evita che
 * uno script resti appeso su una domanda a cui nessuno risponde — ma non è
 * la ragione per cui il modello non può allargare l'egress: quella ragione è
 * il file system, non il terminale.
 */

export type EgressWidenDeps = {
  /** Una riga per l'owner. */
  readonly out: (line: string) => void;
  /**
   * Chiede sì/no a un terminale vero. Assente = nessun terminale interattivo
   * a cui chiedere (uno script, un test, o il figlio non-TTY di `sys.shell`):
   * in quel caso questa funzione non scrive mai nulla e stampa il rimedio a
   * mano, la stessa regola di `promptSecret`/`promptLine` (`cli/prompt.ts`).
   * Ergonomia, non contenimento — vedi la nota sopra.
   */
  readonly chiediConferma?: (domanda: string) => Promise<string | undefined>;
};

export type EgressWidenOutcome =
  | { readonly ok: true; readonly added: readonly string[] }
  | { readonly ok: false };

const SI_NO = /^(s(i|ì)?|y(es)?)$/i;

/**
 * Un'etichetta DNS: lettere/cifre/trattino, mai un trattino agli estremi, 1-63
 * caratteri — RFC 1123, senza inventare una sintassi più permissiva di quella
 * che un host può davvero avere.
 */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Un host valido per `rot/egress.json`: un hostname nudo, o un pattern
 * `*.dominio` con un solo livello di wildcard iniziale.
 *
 * **Un meccanismo solo, non una lista nera di caratteri.** La stesura
 * precedente rifiutava esplicitamente `/`, `:`, `@`, `,` e gli spazi PRIMA di
 * spezzare in etichette — ma un revisore indipendente ha mostrato che quel
 * controllo era ridondante: tolto, i 53 test restavano tutti verdi, perché
 * `DNS_LABEL` già rifiuta ciascuno di quei caratteri **dentro ogni etichetta**
 * (`split('.')` non consuma `/`, `:`, `@`, `,` o uno spazio, quindi finiscono
 * sempre dentro un'etichetta, e `DNS_LABEL` ammette solo lettere/cifre/
 * trattino). Una lista nera che si può togliere senza che un test se ne
 * accorga non sta proteggendo niente da sola — è un secondo posto dove la
 * stessa regola può disallinearsi dalla prima. Restava un guardiano solo:
 * `DNS_LABEL`, applicato etichetta per etichetta dopo aver tolto un eventuale
 * `*.` iniziale (`split('.').every(...)`) — e uno schema (`https://`), una
 * porta (`:443`), un percorso (`/search`), un utente (`user@`), un elenco
 * (`a.example,b.example`) e un attraversamento di percorso
 * (`../../etc/passwd`) restano tutti rifiutati, perché nessuno dei loro
 * caratteri passa `DNS_LABEL` in nessuna etichetta.
 *
 * **Lo stesso meccanismo chiude anche lo spazio ai bordi, senza un `trim()`
 * separato — ed è proprio lì che la stesura precedente aveva il difetto
 * bloccante di una review indipendente.** `raw.trim()` veniva chiamato
 * **solo** dentro questa funzione, mai su `normalizzati` (`hosts.map((h) =>
 * h.toLowerCase().replace(/\.$/, ''))`, sotto): un host con uno spazio o un
 * `\n` a un bordo (`"api.tavily.com "`, `"\napi.tavily.com"`, o una variabile
 * di shell con un ritorno a capo finale, `--host "$MCP_HOST"`) passava questa
 * funzione (che lo vedeva già ripulito), veniva scritto **con lo spazio
 * dentro**, sigillato, e non avrebbe mai fatto match in `hostAllowed()` — la
 * stessa capability spenta con un messaggio di successo sopra, sulla porta
 * scritta apposta per chiuderla. Ora non c'è alcun `trim()`: lo spazio (o il
 * `\n`) finisce dentro un'etichetta esattamente come `/` o `@`, e
 * `DNS_LABEL` — ancorato con `^`/`$`, che in JavaScript non perdona un `\n`
 * finale come farebbe in altri linguaggi — lo rifiuta per lo stesso motivo.
 *
 * Prima di questo controllo (in qualunque stesura), `--host` finiva scritto e
 * sigillato **tale e quale** in `rot/egress.json`: `hostAllowed()` confronta
 * contro `new URL(...).hostname`, quindi un valore come
 * `https://api.tavily.com/` non avrebbe mai fatto match — l'owner leggeva
 * "aggiunto", il seal era valido, e la capability restava spenta. Peggio, una
 * stringa vuota (`--host ''`, tipicamente una variabile di shell non
 * impostata) scritta in `allow` fa fallire `loadEgress()` al prossimo avvio,
 * e il `catch` muto in `agent/runtime.ts` la trasforma in `{ allow: [] }` —
 * **ogni** host prima approvato sparisce, senza una riga in nessun log.
 */
export function isValidEgressHost(raw: string): boolean {
  const senzaWildcard = raw.startsWith('*.') ? raw.slice(2) : raw;
  return senzaWildcard.split('.').every((label) => DNS_LABEL.test(label));
}

const MANIFEST_FILENAME = 'manifest.json'; // Lo stesso letterale privato di `core/rot/verify.ts`.

/** Il `rotVersion` corrente, se il manifest esiste e si legge — mai inventato. */
function currentRotVersion(manifestFile: string): string {
  if (!existsSync(manifestFile)) return '1';
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<RotManifest>;
    return typeof parsed.rotVersion === 'string' && parsed.rotVersion !== '' ? parsed.rotVersion : '1';
  } catch {
    return '1';
  }
}

/**
 * `hosts` sono nomi esatti, mai wildcard dedotti qui: chi chiama decide la
 * forma (`*.example.com` è valida solo se il chiamante la scrive così).
 *
 * Una sola domanda per l'intera chiamata, anche con più host — "un atto solo"
 * vale anche quando la capability ne nomina più di uno insieme (un server MCP
 * con `--host` ripetuto).
 */
export async function widenEgressForCapability(
  home: string,
  hosts: readonly string[],
  capabilityLabel: string,
  deps: EgressWidenDeps,
): Promise<EgressWidenOutcome> {
  const { out } = deps;
  const rotDir = paths(home).rot;
  const egressFile = join(rotDir, 'egress.json');
  const manifestFile = join(rotDir, MANIFEST_FILENAME);

  const normalizzati = [...new Set(hosts.map((h) => h.toLowerCase().replace(/\.$/, '')))];

  // Prima di ogni domanda o scrittura: un host che non può essere un host si
  // rifiuta subito, con il motivo — mai chiesto, mai scritto, mai sigillato.
  const invalidi = normalizzati.filter((h) => !isValidEgressHost(h));
  if (invalidi.length > 0) {
    out(
      `${invalidi.map((h) => `"${h}"`).join(', ')} non ${invalidi.length > 1 ? 'sono host validi' : 'è un host valido'} ` +
        `— niente schema, porta, percorso, utente, elenco o spazio: solo il nome dell'host.`,
    );
    return { ok: false };
  }

  let policy: EgressPolicy;
  try {
    policy = loadEgress(home);
  } catch (error) {
    out(`non riesco a leggere l'allowlist: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  const mancanti = normalizzati.filter((h) => !hostAllowed(h, policy));
  if (mancanti.length === 0) return { ok: true, added: [] };

  const elenco = mancanti.join(', ');
  const plurale = mancanti.length > 1;
  const rimedioAMano = `aggiungi ${plurale ? elenco : `"${mancanti[0]}"`} all'array "allow" in ${egressFile}, poi \`muffin rot reseal\`.`;

  if (deps.chiediConferma === undefined) {
    out(`${capabilityLabel} deve raggiungere ${elenco}, non ancora nell'allowlist (${egressFile}).`);
    out(`Da qui non posso chiedere conferma — nessun terminale interattivo: ${rimedioAMano}`);
    return { ok: false };
  }

  const risposta = await deps.chiediConferma(
    `${capabilityLabel} deve poter raggiungere ${elenco}. ` +
      `${plurale ? 'Li aggiungo' : "Lo aggiungo"} all'allowlist e risigillo il root of trust adesso? [s/N] `,
  );
  const consenso = risposta !== undefined && SI_NO.test(risposta.trim());
  if (!consenso) {
    out(`Non aggiunto niente. ${rimedioAMano}`);
    return { ok: false };
  }

  let egressRawPrima: string;
  try {
    egressRawPrima = readFileSync(egressFile, 'utf8');
  } catch (error) {
    out(`${egressFile}: ${error instanceof Error ? error.message : String(error)}. ${rimedioAMano}`);
    return { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(egressRawPrima);
  } catch (error) {
    out(`${egressFile}: ${error instanceof Error ? error.message : String(error)}. ${rimedioAMano}`);
    return { ok: false };
  }
  const parsed = EgressFileSchema.safeParse(raw);
  if (!parsed.success) {
    out(`${egressFile} non ha la forma attesa. ${rimedioAMano}`);
    return { ok: false };
  }

  // Il manifest PRIMA della scrittura: `seal()` lo riscrive per primo e
  // l'anchor per secondo, quindi un fallimento sull'anchor lascia il manifest
  // già puntato ai nuovi hash mentre l'anchor punta ancora ai vecchi —
  // `verify()` legge questo come `anchor_mismatch` (modalità sicura, o un
  // boot rifiutato in hardened) anche se l'owner non ha mai visto un errore
  // che dicesse "fatto". Tenere i byte di prima e rimetterli se il sigillo
  // fallisce è l'unico modo per non lasciare quello stato a metà.
  const manifestRawPrima = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : undefined;
  const rotVersion = currentRotVersion(manifestFile);

  // Ogni altra voce (e `_comment`) resta com'era: si aggiunge, non si sostituisce.
  const next = { ...parsed.data, allow: [...parsed.data.allow, ...mancanti] };
  try {
    writeFileSync(egressFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    seal(home, rotVersion, new Date());
  } catch (error) {
    // Rollback, best-effort: se uno di questi due write torna a fallire (per
    // esempio perché è mancato lo stesso permesso che ha fatto fallire il
    // primo tentativo) non c'è altro da fare per rimetterlo a posto da soli —
    // ma è un esito diverso da "non è cambiato niente", e va detto, non
    // inghiottito in un `catch` muto: altrimenti il messaggio promette uno
    // stato che il disco non ha. Quello che questo rollback chiude di norma è
    // il caso intermedio: la scrittura di `egress.json` è riuscita, `seal()`
    // ha riscritto `manifest.json` ed è fallito solo sull'anchor.
    let rollbackFallito = false;
    try {
      writeFileSync(egressFile, egressRawPrima, 'utf8');
    } catch {
      rollbackFallito = true;
    }
    if (manifestRawPrima !== undefined) {
      try {
        writeFileSync(manifestFile, manifestRawPrima, 'utf8');
      } catch {
        rollbackFallito = true;
      }
    }

    const code = (error as NodeJS.ErrnoException).code;
    const motivo =
      code === 'EACCES' || code === 'EPERM'
        ? `non posso scrivere in ${rotDir}: permesso negato. Se hai reso vera la modalità hardened, rifai questo ` +
          "comando con il privilegio che serve (es. `sudo`), oppure a mano: " +
          rimedioAMano
        : `scrittura fallita: ${error instanceof Error ? error.message : String(error)}. ${rimedioAMano}`;
    out(
      rollbackFallito
        ? `${motivo} E non sono riuscito a rimettere ${egressFile}/${manifestFile} come stavano prima: verifica con ` +
          '`muffin rot verify` — se dice che è diverso, `muffin rot reseal` a mano dopo aver controllato cosa è cambiato.'
        : motivo,
    );
    return { ok: false };
  }

  out(`${elenco} aggiunt${plurale ? 'i' : 'o'} all'allowlist. Root of trust risigillato.`);
  return { ok: true, added: mancanti };
}
