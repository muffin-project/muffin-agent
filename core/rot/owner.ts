import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/config.js';
import { hardeningHolds, seal, sha256, verify, type RotManifest } from './verify.js';

/**
 * Chi è l'owner, dentro il sigillo — `rot/owner.json`.
 *
 * DAY-1 B15 chiede tre proprietà al riconoscimento dell'owner: un subject-id
 * **stabile**, **autenticato** e **protetto**. Le prime due esistevano già:
 * `identify()` (`core/surface/types.ts`) confronta solo l'id di account che
 * riporta la piattaforma, e il pairing (`core/config/pairing.ts`) lega
 * «chi tiene questa macchina» a «chi tiene quell'account» con un codice a uso
 * singolo. La terza no: il legame viveva in `surfaces.telegram.ownerUserId`
 * dentro `config.json`, un file ordinario che **qualunque processo che gira
 * come l'owner può riscrivere**, mentre identità, policy, egress e tetti di
 * spesa stanno tutti sotto il sigillo. Un file che decide chi ha autorità e
 * che nessun hash copre è la stessa forma del difetto che ADR-0028 ha già
 * pagato una volta con `config.budget`: il numero c'era, la garanzia no.
 *
 * Questo modulo è l'unico lettore e l'unico scrittore di quel file.
 *
 * ## La precedenza, e perché un file manomesso non vale come «assente»
 *
 * Tre esiti, non due, ed è la distinzione che fa la sicurezza:
 *
 *  - **`sealed`** — il manifest dichiara `owner.json`, l'anchor conferma il
 *    manifest, l'hash del file combacia e il contenuto è valido. Vince questo,
 *    sempre: `config.json` non viene nemmeno letto.
 *  - **`legacy`** — il sigillo non ha **mai sentito parlare** di `owner.json`
 *    (casa sigillata prima di questa release, o mai sigillata). Solo qui vale
 *    `config.json`, ed è ciò che tiene viva un'installazione esistente.
 *  - **`refused`** — il sigillo dichiara `owner.json` ma il file non
 *    corrisponde: sparito, hash diverso, JSON rotto, schema sbagliato, o
 *    l'anchor non conferma più il manifest. Allora **nessuno è owner**, e non
 *    si torna a `config.json`.
 *
 * L'ultimo punto è il motivo per cui `refused` esiste come esito separato.
 * «Trattalo come assente» sarebbe stato più corto e avrebbe aperto la porta
 * esatta che questa fetta chiude: chi può riscrivere `config.json` può anche
 * cancellare `rot/owner.json`, e se la cancellazione facesse *retrocedere* la
 * decisione su `config.json` il sigillo non sarebbe una protezione ma un
 * suggerimento. Un legame che non si può verificare non autentica nessuno.
 */

/** Il nome dentro `rot/`. Un letterale solo: `listRotFiles` lo scopre da solo. */
export const OWNER_FILE = 'owner.json';

/**
 * `chatId` accanto a `userId` perché sono due domande diverse — *chi* parla e
 * *dove* si consegna — e Telegram le fa coincidere solo nella chat privata.
 * `userId` è quello che `identify()` confronta; `chatId` è l'indirizzo che
 * `telegramSurface` usa. Numeri interi, come nello schema di `config.json`.
 */
const TelegramBinding = z.object({
  userId: z.number().int(),
  chatId: z.number().int(),
});

/**
 * Stringa, mai `z.number()`, per la stessa ragione già scritta in
 * `core/config/config.ts`: uno snowflake Discord supera 2^53 e passare da un
 * numero JSON lo arrotonderebbe in silenzio.
 */
const DiscordBinding = z.object({
  userId: z.string().regex(/^[0-9]+$/),
});

export const OwnerBindingSchema = z.object({
  schemaVersion: z.literal(1),
  telegram: TelegramBinding.optional(),
  discord: DiscordBinding.optional(),
});

export type OwnerBinding = z.infer<typeof OwnerBindingSchema>;

export const OWNER_SCHEMA_VERSION = 1;

export type SealedOwnerSource = 'sealed' | 'legacy' | 'refused';

