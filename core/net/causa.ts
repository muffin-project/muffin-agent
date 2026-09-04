/**
 * La causa di un fallimento di rete, in una forma che non puo' portare un
 * segreto.
 *
 * Il difetto da cui nasce, misurato sulla macchina dell'owner il 30/08/2026:
 * nell'arco di vita di una sola istanza del gateway (29/08 12:30 → 30/08 12:29)
 * `gateway.err` aveva raccolto **3187 righe identiche** — `telegram: polling
 * fallito (Telegram 0: TypeError)` — mentre `api.telegram.org` da quella
 * macchina rispondeva in 326ms. La sola parola registrata era il nome della
 * classe: «una fetch e' fallita». Non si poteva distinguere DNS, connessione
 * rifiutata, socket caduto e TLS, cioe' non si poteva sapere se il rimedio
 * fosse riavviare, aprire una porta o aspettare.
 *
 * Nota su cosa quelle righe **non** dicono, perche' la prima lettura ne aveva
 * concluso troppo: un successo non scrive niente in quel file, e le righe non
 * portano un timestamp. Tremilacentottantasette fallimenti dicono *quanti*, mai
 * *per quanto* — la continuita' di un guasto non si legge in un diario di soli
 * fallimenti. Ed e' la seconda meta' dello stesso problema: la prima e' che non
 * si sa **cosa** sia rotto, la seconda che non si sa **da quanto** (vedi
 * `core/surface/salute.ts`).
 *
 * La ragione per cui quel nome era da solo e' giusta, e resta: l'URL di Telegram
 * porta il **bot token nel path** (Discord lo mette in un header, Telegram no),
 * quindi `error.message` non e' un campo che si possa stampare. Non e' un
 * timore teorico. Su Node v22.22.2, misurato lo stesso giorno, un URL malformato
 * da' esattamente questo:
 *
 * ```text
 * name    = "TypeError"
 * message = "Failed to parse URL from https://api.telegram.org/bot123:AA.../getUpdates"
 * ```
 *
 * Il token, intero, dentro `message`. Il commento che stava in `api.ts`
 * registrava una prova del 17/08 secondo cui `.message` non portava mai l'URL:
 * quella prova non aveva incluso il caso malformato, ed era la conclusione a
 * essere troppo tranquilla, non la regola.
 *
 * Quello che si puo' dire senza rischio e' il **codice**, che nella stessa
 * misura c'e' su ogni fallimento vero:
 *
 * | fallimento | `error.name` | `error.cause.code` |
 * |---|---|---|
 * | DNS inesistente | TypeError | `ENOTFOUND` |
 * | connessione rifiutata | TypeError | `ECONNREFUSED` |
 * | socket caduto | TypeError | `ECONNRESET` (macOS) / `UND_ERR_SOCKET` (Linux) |
 * | TLS verso porta in chiaro | TypeError | `ECONNRESET` |
 * | URL malformato | TypeError | `ERR_INVALID_URL` |
 * | nessuna risposta | TimeoutError | assente |
 *
 * Le due righe del socket sono misurate l'1/09/2026 sullo stesso server, e la
 * differenza e' la piattaforma, non la versione di undici: su Linux il codice
 * e' `UND_ERR_SOCKET` con undici 6.21.2, 6.23.0 e 6.28.0. Vale la pena saperlo
 * leggendo un `gateway.err`, perche' la produzione e' Linux: li' un socket
 * caduto e un TLS verso una porta in chiaro sono **due codici diversi**,
 * mentre su macOS collassano nello stesso.
 *
 * **La sicurezza qui non e' una promessa su undici: e' una forma imposta qui.**
 * Un campo entra solo se corrisponde a una forma che un URL non puo' avere —
 * niente `:`, niente `/`, niente punti, niente spazi, e una lunghezza corta.
 * E' la differenza fra «oggi quel campo e' pulito» e «quel campo non puo'
 * sporcare»: la prima scade alla prossima versione della dipendenza, la seconda
 * no. I due controlli sono la cucitura che regge la garanzia, ed e' li' che la
 * mutazione deve uccidere il test.
 */

