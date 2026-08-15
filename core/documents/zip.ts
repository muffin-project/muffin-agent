import { inflateRawSync } from 'node:zlib';

/**
 * One entry out of a ZIP container, and nothing else.
 *
 * A `.docx` is a ZIP holding a handful of XML parts, and the only one that
 * carries the text is `word/document.xml`. That is the whole requirement, which
 * is why this is forty lines of stdlib rather than a dependency: `node:zlib`
 * already does the hard half (DEFLATE), and what is left is walking a central
 * directory whose layout has not changed since 1993 (PKWARE APPNOTE 6.3.10,
 * §4.3.12 and §4.3.16). The alternative measured on 2026-08-15 was `mammoth`,
 * the standard choice, which brings **ten** runtime dependencies — against a
 * repo that runs on thirteen and treats each new one as the risk it is
 * (`docs/PRACTICES.md` §1).
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
export function readZipEntry(bytes: Buffer, name: string): Buffer | null {
  const eocd = findEndOfCentralDirectory(bytes);
  const entries = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  if (cursor === NEEDS_ZIP64) throw new NotAZip('archivio ZIP64, non supportato');

  for (let i = 0; i < entries; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new NotAZip('directory centrale ZIP illeggibile');
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const entryName = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (entryName === name) {
      if (compressed === NEEDS_ZIP64 || uncompressed === NEEDS_ZIP64 || localOffset === NEEDS_ZIP64) {
        throw new NotAZip('voce ZIP64, non supportata');
      }
      return read(bytes, localOffset, method, compressed);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function read(bytes: Buffer, localOffset: number, method: number, compressed: number): Buffer {
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

  if (method === STORED) return payload;
  if (method !== DEFLATED) throw new NotAZip(`compressione ZIP ${method}, non supportata`);
  try {
    return inflateRawSync(payload);
  } catch (error) {
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
    if (bytes.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new NotAZip('non è un archivio ZIP: manca la fine della directory centrale');
}