export type SealedOwner = {
  readonly binding: OwnerBinding | null;
  readonly source: SealedOwnerSource;
  /**
   * Una riga per l'owner quando c'è qualcosa da dire — e c'è sempre, quando
   * il legame è `refused` o quando un `owner.json` esiste fuori dal sigillo.
   * Mai piegata in un booleano: «il sigillo ha rifiutato il legame» è
   * esattamente il fatto che deve poter arrivare a un log e a `muffin doctor`.
   */
  readonly note?: string;
};

const MANIFEST_FILENAME = 'manifest.json'; // Lo stesso letterale privato di `verify.ts`.
const ANCHOR_FILE = '.rot-anchor'; // Idem — fuori da `rot/`, come vuole l'anchor.

/**
 * Legge il legame sigillato, verificando **questo file** e non tutto il RoT.
 *
 * La differenza non è un'ottimizzazione. `verify()` risponde «qualcosa è
 * cambiato», e usarla qui vorrebbe dire che una `identity.md` modificata a
 * mano dall'owner — la divergenza più ordinaria che esista, quella per cui
 * `reseal` è stato inventato — farebbe **retrocedere il legame su
 * `config.json`**, cioè su un file che chiunque può scrivere. Una deriva
 * innocua altrove non deve indebolire l'autorità qui: la catena che questa
 * funzione controlla è anchor → manifest → riga di `owner.json` → byte sul
 * disco, e nient'altro.
 */
export function loadSealedOwner(home: string): SealedOwner {
  const rotDir = paths(home).rot;
  const file = join(rotDir, OWNER_FILE);
  const manifestFile = join(rotDir, MANIFEST_FILENAME);
  const anchorFile = join(home, ANCHOR_FILE);
  const onDisk = existsSync(file);

  const legacy = (note?: string): SealedOwner => ({
    binding: null,
    source: 'legacy',
    ...(note === undefined ? {} : { note }),
  });
  const refused = (note: string): SealedOwner => ({ binding: null, source: 'refused', note });

  if (!existsSync(manifestFile) || !existsSync(anchorFile)) {
    // Nessun sigillo stabilito: non c'è niente da cui il legame possa venire.
    // `muffin doctor` grida già per il manifest mancante; qui basta non
    // fingere che un file non coperto sia coperto.
    return legacy(
      onDisk ? `${file} esiste ma questo home non ha un sigillo: il legame che vale è quello di config.json` : undefined,
    );
  }

  const serialized = readFileSync(manifestFile, 'utf8');
  const anchor = readFileSync(anchorFile, 'utf8').trim();
  let manifest: RotManifest | null = null;
  try {
    manifest = JSON.parse(serialized) as RotManifest;
  } catch {
    manifest = null;
  }
  const declared =
    manifest !== null && Array.isArray(manifest.files)
      ? manifest.files.find((f) => f.path === OWNER_FILE)
      : undefined;

  if (sha256(serialized) !== anchor) {
    // Il manifest non è più confermato dall'anchor: da qui in poi nemmeno
    // «il sigillo dichiara owner.json» è un'affermazione credibile. Se un
    // legame sigillato risulta esistere in una qualunque delle due fonti che
    // non possiamo più credere, la risposta è nessun owner — non config.json.
    if (onDisk || declared !== undefined) {
      return refused(
        `${manifestFile} non è più confermato da ${anchorFile}: il legame owner non è verificabile, nessuno è owner`,
      );
    }
    return legacy();
  }

  if (declared === undefined) {
    // Casa sigillata prima che questo file esistesse: è il solo caso in cui
    // `config.json` decide ancora chi è l'owner.
    return legacy(
      onDisk
        ? `${file} esiste ma non è dentro il sigillo: lo sto ignorando — \`muffin rot reseal\` per renderlo vincolante`
        : undefined,
    );
  }

  if (!onDisk) {
    return refused(`${file} è dichiarato dal sigillo ed è sparito: nessuno è owner finché non torna`);
  }
  const bytes = readFileSync(file);
  if (sha256(bytes) !== declared.sha256) {
    return refused(`${file} non corrisponde al sigillo (hash diverso): nessuno è owner`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refused(`${file} è sigillato ma non è JSON valido: nessuno è owner`);
  }
  const parsed = OwnerBindingSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refused(
      `${file} è sigillato ma non ha la forma attesa (${first?.path.join('.') || '(root)'}: ${first?.message ?? 'illeggibile'}): nessuno è owner`,
    );
  }

  return { binding: parsed.data, source: 'sealed' };
}

