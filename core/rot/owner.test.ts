import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discordOwner, loadSealedOwner, OWNER_FILE, sealOwnerBinding, telegramOwner } from './owner.js';
import { seal, verify } from './verify.js';

/**
 * Il legame owner sotto il sigillo — DAY-1 B15, la metà «protetto».
 *
 * Quello che questi test difendono non è «il file si legge»: è la precedenza.
 * Un legame sigillato deve vincere su `config.json`; un legame sigillato che
 * **non si verifica** non deve autenticare nessuno *e* non deve far
 * retrocedere la decisione su `config.json` — perché chi può riscrivere
 * `config.json` può anche cancellare `rot/owner.json`, e una retrocessione
 * trasformerebbe il sigillo in un suggerimento.
 */

const NOW = new Date('2026-09-04T12:00:00Z');

/** Una casa con un RoT minimo, sigillata come la lascia `muffin init`. */
function casa(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-owner-'));
  mkdirSync(join(dir, 'rot'), { recursive: true });
  writeFileSync(join(dir, 'rot', 'policy.json'), '{"schemaVersion":1}\n');
  writeFileSync(join(dir, 'rot', 'identity.md'), '# chi sono\n');
  seal(dir, '0.0.0', NOW);
  return dir;
}

const righe: string[] = [];
const out = (riga: string): void => {
  righe.push(riga);
};

