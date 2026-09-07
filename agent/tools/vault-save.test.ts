import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../core/memory/store.js';
import { Vault } from '../../core/vault/vault.js';
import { readDocument } from './document.js';
import { makeVaultSaveTool, vaultPathPer, vaultWriteCapability } from './vault-save.js';
import { toolContext } from '../fixtures/tool-context.js';

/**
 * **`vault_save` scrive nel vault del tenant del turno, e in nessun altro.**
 *
 * La forma della prova è quella che ADR-0073 chiede: non «il tool rifiuta un
 * argomento `tenant`» — un rifiuto si può dimenticare — ma **i byte finiscono
 * dove finiscono anche quando qualcuno prova a nominare un'altra stanza**,
 * perché il tenant non è un argomento e non c'è nessuna forma della chiamata
 * in cui possa diventarlo.
 *
 * La radice ha la forma di produzione (`<tmp>/.muffin/vault`) per la stessa
 * ragione di `core/vault/vault.test.ts`: il filtro dei dotfile del vault gira
 * anche sul percorso assoluto risolto, e un fixture senza il segmento
 * `.muffin` proverebbe una macchina che non esiste.
 */
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'muffin-vault-save-')), '.muffin', 'vault');
  mkdirSync(root, { recursive: true });
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vault = new Vault(store, root);
  return { root, store, vault, tool: makeVaultSaveTool({ root, vault }) };
}

const STANZA = 'group:telegram:-100950';
const ALTRA = 'group:telegram:-100777';