/**
 * `ECONNRESET`, `ERR_INVALID_URL`, `UND_ERR_SOCKET`: maiuscole, cifre e
 * underscore, e nient'altro. `https://…` non passa per i due punti e per le
 * minuscole; un path non passa per le barre.
 */
const FORMA_DI_CODICE = /^[A-Z][A-Z0-9_]{1,30}$/;

/**
 * `TypeError`, `TimeoutError`, `AbortError`. Lettere e cifre, niente
 * separatori: e' il nome di una classe, e nessun URL ne ha la forma.
 */
const FORMA_DI_NOME = /^[A-Za-z][A-Za-z0-9]{0,30}$/;

/** Quando non si puo' dire niente di sicuro, si dice questo — e non si tace. */
const IGNOTA = 'errore di rete';

/**
 * Quanti anelli di `.cause` seguire prima di arrendersi. Misurato il 3-4/09/2026
 * sulla macchina dell'owner: con un solo livello attivo (`error.cause.code`),
 * 3188 righe su 4748 (67%) restavano `Telegram 0: TypeError` nuda — il
 * meccanismo esisteva e in due casi su tre non scattava. `fetch` di Node
 * (undici) incapsula un fallimento di trasporto come `TypeError('fetch
 * failed', { cause })`, ma quella `cause` e' a sua volta un altro errore che
 * a volte porta il codice **e a volte lo tiene un livello piu' sotto**
 * (`SocketError` → causa originale del sistema operativo): un solo salto non
 * basta a raggiungerlo sempre. Un tetto piccolo, non un giro senza fine: la
 * catena e' generata da `fetch`, non da input esterno, ma nulla vieta a una
 * versione futura di undici di aggiungerne un anello e non e' questo il posto
 * per scoprirlo con uno stack overflow.
 */
const MAX_PROFONDITA_CAUSA = 5;

export function causaDiRete(error: unknown): string {
  if (!(error instanceof Error)) return IGNOTA;

  // Letto **una volta**: `name` e' una proprieta' qualsiasi, e un getter che
  // restituisce due valori diversi alle due letture farebbe passare il
  // controllo a una stringa e stamparne un'altra. Niente che `fetch` produca
  // ha questa forma, e non costa niente renderla impossibile qui.
  const dichiarato = error.name;
  const nome = FORMA_DI_NOME.test(dichiarato) ? dichiarato : IGNOTA;

  const codice = trovaCodice(error, MAX_PROFONDITA_CAUSA);
  if (codice !== undefined) return `${nome} (${codice})`;
  return nome;
}

/**
 * Scende `.cause` un anello alla volta, non solo il primo: vedi
 * `MAX_PROFONDITA_CAUSA` sopra per il perche'. Ogni anello e' controllato con
 * la stessa forma imposta del livello zero — niente di quello che un URL puo'
 * avere passa, a nessuna profondita' — cosi' un token che risalisse la catena
 * non avrebbe comunque dove uscire.
 */
function trovaCodice(error: Error, profonditaResidua: number): string | undefined {
  if (profonditaResidua <= 0) return undefined;

  // `cause` e' `unknown` per contratto e puo' essere qualsiasi cosa: una
  // stringa, null, un oggetto senza `code`. Si legge difensivamente e si
  // accetta solo una stringa della forma giusta.
  const causa = (error as { cause?: unknown }).cause;
  if (typeof causa !== 'object' || causa === null) return undefined;

  const codice = (causa as { code?: unknown }).code;
  if (typeof codice === 'string' && FORMA_DI_CODICE.test(codice)) return codice;

  // Nessun codice a questo livello: se la causa e' a sua volta un `Error` (e
  // solo allora — un oggetto qualsiasi non ha una `.cause` propria da
  // seguire), si prova un livello piu' sotto.
  if (causa instanceof Error) return trovaCodice(causa, profonditaResidua - 1);
  return undefined;
}