/** Il legame Telegram che vale davvero, dato ciò che il sigillo ha risposto. */
export function telegramOwner(
  sealed: SealedOwner,
  fromConfig: { ownerUserId?: number | undefined; ownerChatId?: number | undefined } | undefined,
): { userId?: number; chatId?: number } {
  if (sealed.source === 'refused') return {};
  const t = sealed.binding?.telegram;
  if (t !== undefined) return { userId: t.userId, chatId: t.chatId };
  // Sigillo presente ma che non dice niente su Telegram (per esempio una casa
  // che ha sigillato solo Discord): per *questa* superficie il sigillo non
  // rivendica nulla, quindi vale ancora la strada legacy.
  return {
    ...(fromConfig?.ownerUserId === undefined ? {} : { userId: fromConfig.ownerUserId }),
    ...(fromConfig?.ownerChatId === undefined ? {} : { chatId: fromConfig.ownerChatId }),
  };
}

/** Idem per Discord — stessa regola, un campo solo. */
export function discordOwner(
  sealed: SealedOwner,
  fromConfig: { ownerUserId?: string | undefined } | undefined,
): { userId?: string } {
  if (sealed.source === 'refused') return {};
  const d = sealed.binding?.discord;
  if (d !== undefined) return { userId: d.userId };
  return { ...(fromConfig?.ownerUserId === undefined ? {} : { userId: fromConfig.ownerUserId }) };
}

export type OwnerSealDeps = {
  /** Una riga per l'owner: cosa è successo, o cosa deve fare lui. */
  readonly out: (line: string) => void;
};

export type OwnerSealOutcome =
  | { readonly ok: true; readonly binding: OwnerBinding }
  | { readonly ok: false; readonly why: string };

/** Cosa si sta legando, in questa chiamata. Additivo: ciò che non nomini resta com'è. */
export type OwnerPatch = {
  readonly telegram?: { userId: number; chatId: number };
  readonly discord?: { userId: string };
};

/**
 * Scrive `rot/owner.json` e risigilla, in un atto solo — la stessa forma di
 * `widenEgressForCapability` (`core/rot/egress-writer.ts`, ADR-0058), perché è
 * la stessa classe di atto: un verbo di setup che l'owner digita e che tocca
 * il sigillo.
 *
 * **Perché qui non c'è una domanda da confermare, e lì sì.** ADR-0058 chiede
 * conferma perché l'host da aggiungere all'allowlist *non* è ciò che l'owner
 * ha scritto: viene da un catalogo di provider, e va nominato prima di essere
 * autorizzato. Qui l'atto **è** il comando: l'owner ha scritto `--owner <id>`,
 * oppure ha mandato dal proprio account il codice di pairing stampato sul suo
 * terminale. Una domanda con una sola risposta sensata trasformerebbe il
 * pairing in un flusso a due passi che può restare a metà — legame in
 * `config.json`, sigillo mancante — cioè esattamente lo stato legacy che
 * questa fetta esiste per chiudere.
 *
 * **Non risigilla mai sopra una divergenza già presente.** `seal()` ricalcola
 * gli hash di *tutti* i file del RoT: risigillare mentre `identity.md` o
 * `policy.json` divergono prenderebbe per buone anche quelle modifiche, e
 * quindi laverebbe una manomissione dietro un atto che l'owner ha chiesto per
 * tutt'altro. Quando il sigillo non è già pulito questa funzione non scrive
 * niente e stampa il rimedio: prima si guarda cosa è cambiato, poi si
 * risigilla a mano.
 */
