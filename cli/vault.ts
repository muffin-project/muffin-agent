import { copyFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { paths } from '../core/config/config.js';
import { ensurePrivateDir, tightenPrivateFile } from '../core/config/private-fs.js';
import { Vault } from '../core/vault/vault.js';
import type { TrustTier } from '../core/policy/types.js';

/**
 * `muffin vault` — the directory is the source, this only maintains the index.
 *
 * Which is why there is no `muffin vault rm`: files are removed with `rm`, and
 * the next reindex notices. A vault command that owned deletion would be a
 * second source of truth about what exists, and there is only supposed to be
 * one.
 */

const TENANT = 'host';

export const VAULT_USAGE = `usage:
  muffin vault reindex [--tier 0|1|2|3]   allinea l'indice alla cartella
  muffin vault add <file> [--tier N]      copia un file nel vault e lo indicizza
  muffin vault ls                         cosa è indicizzato
  muffin vault check                      confronta disco e indice
`;

async function open(home: string) {
  const { buildRuntime } = await import('../agent/runtime.js');
  const runtime = buildRuntime(home);
  const root = paths(home).vault;
  if (!ensurePrivateDir(root)) {
    runtime.close();
    throw new Error(`non posso usare ${root}: la directory privata non è stata stabilita (symlink sulla catena)`);
  }
  return { runtime, vault: new Vault(runtime.memory.store, root), root };
}

export async function cmdVaultReindex(home: string, tier: TrustTier): Promise<number> {
  const { runtime, vault, root } = await open(home);
  try {
    const report = await vault.reindex(TENANT, { defaultTier: tier, vectors: runtime.memory.recall.vectors });
    process.stdout.write(
      `${root}\n` +
        `${report.scanned} file · ${report.added} nuovi · ${report.updated} aggiornati · ` +
        `${report.unchanged} invariati · ${report.removed} spariti\n` +
        `${report.chunks} chunk scritti · ${report.indexed} vettori\n`,
    );
    // Named one by one, with how much text came out: "3 nuovi" does not say
    // whether the 80-page PDF was read or was a scan that yielded nothing.
    for (const d of report.documents) {
      process.stdout.write(
        `  ${d.path} — ${d.format}, ${d.parts} parti, ${d.chars.toLocaleString('it-IT')} caratteri\n`,
      );
    }
    for (const s of report.skipped) process.stderr.write(`  saltato ${s.path} — ${s.why}\n`);
    for (const e of report.errors) process.stderr.write(`  ! ${e}\n`);
    return 0;
  } finally {
    runtime.close();
  }
}

export async function cmdVaultAdd(home: string, source: string, tier: TrustTier): Promise<number> {
  const from = resolve(source);
  if (!existsSync(from) || !statSync(from).isFile()) {
    process.stderr.write(`non è un file: ${source}\n`);
    return 78;
  }
  const { runtime, vault, root } = await open(home);
  try {
    const target = join(root, basename(from));
    if (existsSync(target)) {
      process.stderr.write(`esiste già: ${basename(from)} — spostalo a mano se vuoi sostituirlo\n`);
      return 1;
    }
    copyFileSync(from, target);
    tightenPrivateFile(target);
    const report = await vault.reindexPath(TENANT, basename(from), {
      defaultTier: tier,
      vectors: runtime.memory.recall.vectors,
    });
    const skipped = report.skipped.find((s) => s.path === basename(from));
    if (skipped) {
      process.stderr.write(`copiato ma non indicizzato — ${skipped.why}\n`);
      return 1;
    }
    process.stdout.write(`${basename(from)} → ${report.chunks} chunk, tier ${tier}\n`);
    return 0;
  } finally {
    runtime.close();
  }
}

export async function cmdVaultLs(home: string): Promise<number> {
  const { runtime } = await open(home);
  try {
    const rows = runtime.memory.store.vaultPaths(TENANT);
    if (rows.length === 0) {
      process.stderr.write(`vault vuoto — ${paths(home).vault}\n`);
      return 1;
    }
    for (const r of rows) {
      process.stdout.write(`${String(r.chunks).padStart(4)} chunk  tier ${r.trustTier}  ${r.vaultPath}\n`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

/**
 * The check that exists because the mechanism working is not the same as the
 * index being right — every comparable system has an open bug of exactly this
 * shape, and so did this project's predecessor.
 */
export async function cmdVaultCheck(home: string): Promise<number> {
  const { runtime, vault } = await open(home);
  try {
    const audit = await vault.audit(TENANT);
    process.stdout.write(`${audit.files} file leggibili sul disco · ${audit.indexed} indicizzati\n`);
    for (const p of audit.missing) process.stdout.write(`  ! sul disco, non indicizzato   ${p}\n`);
    for (const p of audit.stale) process.stdout.write(`  ! indice stantio               ${p}\n`);
    for (const p of audit.orphaned) process.stdout.write(`  ! indicizzato, file sparito    ${p}\n`);
    for (const p of audit.unreadable) process.stdout.write(`  ! sul disco, illeggibile ora   ${p}\n`);
    const drift = audit.missing.length + audit.stale.length + audit.orphaned.length + audit.unreadable.length;
    if (drift === 0) {
      process.stdout.write(`indice allineato\n`);
      return 0;
    }
    process.stdout.write(`\n${drift} disallineamenti — \`muffin vault reindex\` li risolve\n`);
    return 1;
  } finally {
    runtime.close();
  }
}
