import { inflateRawSync } from 'node:zlib';

/**
 * Bounded entries out of the ZIP container inside a DOCX.
 *
 * A `.docx` is a ZIP holding related XML parts: body, headers, footers and
 * notes all carry text. This stays stdlib-only because `node:zlib`
 * already does the hard half (DEFLATE), and what is left is walking a central
 * directory whose layout has not changed since 1993 (PKWARE APPNOTE 6.3.10,
 * §4.3.12 and §4.3.16). The alternative measured on 2026-08-15 was `mammoth`,
 * the standard choice, which brings **ten** runtime dependencies — against a
 * repo that runs on thirteen and treats each new one as the risk it is
 * (`docs/development/PRACTICES.md` §1).
 *
 * What it deliberately does not do: ZIP64 (a `.docx` is never above 4 GB nor
 * above 65,535 entries), encryption, and multi-disk archives. Each of those
 * fails with a named error rather than a wrong slice, because the failure a
 * caller cannot distinguish from success is the one that costs.
 *
 * Sizes are read from the **central directory**, never from the local header:
 * a writer that streams leaves zeros in the local header and puts the real
 * numbers in a data descriptor after the payload. The central directory is
 * authoritative in both cases.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** ZIP64 puts this sentinel where a 32-bit field would overflow. */
const NEEDS_ZIP64 = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

/** One XML part may never expand beyond the vault's 20 MB document ceiling. */
export const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;

export type ZipEntry = {
  name: string;
  compressed: number;
  uncompressed: number;
  method: number;
  flags: number;
  localOffset: number;
};

export class NotAZip extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'NotAZip';
  }
}

/**
 * Reads one named entry, decompressed. `null` when the archive is a valid ZIP
 * that simply does not contain that name — a `.docx` without
 * `word/document.xml` is a real thing (a corrupt export) and is not the same
 * failure as "these bytes are not a ZIP at all".
 *
 * Throws `NotAZip` when the container itself cannot be read.
 */
export function listZipEntries(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  let cursor = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    throw new NotAZip('archivio ZIP multi-disco, non supportato');
  }
  if (cursor === NEEDS_ZIP64) throw new NotAZip('archivio ZIP64, non supportato');
  if (cursor + centralBytes > eocd) throw new NotAZip('directory centrale ZIP fuori dai limiti');

  const found: ZipEntry[] = [];
  const names = new Set<string>();

  for (let i = 0; i < entries; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new NotAZip('directory centrale ZIP illeggibile');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > bytes.length) {
      throw new NotAZip('directory centrale ZIP troncata');
    }
    const entryName = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (compressed === NEEDS_ZIP64 || uncompressed === NEEDS_ZIP64 || localOffset === NEEDS_ZIP64) {
      throw new NotAZip('voce ZIP64, non supportata');
    }
    if ((flags & 0x0001) !== 0) throw new NotAZip(`voce ZIP cifrata, non supportata: ${entryName}`);
    if (names.has(entryName)) {
      throw new NotAZip(`nome duplicato nella directory ZIP: ${entryName}`);
    }
    names.add(entryName);
    found.push({ name: entryName, compressed, uncompressed, method, flags, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== bytes.readUInt32LE(eocd + 16) + centralBytes) {
    throw new NotAZip('dimensione della directory centrale ZIP incoerente');
  }
  return found;
}

/** Presence check that never inflates attacker-controlled data. */
export function hasZipEntry(bytes: Buffer, name: string): boolean {
  return listZipEntries(bytes).some((entry) => entry.name === name);
}

export function readZipEntry(
  bytes: Buffer,
  name: string,
  maxOutputBytes = MAX_ZIP_ENTRY_BYTES,
  entries = listZipEntries(bytes),
): Buffer | null {
  const entry = entries.find((candidate) => candidate.name === name);
  return entry ? read(bytes, entry, maxOutputBytes) : null;
}

function read(bytes: Buffer, entry: ZipEntry, maxOutputBytes: number): Buffer {
  const { localOffset, method, compressed, uncompressed } = entry;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new NotAZip('limite di decompressione non valido');
  }
  if (uncompressed > maxOutputBytes) {
    throw new NotAZip(
      `voce ${entry.name} oltre il limite decompresso (${uncompressed} > ${maxOutputBytes} byte)`,
    );
  }
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new NotAZip('intestazione locale ZIP illeggibile');
  }
  // The local header repeats the name and extra fields, and its *lengths* may
  // differ from the central directory's — a writer is allowed to put different
  // extra fields in the two places, so the payload offset has to come from here
  // even though the sizes come from there.
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const from = localOffset + 30 + nameLength + extraLength;
  const payload = bytes.subarray(from, from + compressed);
  if (payload.length < compressed) throw new NotAZip('archivio ZIP troncato');

  if (method === STORED) {
    if (compressed !== uncompressed) throw new NotAZip(`dimensioni incoerenti per ${entry.name}`);
    return payload;
  }
  if (method !== DEFLATED) throw new NotAZip(`compressione ZIP ${method}, non supportata`);
  try {
    // Node's convenience methods support a hard maxOutputLength. The central
    // directory is checked first for a cheap refusal; this is the independent
    // bound that still holds when that attacker-controlled size lies.
    const output = inflateRawSync(payload, { maxOutputLength: maxOutputBytes });
    if (output.length !== uncompressed) {
      throw new NotAZip(
        `dimensione decompressa incoerente per ${entry.name}: ${output.length} invece di ${uncompressed}`,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof NotAZip) throw error;
    throw new NotAZip(`decompressione fallita: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The end-of-central-directory record, found by scanning backwards.
 *
 * It has to be a scan and not a fixed offset because the record ends with a
 * free-form comment of up to 65,535 bytes. Bounded to that plus the record's
 * own 22 bytes: without the bound a large non-ZIP file would be walked end to
 * end before being refused.
 */
function findEndOfCentralDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (
      bytes.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY &&
      at + 22 + bytes.readUInt16LE(at + 20) === bytes.length
    ) return at;
  }
  throw new NotAZip('non è un archivio ZIP: manca la fine della directory centrale');
}