export function sealOwnerBinding(home: string, patch: OwnerPatch, deps: OwnerSealDeps): OwnerSealOutcome {
  const { out } = deps;
  const rotDir = paths(home).rot;
  const file = join(rotDir, OWNER_FILE);
  const manifestFile = join(rotDir, MANIFEST_FILENAME);

  const desiderato: OwnerBinding = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    ...(patch.telegram === undefined ? {} : { telegram: patch.telegram }),
    ...(patch.discord === undefined ? {} : { discord: patch.discord }),
  };
  const rimedioAMano =
    `scrivi ${file} con ${JSON.stringify(desiderato)} e poi esegui \`muffin rot reseal\`, ` +
    'entrambi con il privilegio che possiede rot/';

  if (!existsSync(rotDir)) {
    const why = `${rotDir} non esiste: questo home non è stato inizializzato`;
    out(`owner non sigillato — ${why}`);
    return { ok: false, why };
  }

  // La modalità hardened è la ragione *prevista* per cui questo processo non
  // può scrivere: dirla prima di provarci evita di far leggere all'owner un
  // EACCES generico al posto della verità («il RoT appartiene a un altro
  // utente, ed è così che l'hai voluto»).
  const hardening = hardeningHolds(home);
  if (hardening.holds) {
    const why = `il root of trust non è scrivibile da questo processo (hardened)`;
    out(`owner NON sigillato — ${why}. Per farlo: ${rimedioAMano}`);
    return { ok: false, why };
  }

  const before = verify(home, 'single-user');
  if (!before.ok) {
    const why = `il sigillo è già divergente (${before.reason}${before.diverged.length > 0 ? `: ${before.diverged.join(', ')}` : ''})`;
    out(
      `owner NON sigillato — ${why}. Non risigillo sopra una divergenza che non hai confermato: ` +
        'guarda cosa è cambiato, `muffin rot reseal` una volta che è tuo, poi ripeti questo comando.',
    );
    return { ok: false, why };
  }

  // Additivo: un legame Discord non cancella quello Telegram già sigillato.
  const esistente = loadSealedOwner(home);
  const next: OwnerBinding = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    ...(esistente.binding?.telegram === undefined ? {} : { telegram: esistente.binding.telegram }),
    ...(esistente.binding?.discord === undefined ? {} : { discord: esistente.binding.discord }),
    ...(patch.telegram === undefined ? {} : { telegram: patch.telegram }),
    ...(patch.discord === undefined ? {} : { discord: patch.discord }),
  };

  // Gli stessi byte di prima, tenuti da parte: `seal()` scrive il manifest e
  // poi l'anchor, quindi un fallimento sul secondo lascia i due disallineati e
  // `verify()` legge `anchor_mismatch` — safe mode — anche se l'owner non ha
  // mai letto un errore. Identico al rollback di `egress-writer.ts`.
  const fileRawPrima = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const manifestRawPrima = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : undefined;
  const rotVersion = currentRotVersion(manifestFile);

  // Se il primo `writeFileSync` fallisce non c'è niente da rimettere a posto,
  // e provarci comunque produrrebbe una seconda scrittura che fallisce per lo
  // stesso motivo — cioè la frase «non sono riuscito a rimettere il manifest»
  // su un manifest che nessuno ha toccato.
  let scritto = false;
  try {
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    scritto = true;
    seal(home, rotVersion, new Date());
  } catch (error) {
    // Un `owner.json` che prima non c'era resta dov'è: cancellarlo sarebbe una
    // seconda scrittura che può fallire per lo stesso motivo della prima, e il
    // manifest rimesso a posto qui sotto non lo dichiara — quindi
    // `loadSealedOwner` lo vede fuori dal sigillo, lo ignora e lo dice.
    let rollbackFallito = false;
    if (scritto && fileRawPrima !== undefined) {
      try {
        writeFileSync(file, fileRawPrima, 'utf8');
      } catch {
        rollbackFallito = true;
      }
    }
    if (scritto && manifestRawPrima !== undefined) {
      try {
        writeFileSync(manifestFile, manifestRawPrima, 'utf8');
      } catch {
        rollbackFallito = true;
      }
    }

    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === 'EACCES' || code === 'EPERM'
        ? `non posso scrivere in ${rotDir}: permesso negato`
        : `scrittura fallita: ${error instanceof Error ? error.message : String(error)}`;
    out(
      `owner NON sigillato — ${why}. Per farlo: ${rimedioAMano}.` +
        (rollbackFallito
          ? ` E non sono riuscito a rimettere ${file} e ${manifestFile} come stavano: controlla con \`muffin rot verify\`.`
          : ''),
    );
    return { ok: false, why };
  }

  out('owner legato dentro il root of trust (rot/owner.json). Sigillo aggiornato.');
  return { ok: true, binding: next };
}

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