describe('vault_save — «salva questo», nel vault di questa stanza', () => {
  it('scrive e indicizza nel tenant del turno, e document_read di quella stanza lo ritrova', async () => {
    const f = fixture();
    const out = await f.tool.handler(
      { titolo: 'affitto 2026', testo: 'scadenza il 5 di ogni mese' },
      toolContext({ tenant: STANZA }),
    );
    expect(out.isError).not.toBe(true);

    const atteso = vaultPathPer(STANZA, 'affitto 2026');
    expect(out.content).toContain(atteso);
    expect(readFileSync(join(f.root, atteso), 'utf8')).toContain('scadenza il 5 di ogni mese');

    // Non solo il file: l'indice. Una scrittura che non entra in memoria è
    // un file che nessuno ritrova, cioè la metà inutile del meccanismo.
    const letto = await readDocument(f.vault, f.store, STANZA, { path: atteso });
    expect(letto.isError).not.toBe(true);
    expect(letto.content).toContain('scadenza il 5 di ogni mese');
  });

  it("il tenant `host` NON vede ciò che una stanza ha salvato", async () => {
    const f = fixture();
    await f.tool.handler({ titolo: 'nota', testo: 'roba della stanza' }, toolContext({ tenant: STANZA }));
    const atteso = vaultPathPer(STANZA, 'nota');

    // Il file è sul disco condiviso — il vault è uno solo — e la separazione
    // vive nell'indice, che è dove `document_read` guarda. Un `host` che
    // nomina il percorso esatto non ottiene i byte.
    expect(existsSync(join(f.root, atteso))).toBe(true);
    const daHost = await readDocument(f.vault, f.store, 'host', { path: atteso });
    expect(daHost.isError).toBe(true);
    expect(daHost.content).not.toContain('roba della stanza');

    // E il verso opposto, perché «host non vede» sarebbe vero anche se
    // l'indicizzazione non fosse mai avvenuta.
    const daStanza = await readDocument(f.vault, f.store, STANZA, { path: atteso });
    expect(daStanza.content).toContain('roba della stanza');
  });

  /**
   * **Il falsificatore del confine.** Un `tenant` (e un `path`, e un
   * `vaultPath`) messi negli argomenti dal modello — o da un contenuto
   * avvelenato che lo guida — non spostano di un byte dove la scrittura
   * atterra. Non c'è nessun ramo del tool che li legga: il tenant viene da
   * `ctx.tenant`, che il loop risolve dal principal autenticato.
   *
   * La mutazione che lo fa cadere: leggere il tenant dagli argomenti in
   * `salva()` (`args.tenant ?? ctx.tenant`). Allora la prima asserzione
   * troverebbe i byte nella cartella dell'altra stanza.
   */
  it('un tenant passato negli argomenti non tocca dove i byte finiscono', async () => {
    const f = fixture();
    await f.tool.handler(
      {
        titolo: 'dirottata',
        testo: 'segreto',
        tenant: ALTRA,
        tenantId: ALTRA,
        path: `salvati/${ALTRA}/altrove.md`,
      },
      toolContext({ tenant: STANZA }),
    );

    expect(existsSync(join(f.root, vaultPathPer(STANZA, 'dirottata')))).toBe(true);
    expect(existsSync(join(f.root, vaultPathPer(ALTRA, 'dirottata')))).toBe(false);

    // E l'altra stanza non lo legge nemmeno per percorso.
    const daAltra = await readDocument(f.vault, f.store, ALTRA, {
      path: vaultPathPer(STANZA, 'dirottata'),
    });
    expect(daAltra.isError).toBe(true);
  });

  /**
   * Due stanze, lo stesso titolo. Senza la cartella per tenant sarebbero lo
   * **stesso file**, e la seconda scrittura sovrascriverebbe la prima: una
   * scrittura cross-tenant anche con l'indice separato, e la più silenziosa
   * che esista (il file c'è, ma i byte sono di qualcun altro).
   */
  it('due stanze con lo stesso titolo non si sovrascrivono', async () => {
    const f = fixture();
    await f.tool.handler({ titolo: 'spesa', testo: 'pane' }, toolContext({ tenant: STANZA }));
    await f.tool.handler({ titolo: 'spesa', testo: 'latte' }, toolContext({ tenant: ALTRA }));

    expect(vaultPathPer(STANZA, 'spesa')).not.toBe(vaultPathPer(ALTRA, 'spesa'));
    expect(readFileSync(join(f.root, vaultPathPer(STANZA, 'spesa')), 'utf8')).toContain('pane');
    expect(readFileSync(join(f.root, vaultPathPer(ALTRA, 'spesa')), 'utf8')).toContain('latte');
  });

  /**
   * Il percorso non è mai ripulito, è **costruito** — la stessa decisione di
   * `safeVaultName` per il nome di un allegato. Un titolo ostile produce un
   * nome dall'alfabeto chiuso, dentro la cartella della propria stanza.
   */
  it('un titolo ostile non esce dalla cartella della stanza', () => {
    for (const titolo of ['../../.ssh/authorized_keys', '.env', '/etc/passwd', '..']) {
      const p = vaultPathPer(STANZA, titolo);
      expect(`${titolo} → ${p}`).toContain(`salvati/group-telegram-100950/`);
      expect(p.includes('..')).toBe(false);
      expect(p.split('/').some((seg) => seg.startsWith('.'))).toBe(false);
    }
  });

  /**
   * Il file che il ramo `draft` del loop fotografa deve essere **quello** che
   * l'handler scriverà: se i due divergono, `muffin undo` ripristina un altro
   * file, che è peggio di nessun undo. Qui si prova che entrambi derivano da
   * `(tenant del contesto, titolo)` — e in particolare che la fotografia usa
   * il tenant del turno e non un argomento.
   */
  it('resolveEffectPath fotografa lo stesso file che l’handler scrive', async () => {
    const f = fixture();
    expect(f.tool.resolveEffectPath).toBeDefined();
    const risolto = f.tool.resolveEffectPath!(
      { titolo: 'nota', testo: 'x', tenant: ALTRA },
      toolContext({ tenant: STANZA }),
    );
    expect(risolto.endsWith(vaultPathPer(STANZA, 'nota'))).toBe(true);

    await f.tool.handler({ titolo: 'nota', testo: 'x' }, toolContext({ tenant: STANZA }));
    expect(existsSync(risolto)).toBe(true);
  });

  it('la dichiarazione dice le tre cose da cui dipende tutto il resto', () => {
    // `undoable` + `medium` è ciò che fa rispondere `draft` al kernel (e non
    // `allow`): senza `medium`, una scrittura durevole passerebbe senza copia.
    expect(vaultWriteCapability.reversible).toBe('undoable');
    expect(vaultWriteCapability.risk).toBe('medium');
    // `vault`, non `host`: una stanza non ha una macchina.
    expect(vaultWriteCapability.effect).toBe('vault');
    // E chiusa di default: la riceve solo una stanza che il sigillo nomina.
    expect(vaultWriteCapability.hostOnly).toBe(true);
  });
});
