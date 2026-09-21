import { writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { ensurePrivateDir, tightenPrivateFile } from '../../core/config/private-fs.js';
import type { CapabilityDecl, TrustTier } from '../../core/policy/types.js';
import type { Vault } from '../../core/vault/vault.js';
import type { VectorIndex } from '../../core/memory/vectors.js';
import type { RegisteredTool, ToolOutcome } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * **«Salva questo» — la prima capacità che una stanza riceve (ADR-0073 punto 2).**
 *
 * Il fatto misurato che la rende necessaria: fino al 06/09 nessuna scrittura
 * durevole di questo sistema era *deliberata*. I soli produttori erano
 * automatici — l'ingestione di un allegato, l'episodio di ogni turno — quindi
 * «Muffin, tienimi questo» non aveva una porta, per nessun tenant, owner
 * compreso. Non è un permesso tolto a qualcuno: è una capability che non
 * esisteva.
 *
 * **Lo spazio della stanza è il suo vault, e non il disco.** `fs_write` resta
 * `hostOnly` e non concedibile (`core/policy/matrix.ts#MAI_CONCEDIBILI`)
 * perché `resolveWorkspace` conosce uno spazio per *installazione* (ADR-0059):
 * dare `fs.write` a un gruppo vorrebbe dire dargli il workspace dell'owner. Il
 * vault invece è già multi-tenant nel posto che conta — l'indice — perché ogni
 * chunk è una riga `episodes` con il proprio `tenant_id`, e `documents.read`
 * legge già per tenant.
 *
 * **Il confine, in tre pezzi che vanno letti insieme:**
 *
 *  1. **Il tenant non è un argomento.** Viene da `ctx.tenant`, che il loop
 *     risolve dal principal autenticato e che il kernel ha già verificato
 *     (`tenant_mismatch`). Non c'è nessuna forma di questa chiamata in cui il
 *     modello — o un contenuto avvelenato che lo guida — possa nominare la
 *     stanza in cui scrivere. `vault-save.test.ts` prova esattamente questo:
 *     un `tenant` messo negli argomenti non tocca dove i byte finiscono.
 *  2. **La directory è derivata dal tenant.** `salvati/<slug>/…`, con lo slug
 *     costruito da un alfabeto chiuso — non ripulito: la stessa decisione, e
 *     per la stessa ragione, di `safeVaultName` in
 *     `connectors/telegram/media.ts`. Due stanze non possono collidere su un
 *     nome di file, quindi una stanza non può *sovrascrivere* il file di
 *     un'altra, che sarebbe una scrittura cross-tenant anche se l'indice
 *     restasse separato.
 *  3. **Nessuna lettura.** Questo tool non legge niente: scrive e indicizza.
 *     La strada di ritorno è `documents.read`, che è già per tenant. Il
 *     falsificatore del punto 3 dell'ADR — un membro che usa il vault come
 *     canale laterale verso *fuori* — non passa da qui: passerebbe da una
 *     lettura cross-tenant, e quella non esiste.
 *
 * **Perché non chiede.** La capability è `reversible: 'undoable'` su la riga
 * `vault`, che dichiara `asksForIrreversible: false` e `denyAbove: 3`: il
 * kernel risponde `draft`, cioè «fallo, ma prima fotografa». Il giornale e
 * `muffin undo` sono gli stessi di `fs_write` — `resolveEffectPath` qui sotto
 * è la funzione che il ramo `draft` di `agent/loop/tool-call.ts` chiama per
 * sapere quale file copiare, e l'handler riusa `ctx.effectPath` invece di
 * ricalcolarlo, così copia e scrittura parlano dello stesso file per
 * costruzione. In un gruppo un `ask` non raggiunge nessuno che possa
 * rispondere: chiedere qui sarebbe un divieto travestito, e ciò che rende la
 * scrittura sicura è il confine, non la fiducia in chi scrive.
 *
 * **`hostOnly: true` lo stesso.** Il default resta chiuso: la riceve solo una
 * stanza che il `policy.json` sigillato nomina. Nel tenant `host` è l'owner, e
 * l'owner la usa senza domanda — coerente con ADR-0074, dove una scrittura con
 * un undo non è mai una domanda.
 */
export const vaultWriteCapability: CapabilityDecl = {
  id: 'vault.write',
  effect: 'vault',
  /**
   * `medium`, e non è cautela generica: sotto `medium` il kernel **non**
   * produce un `draft` (`decide.ts`: `reversible === 'undoable' && risk !==
   * 'low'`), perché una `low` undoable — `turn.todo`, una riga in una tabella
   * nostra — non ha un file da fotografare. Qui il file c'è, e un `allow`
   * senza copia sarebbe una scrittura durevole senza undo: esattamente ciò che
   * `reversible: 'undoable'` promette che non succede.
   *
   * Le altre due cose che `medium` decide, entrambe volute: la scrittura è
   * negata in safe mode (radice di fiducia divergente = i grant stessi sono in
   * dubbio) e conta contro il budget del tenant, che per una stanza è
   * `perTenantDailyUsd`.
   */
  risk: 'medium',
  reversible: 'undoable',
  /**
   * Riscrivere lo stesso file con gli stessi byte dà lo stesso file: il test
   * di `rerunnable` che `fs.write` passa e che un invio di messaggio non
   * passa. Il nome del file è derivato dal titolo, non da un contatore, quindi
   * un resume dopo un crash non produce un secondo salvataggio.
   */
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: ['titolo'],
  hostOnly: true,
};

const vaultSaveSpec: ToolSpec = {
  name: 'vault_save',
  description:
    'Save something so it stays: a note, a piece of text, a link you already read, the useful part of ' +
    'a document already in memory. It goes into the vault of THIS conversation and nowhere else, it is ' +
    'indexed straight away, and memory_search / document_read find it afterwards. Use it when someone ' +
    'says "keep this", "save this", "write this down", or when you have just produced something worth ' +
    'keeping. Not for a file on the machine — that is fs_write, and it is a different place. ' +
    'e.g. vault_save({titolo: "affitto 2026", testo: "scadenza il 5 di ogni mese, IBAN ..."}).',
  inputSchema: {
    type: 'object',
    properties: {
      titolo: {
        type: 'string',
        description: 'Short title. It becomes the filename, so say what the thing is.',
      },
      testo: { type: 'string', description: 'The full text to keep. Nothing is summarised away.' },
    },
    required: ['titolo', 'testo'],
  },
};

/** Where a tenant's deliberate saves live, relative to the vault root. */
export const SALVATI = 'salvati';

/**
 * Il nome di directory di una stanza, **costruito** e non ripulito.
 *
 * Stessa decisione di `safeVaultName`: ragionare su ogni codifica di `..` che
 * un filesystem potrebbe accettare è una conversazione che non si vince, e un
 * tenant id contiene già `:` e può contenere un `-` iniziale
 * (`group:telegram:-100950`). Alfabeto chiuso, un solo trattino di fila, mai
 * un punto iniziale — il vault rifiuta di indicizzare i dotfile
 * (`core/vault/vault.ts#skipReason`) e una stanza non deve poter decidere che
 * il proprio spazio è invisibile.
 */
export function tenantSlug(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug === '' ? 'tenant' : slug;
}

/** Lo stesso trattamento per il titolo che il modello sceglie: costruito, mai ripulito. */
export function nomeFile(titolo: string): string {
  const stem = titolo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem === '' ? 'nota' : stem}.md`;
}

/**
 * Il percorso, relativo alla radice del vault, in cui questa chiamata scrive.
 *
 * Pura e derivata **solo** da `(tenant, titolo)`: è ciò che rende vera la
 * frase «il tenant non è un argomento». Esportata perché la usano tre
 * chiamanti che devono essere d'accordo per costruzione — `resolveEffectPath`
 * (la copia), l'handler (la scrittura) e il test che prova il confine.
 */
export function vaultPathPer(tenantId: string, titolo: string): string {
  return `${SALVATI}/${tenantSlug(tenantId)}/${nomeFile(titolo)}`;
}

type Args = { titolo: string; testo: string };

function parseArgs(args: unknown): Args | string {
  const { titolo, testo } = (args ?? {}) as { titolo?: unknown; testo?: unknown };
  if (typeof titolo !== 'string' || titolo.trim() === '') {
    return 'vault_save richiede "titolo" non vuoto.';
  }
  if (typeof testo !== 'string' || testo.trim() === '') {
    return 'vault_save richiede "testo" non vuoto.';
  }
  return { titolo: titolo.trim(), testo };
}

export type VaultSaveDeps = {
  vault: Vault;
  /** Radice del vault sul disco: `paths(home).vault`. */
  root: string;
  vectors?: VectorIndex | undefined;
};

export function makeVaultSaveTool(deps: VaultSaveDeps): RegisteredTool {
  return {
    capability: vaultWriteCapability.id,
    spec: vaultSaveSpec,
    /**
     * Tier 0: l'unica cosa che questo tool restituisce è la propria frase sul
     * percorso in cui ha scritto. Il testo salvato viene dal turno e ci resta;
     * non rientra da qui. `throwTier: 0` per lo stesso motivo — i soli lanci
     * possibili sono errori di filesystem con un percorso nostro dentro.
     */
    throwTier: 0,
    /**
     * Il file che il ramo `draft` fotografa prima di eseguire. Assoluto, e —
     * questo è il punto — derivato dalla **stessa** coppia `(tenant, titolo)`
     * da cui l'handler deriverà il suo, passando per la stessa `vaultPathPer`.
     * Il tenant arriva dal `ToolContext`, cioè dal principal autenticato, mai
     * dagli argomenti: un `tenant` scritto dal modello non è nello schema del
     * tool e non avrebbe comunque nessuna strada per arrivare qui.
     *
     * Lancia sugli stessi casi su cui fallirebbe la scrittura (titolo o testo
     * vuoti), e il loop legge il lancio come «non eseguire»: senza copia non
     * si torna indietro.
     */
    resolveEffectPath: (args, ctx) => {
      const parsed = parseArgs(args);
      if (typeof parsed === 'string') throw new Error(parsed);
      return resolve(deps.root, vaultPathPer(ctx.tenant, parsed.titolo));
    },
    handler: (args, ctx) => salva(deps, ctx.tenant, args, ctx.taint(), ctx.effectPath),
  };
}

export async function salva(
  deps: VaultSaveDeps,
  tenantId: string,
  args: unknown,
  tier: TrustTier,
  effectPath: string | undefined,
): Promise<ToolOutcome> {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') return { content: parsed, isError: true, tier: 0 };

  // Il percorso relativo è la verità durevole (è ciò che va nell'indice); il
  // percorso assoluto lo si preferisce da `ctx.effectPath` quando c'è, così
  // la copia del giornale e questa scrittura sono lo stesso file per
  // costruzione e non per coincidenza — la stessa forma di `fs_write`.
  const relativo = vaultPathPer(tenantId, parsed.titolo);
  const assoluto = effectPath ?? resolve(deps.root, relativo);
  const dentro = resolve(deps.root);
  if (assoluto !== dentro && !assoluto.startsWith(`${dentro}${sep}`)) {
    // Irraggiungibile con lo slug costruito sopra: è la cintura, non la
    // bretella. Un percorso fuori dalla radice qui vorrebbe dire che qualcuno
    // ha cambiato `vaultPathPer` senza cambiare questa riga.
    return { content: 'vault_save: percorso fuori dal vault, non eseguito.', isError: true, tier: 0 };
  }

  // Directory privata 0700 e nota 0600, con gli helper canonici della PR
  // (#639): nessuna seconda policy dei permessi in questo tool. Il `false`
  // fail-closed (ancestor symlink sulla catena) non è un no-op silenzioso:
  // scrivere comunque ricreerebbe l'escape, quindi l'operazione fallisce in
  // modo veritiero senza toccare il disco fuori dal vault.
  if (!ensurePrivateDir(dirname(assoluto))) {
    return {
      content: `vault_save: non ho potuto preparare la directory privata per \`${relativo}\`, non eseguito.`,
      isError: true,
      tier: 0,
    };
  }
  writeFileSync(assoluto, `# ${parsed.titolo}\n\n${parsed.testo}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenPrivateFile(assoluto);

  // Il tenant del turno viaggia con i byte: è la riga che decide chi potrà
  // rileggerli con `document_read`, e passarci `host` qui è esattamente il
  // difetto che `connectors/shared/ingress/ingest.ts` documenta di avere già
  // commesso una volta.
  const report = await deps.vault.reindexPath(tenantId, relativo, {
    defaultTier: tier,
    ...(deps.vectors === undefined ? {} : { vectors: deps.vectors }),
  });
  const skipped = report.skipped.find((s) => s.path === relativo);
  if (skipped) {
    return {
      content: `Ho scritto \`${relativo}\` ma non è finito in memoria: ${skipped.why}. Dillo invece di darlo per fatto.`,
      isError: true,
      tier: 0,
    };
  }
  return {
    content: `Salvato in \`${relativo}\` e messo in memoria di questa conversazione. Rileggilo con document_read({path: "${relativo}"}).`,
    tier: 0,
  };
}