describe('rot/owner.json — lettura e precedenza', () => {
  it('una casa sigillata prima di questa release è legacy: decide config.json', () => {
    const dir = casa();
    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('legacy');
    expect(telegramOwner(sealed, { ownerUserId: 111, ownerChatId: 111 })).toEqual({ userId: 111, chatId: 111 });
    expect(discordOwner(sealed, { ownerUserId: '222' })).toEqual({ userId: '222' });
  });

  it('un legame sigillato vince su config.json, che non viene nemmeno letto', () => {
    const dir = casa();
    expect(sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out }).ok).toBe(true);

    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('sealed');
    // config.json nomina un altro: resta uno sconosciuto.
    expect(telegramOwner(sealed, { ownerUserId: 111, ownerChatId: 111 })).toEqual({ userId: 999, chatId: 999 });
  });

  it('un legame sigillato e poi modificato non autentica nessuno, e non retrocede su config.json', () => {
    const dir = casa();
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    // La manomissione: lo stesso file, un altro owner, nessun reseal.
    writeFileSync(join(dir, 'rot', OWNER_FILE), JSON.stringify({ schemaVersion: 1, telegram: { userId: 111, chatId: 111 } }));

    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('refused');
    expect(sealed.note).toMatch(/non corrisponde al sigillo/);
    expect(telegramOwner(sealed, { ownerUserId: 111, ownerChatId: 111 })).toEqual({});
    expect(discordOwner(sealed, { ownerUserId: '111' })).toEqual({});
  });

  it('un legame sigillato e poi cancellato non fa tornare buono config.json', () => {
    // La mossa ovvia per chi può scrivere come l'owner: togli il file
    // sigillato e lascia parlare quello ordinario.
    const dir = casa();
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    rmSync(join(dir, 'rot', OWNER_FILE));

    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('refused');
    expect(telegramOwner(sealed, { ownerUserId: 111, ownerChatId: 111 })).toEqual({});
  });

  it('un manifest riscritto per coprire la manomissione non passa: decide l\'anchor', () => {
    const dir = casa();
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    writeFileSync(join(dir, 'rot', OWNER_FILE), JSON.stringify({ schemaVersion: 1, telegram: { userId: 111, chatId: 111 } }));
    // Ri-sigilla senza l'anchor: è ciò che può fare chi non possiede la home.
    const manifest = JSON.parse(readFileSync(join(dir, 'rot', 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    manifest.files = manifest.files.map((f) => (f.path === OWNER_FILE ? { ...f, sha256: 'deadbeef' } : f));
    writeFileSync(join(dir, 'rot', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('refused');
    expect(sealed.note).toMatch(/anchor|non è più confermato/);
  });

  it('un owner.json scritto senza risigillare viene ignorato, e lo dice', () => {
    const dir = casa();
    writeFileSync(join(dir, 'rot', OWNER_FILE), JSON.stringify({ schemaVersion: 1, telegram: { userId: 111, chatId: 111 } }));
    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('legacy');
    expect(sealed.note).toMatch(/non è dentro il sigillo/);
    // E `verify()` lo vede comunque come intruso: le due difese sono separate.
    expect(verify(dir, 'single-user').ok).toBe(false);
  });

  it('un legame sigillato ma con la forma sbagliata è rifiutato, non ignorato', () => {
    const dir = casa();
    // `userId` come stringa su Telegram: passerebbe un `JSON.parse` e non
    // farebbe mai match con l'id numerico che riporta la piattaforma.
    writeFileSync(join(dir, 'rot', OWNER_FILE), JSON.stringify({ schemaVersion: 1, telegram: { userId: '999', chatId: 999 } }));
    seal(dir, '0.0.0', NOW);

    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('refused');
    expect(sealed.note).toMatch(/forma attesa/);
  });

  it('una schemaVersion che questa build non conosce è rifiutata', () => {
    const dir = casa();
    writeFileSync(join(dir, 'rot', OWNER_FILE), JSON.stringify({ schemaVersion: 2, telegram: { userId: 999, chatId: 999 } }));
    seal(dir, '0.0.0', NOW);
    expect(loadSealedOwner(dir).source).toBe('refused');
  });

  it('un sigillo che parla solo di Discord lascia Telegram alla strada legacy', () => {
    const dir = casa();
    sealOwnerBinding(dir, { discord: { userId: '222' } }, { out });
    const sealed = loadSealedOwner(dir);
    expect(sealed.source).toBe('sealed');
    expect(discordOwner(sealed, undefined)).toEqual({ userId: '222' });
    expect(telegramOwner(sealed, { ownerUserId: 111, ownerChatId: 111 })).toEqual({ userId: 111, chatId: 111 });
  });
});

describe('rot/owner.json — scrittura', () => {
  it('scrive e risigilla in un atto solo: dopo, `verify` è pulita', () => {
    const dir = casa();
    const esito = sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    expect(esito.ok).toBe(true);
    expect(existsSync(join(dir, 'rot', OWNER_FILE))).toBe(true);
    // Il punto: scrivere dentro `rot/` senza risigillare manderebbe
    // l'installazione in safe mode al prossimo avvio.
    expect(verify(dir, 'single-user').ok).toBe(true);
  });

  it('aggiunge senza cancellare: legare Discord non scioglie Telegram', () => {
    const dir = casa();
    sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    sealOwnerBinding(dir, { discord: { userId: '222' } }, { out });
    const sealed = loadSealedOwner(dir);
    expect(sealed.binding).toMatchObject({ telegram: { userId: 999 }, discord: { userId: '222' } });
  });

  it('non risigilla sopra una divergenza che l\'owner non ha confermato', () => {
    // `seal()` ricalcola gli hash di *tutti* i file: risigillare qui
    // laverebbe la modifica a identity.md dietro un atto chiesto per altro.
    const dir = casa();
    writeFileSync(join(dir, 'rot', 'identity.md'), '# sono qualcun altro\n');
    righe.length = 0;
    const esito = sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
    expect(esito.ok).toBe(false);
    expect(existsSync(join(dir, 'rot', OWNER_FILE))).toBe(false);
    expect(righe.join('\n')).toMatch(/NON sigillato/);
    expect(righe.join('\n')).toMatch(/identity\.md/);
  });

  it('un rot/ non scrivibile non produce un successo finto: dice il rimedio esatto', () => {
    // La modalità hardened è questo caso reso permanente da un altro utente
    // OS. Qui lo si riproduce con i permessi, che è la stessa domanda che si
    // pone il kernel — e si salta da root, dove il permesso non si applica e
    // il test proverebbe la macchina invece del prodotto.
    if (process.getuid?.() === 0) {
      console.warn('[owner] saltato: da root il deny di scrittura non si applica');
      return;
    }
    const dir = casa();
    chmodSync(join(dir, 'rot'), 0o555);
    righe.length = 0;
    try {
      const esito = sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
      expect(esito.ok).toBe(false);
      const detto = righe.join('\n');
      expect(detto).toMatch(/NON sigillato/);
      expect(detto).toMatch(/permesso negato/);
      // Il rimedio è copiabile: il file, il contenuto esatto e il comando.
      expect(detto).toContain('owner.json');
      expect(detto).toContain('muffin rot reseal');
    } finally {
      chmodSync(join(dir, 'rot'), 0o755);
    }
    // E il sigillo è rimasto quello di prima: nessuno stato a metà.
    expect(verify(dir, 'single-user').ok).toBe(true);
  });

  it('una home senza rot/ non viene inventata: lo dice e non scrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-owner-vuota-'));
    righe.length = 0;
    expect(sealOwnerBinding(dir, { telegram: { userId: 1, chatId: 1 } }, { out }).ok).toBe(false);
    expect(righe.join('\n')).toMatch(/non esiste/);
  });

  it('rot/owner.json nasce a 0600 anche con umask 022', () => {
    const prev = process.umask(0o022);
    try {
      const dir = casa();
      const esito = sealOwnerBinding(dir, { telegram: { userId: 999, chatId: 999 } }, { out });
      expect(esito.ok).toBe(true);
      expect(statSync(join(dir, 'rot', OWNER_FILE)).mode & 0o777).toBe(0o600);
      expect(verify(dir, 'single-user').ok).toBe(true);
    } finally {
      process.umask(prev);
    }
  });
});
