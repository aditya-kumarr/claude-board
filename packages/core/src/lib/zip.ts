import { inflateRawSync } from "node:zlib";
import { badRequest } from "./errors.ts";

/**
 * Just enough of a zip reader to open a WhatsApp export.
 *
 * Hand-written rather than a dependency because what is needed is small and fixed:
 * list the central directory, then inflate the one text file and whichever photos
 * the new messages point at. Core has no runtime dependencies, and a library that
 * also writes, streams and encrypts would be the biggest thing in it for the
 * sake of two functions.
 *
 * Deliberately unsupported, each with an error that says so rather than garbage:
 * ZIP64 (an export past 4GB or 65k files is not something the upload limit lets
 * through anyway), encryption, and any method other than stored or deflate.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** Last path segment — what a chat line refers to a file by. */
  basename: string;
  size: number;
  compressedSize: number;
  method: number;
  encrypted: boolean;
  /** Offset of the local file header. */
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const data = view(bytes);
  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of up to 64KB, so scan backwards from the end for it.
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 0xffff); index--) {
    if (data.getUint32(index, true) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw badRequest("that file is not a zip archive — export the chat from WhatsApp with “Attach media” or “Without media” and upload the .zip");

  const count = data.getUint16(eocd + 10, true);
  const directoryOffset = data.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw badRequest("this zip uses the ZIP64 format, which is not supported — export a shorter span of the chat");
  }

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder("utf-8");
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || data.getUint32(cursor, true) !== CENTRAL) {
      throw badRequest("the zip's file list is damaged — try exporting the chat again");
    }
    const flags = data.getUint16(cursor + 8, true);
    const method = data.getUint16(cursor + 10, true);
    const compressedSize = data.getUint32(cursor + 20, true);
    const size = data.getUint32(cursor + 24, true);
    const nameLength = data.getUint16(cursor + 28, true);
    const extraLength = data.getUint16(cursor + 30, true);
    const commentLength = data.getUint16(cursor + 32, true);
    const offset = data.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // a directory, not a file
    // macOS "Compress" adds resource forks that look like a second copy of every file.
    if (name.startsWith("__MACOSX/")) continue;
    entries.push({
      name,
      basename: name.split("/").pop() ?? name,
      size,
      compressedSize,
      method,
      encrypted: (flags & 0x1) === 0x1,
      offset,
    });
  }
  return entries;
}

export function extractZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.encrypted) throw badRequest(`${entry.name} is encrypted inside the zip, so it cannot be read`);
  const data = view(bytes);
  if (data.getUint32(entry.offset, true) !== LOCAL) {
    throw badRequest(`${entry.name} is damaged inside the zip — try exporting the chat again`);
  }
  const nameLength = data.getUint16(entry.offset + 26, true);
  const extraLength = data.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(raw));
  throw badRequest(`${entry.name} is compressed with method ${entry.method}, which is not supported`);
}
